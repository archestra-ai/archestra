use crate::SqlError;
use appa_eventlog::ReceiptError;
use appa_runtime::api::RootForkRefusal;
use appa_runtime_api::RefusalClass;
use serde::Serialize;
use serde_json::{Value, json};

/// A failure the host classifies by kind. The loader recovers the JSON body into
/// a JS `Error` whose `code` is the kind's snake_case name; a refusal carries the
/// runtime's own class name.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(untagged)]
pub(crate) enum Failure {
    Refused(RefusalClass),
    Binding(BindingFailure),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum BindingFailure {
    LeaseLost,
    HeldElsewhere,
    UnstartedParent,
    /// Spelled as the runtime's `RefusalClass::PolicyMoved`, so the host reads one
    /// code whichever side reported it.
    PolicyMoved,
    /// The runtime refuses the organization's policy document; an administrator
    /// fixes the document.
    PolicyRefused,
    /// The policy needs a deployment setting this process lacks: an unset
    /// variable or an unconfigured builtin. The operator fixes the deployment.
    RuntimeMisconfigured,
    /// Spelled as the runtime's `RefusalClass::Storage`.
    Storage,
    /// Every pooled PostgreSQL connection stayed busy for the whole checkout wait.
    PoolExhausted,
    /// As many replays as the process admits are running.
    ReplayBusy,
    ReplayTimedOut,
    /// The host sent what the binding cannot read: a host defect, refused the
    /// same way on every retry.
    InvalidInput,
    /// The binding or the runtime panicked; nothing was released.
    Panicked,
    /// Spelled as the runtime's `RefusalClass::EngineInvariant`: the runtime
    /// answered in a shape the binding does not expect.
    EngineInvariant,
}

/// A failure with the text the host logs beside its code.
#[derive(Debug)]
pub(crate) struct Fault {
    pub kind: Failure,
    pub message: String,
}

impl Fault {
    pub(crate) fn new(kind: Failure, message: impl ToString) -> Self {
        Fault {
            kind,
            message: message.to_string(),
        }
    }

    pub(crate) fn binding(kind: BindingFailure, message: impl ToString) -> Self {
        Fault::new(Failure::Binding(kind), message)
    }
}

impl From<Fault> for napi::Error {
    fn from(fault: Fault) -> Self {
        failure(fault.kind, fault.message)
    }
}

pub(crate) fn failure(kind: Failure, message: impl ToString) -> napi::Error {
    napi::Error::from_reason(json!({ "code": kind, "message": message.to_string() }).to_string())
}

pub(crate) fn invalid_input(message: impl ToString) -> napi::Error {
    failure(Failure::Binding(BindingFailure::InvalidInput), message)
}

pub(crate) fn storage(message: impl ToString) -> napi::Error {
    failure(Failure::Binding(BindingFailure::Storage), message)
}

/// A stored log the binding read directly could not be read, under the class a
/// dispatch that read it would be refused with, so the host classifies the cause
/// rather than reporting every read as storage.
pub(crate) fn read_failure(read: appa_eventlog::ReadError) -> napi::Error {
    use appa_eventlog::ReadError;
    let class = match &read {
        ReadError::Undecodable { .. } | ReadError::UndecodableKey { .. } => {
            RefusalClass::UntrustedLog
        }
        ReadError::PolicyFileMissing { .. }
        | ReadError::PolicyFileMismatch { .. }
        | ReadError::UnknownRevision { .. } => RefusalClass::PolicyUnavailable,
        ReadError::LegacyFamily { .. } => RefusalClass::LegacyFamily,
        // The session names a root whose log is gone: as `read_refused`
        // classes it, a trajectory that cannot continue.
        ReadError::UnknownRoot { .. } => RefusalClass::Trajectory,
        _ => return storage(read),
    };
    failure(Failure::Refused(class), read)
}

/// A session's label could not be read, under the class of its cause: the log's
/// own read failure, an opening policy that no longer resolves, or a log that no
/// longer replays.
pub(crate) fn status_read_failure(read: appa_runtime::api::StatusReadError) -> napi::Error {
    use appa_runtime::api::StatusReadError;
    match read {
        StatusReadError::Read(read) => read_failure(read),
        StatusReadError::Policy(_) => {
            failure(Failure::Refused(RefusalClass::PolicyUnavailable), read)
        }
        StatusReadError::Replay(_) => failure(Failure::Refused(RefusalClass::UntrustedLog), read),
        StatusReadError::UnknownRoot { .. } => {
            failure(Failure::Refused(RefusalClass::Trajectory), read)
        }
    }
}

pub(crate) fn panicked(message: impl ToString) -> napi::Error {
    failure(Failure::Binding(BindingFailure::Panicked), message)
}

pub(crate) fn invariant(message: impl ToString) -> napi::Error {
    failure(Failure::Binding(BindingFailure::EngineInvariant), message)
}

/// The message of a request the binding refused as malformed.
#[cfg(test)]
pub(crate) fn rejected_input(error: napi::Error) -> String {
    let body: Value = serde_json::from_str(&error.reason).unwrap();
    assert_eq!(body["code"], json!("invalid_input"), "{body}");
    body["message"].as_str().unwrap().to_owned()
}

pub(crate) fn sql_failure(error: SqlError) -> napi::Error {
    error.into()
}

/// The runtime would not answer a remedy now; nothing was released.
pub(crate) fn remedy_refused(message: impl ToString) -> napi::Error {
    failure(Failure::Refused(RefusalClass::Remedy), message)
}

pub(crate) fn fork_refused(refusal: RootForkRefusal) -> napi::Error {
    failure(Failure::Refused(RefusalClass::Trajectory), refusal)
}

/// The host retries: the dispatch that took the operation over answers it.
pub(crate) fn lease_lost() -> napi::Error {
    failure(
        Failure::Binding(BindingFailure::LeaseLost),
        "OpenAPPA lost its lease on this operation; retry the request",
    )
}

/// Another dispatch holds a live lease on this operation. The host retries: that
/// dispatch answers it, or its lease expires and the retry takes the work over.
pub(crate) fn held_elsewhere() -> napi::Error {
    failure(
        Failure::Binding(BindingFailure::HeldElsewhere),
        "OpenAPPA is processing this operation in another request; retry the request",
    )
}

/// The organization's policy moved past the one this dispatch carries: another
/// process published a newer revision while it was decided, or the policy it read
/// was recomposed before it was published. Nothing was appended; the host's retry
/// reads the policy again and decides at the new head.
pub(crate) fn policy_moved() -> napi::Error {
    failure(
        Failure::Binding(BindingFailure::PolicyMoved),
        "OpenAPPA published a newer policy revision for this organization; retry the request",
    )
}

/// Whether a dispatch failed because its deployment line moved past the revision
/// its view was pinned to: the runtime refuses it as `RefusalClass::PolicyMoved`,
/// which [`failure`] stamps as the code `policy_moved`. A failure without that
/// code is matched on OpenAPPA's `EventError::PolicyMoved` display text, as an
/// unclassed refusal carries it.
pub(crate) fn is_policy_moved(error: &napi::Error) -> bool {
    let envelope = serde_json::from_str::<Value>(&error.reason).ok();
    let field = |name: &str| {
        envelope
            .as_ref()
            .and_then(|envelope| envelope.get(name))
            .and_then(Value::as_str)
    };
    if field("code") == Some("policy_moved") {
        return true;
    }
    let text = field("message").unwrap_or(&error.reason);
    text.contains(" moved to policy revision ")
        && text.contains("while this event was decided; retry it")
}

/// A receipt this dispatch could not claim or complete, as the host sees it. A
/// receipt reused for other input or another caller is the host's defect; one
/// another dispatch settled first is answered by the retry.
pub(crate) fn receipt_failure(reason: ReceiptError) -> napi::Error {
    match reason {
        ReceiptError::LeaseLost => lease_lost(),
        ReceiptError::InputMismatch | ReceiptError::ScopeMismatch => invalid_input(reason),
        ReceiptError::Storage(_) | ReceiptError::NotPending | ReceiptError::CompletionMismatch => {
            storage(reason)
        }
    }
}

#[cfg(test)]
mod failure_tests {
    use super::{
        BindingFailure, Failure, failure, is_policy_moved, lease_lost, policy_moved, read_failure,
        status_read_failure,
    };
    use crate::SqlError;
    use appa_eventlog::postgres::PostgresError;
    use appa_runtime_api::RefusalClass;
    use serde_json::{Value, json};
    use std::time::Duration;

    fn code(error: &napi::Error) -> Value {
        serde_json::from_str::<Value>(&error.reason).unwrap()["code"].clone()
    }

    /// The runtime's class and the binding's own failure share one code, and an
    /// unclassed refusal is still recognized by its text.
    #[test]
    fn a_moved_policy_is_recognized_by_its_code_or_its_text() {
        for kind in [
            Failure::Refused(RefusalClass::PolicyMoved),
            Failure::Binding(BindingFailure::PolicyMoved),
        ] {
            assert_eq!(serde_json::to_value(kind).unwrap(), json!("policy_moved"));
        }
        assert!(is_policy_moved(&policy_moved()));
        assert!(is_policy_moved(&failure(
            Failure::Refused(RefusalClass::PolicyMoved),
            "OpenAPPA processing interrupted: any wording"
        )));
        assert!(is_policy_moved(&napi::Error::from_reason(
            "OpenAPPA processing interrupted: deployment org-a moved to policy revision 3 while this event was decided; retry it"
        )));
        assert!(!is_policy_moved(&lease_lost()));
        assert!(!is_policy_moved(&failure(
            Failure::Refused(RefusalClass::PolicyUnavailable),
            "OpenAPPA processing interrupted: the policy is unavailable"
        )));
    }

    /// A family opened under the earlier policy model reaches the host under its
    /// own code, and no retry loop mistakes it for a moved policy.
    #[test]
    fn a_legacy_family_is_its_own_code_and_never_a_moved_policy() {
        let kind = Failure::Refused(RefusalClass::LegacyFamily);
        assert_eq!(serde_json::to_value(kind).unwrap(), json!("legacy_family"));
        assert!(!is_policy_moved(&failure(
            kind,
            "this trajectory family was opened before live policy revisions; open a new one"
        )));
    }

    /// A binding failure that names a runtime fault is spelled as the runtime's class.
    #[test]
    fn a_shared_fault_has_one_spelling() {
        for (binding, runtime) in [
            (BindingFailure::Storage, RefusalClass::Storage),
            (
                BindingFailure::EngineInvariant,
                RefusalClass::EngineInvariant,
            ),
        ] {
            assert_eq!(
                serde_json::to_value(Failure::Binding(binding)).unwrap(),
                serde_json::to_value(Failure::Refused(runtime)).unwrap(),
            );
        }
    }

    /// A log the binding reads directly reports the class a dispatch reading it
    /// would be refused with; only a failed read is storage.
    #[test]
    fn a_direct_log_read_reports_its_class() {
        use appa_eventlog::ReadError;
        for (read, expected) in [
            (
                ReadError::Undecodable {
                    seq: 7,
                    detail: "expected value".into(),
                },
                "untrusted_log",
            ),
            (
                ReadError::PolicyFileMissing { key: "0a1b".into() },
                "policy_unavailable",
            ),
            (
                ReadError::LegacyFamily {
                    root: "root".into(),
                },
                "legacy_family",
            ),
            (
                ReadError::UnknownRoot {
                    root: "gone".into(),
                },
                "trajectory",
            ),
            (
                ReadError::Postgres(PostgresError("PostgreSQL ERROR (SQLSTATE 08006)".into())),
                "storage",
            ),
        ] {
            assert_eq!(code(&read_failure(read)), json!(expected));
        }
        use appa_runtime::api::StatusReadError;
        for (read, expected) in [
            (
                StatusReadError::Policy("missing".into()),
                "policy_unavailable",
            ),
            (StatusReadError::Replay("diverged".into()), "untrusted_log"),
            (
                StatusReadError::UnknownRoot {
                    root: "gone".into(),
                },
                "trajectory",
            ),
            (
                StatusReadError::Read(ReadError::Postgres(PostgresError(
                    "PostgreSQL ERROR (SQLSTATE 57P01)".into(),
                ))),
                "storage",
            ),
        ] {
            assert_eq!(code(&status_read_failure(read)), json!(expected));
        }
    }

    #[test]
    fn an_exhausted_pool_is_told_apart_from_a_failed_query() {
        let exhausted = napi::Error::from(SqlError::Exhausted(Duration::from_secs(30)));
        assert_eq!(code(&exhausted), json!("pool_exhausted"));
        let failed = napi::Error::from(SqlError::Postgres(PostgresError("db error".into())));
        assert_eq!(code(&failed), json!("storage"));
    }
}
