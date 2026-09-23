//! Every external consult a dispatch makes, kept as a row of
//! `openappa_external_consults`: a dataset, never an input to a decision.
use appa_eventlog::postgres::{PostgresError, PostgresStore};
use appa_runtime::api::{
    ConsultBackend, ConsultRecord, ConsultRecorder, ExternalOutcome, ExternalRole, NoAnswerClass,
};
use serde_json::Value;
use std::{
    sync::{Mutex, PoisonError},
    time::SystemTime,
};

/// Records beyond this many in one dispatch are dropped.
const BUFFER_CAP: usize = 256;

/// Holds one dispatch's records until the dispatch returns: the runtime hands
/// them over on the consult's own task, where no SQL may run.
#[derive(Default)]
pub(crate) struct ConsultBuffer {
    buffered: Mutex<Buffered>,
}

#[derive(Default)]
struct Buffered {
    records: Vec<ConsultRecord>,
    dropped: usize,
}

impl ConsultRecorder for ConsultBuffer {
    fn record(&self, record: ConsultRecord) {
        let mut buffered = self.buffered.lock().unwrap_or_else(PoisonError::into_inner);
        if buffered.records.len() < BUFFER_CAP {
            buffered.records.push(record);
        } else {
            buffered.dropped += 1;
        }
    }
}

impl ConsultBuffer {
    fn take(&self) -> Buffered {
        std::mem::take(&mut *self.buffered.lock().unwrap_or_else(PoisonError::into_inner))
    }
}

/// Who a dispatch's consults are filed under.
pub(crate) struct Attribution {
    pub organization_id: String,
    pub session_id: String,
    pub caller_id: Option<String>,
}

/// Stores what `buffer` holds on the dispatch's leased connection. A failure is
/// reported and swallowed: the dataset never changes what the dispatch returns.
pub(crate) fn store(pg: &PostgresStore, attribution: Attribution, buffer: &ConsultBuffer) {
    let Buffered { records, dropped } = buffer.take();
    if dropped > 0 {
        eprintln!(
            "OpenAPPA: one dispatch made more than {BUFFER_CAP} external consults; {dropped} were not recorded"
        );
    }
    if records.is_empty() {
        return;
    }
    let count = records.len();
    if let Err(error) = insert(pg, attribution, records.into_iter().collect()) {
        eprintln!("OpenAPPA: {count} external consult records were not stored: {error}");
    }
}

fn insert(
    pg: &PostgresStore,
    attribution: Attribution,
    columns: Columns,
) -> Result<(), PostgresError> {
    pg.with_client(move |client| {
        client
            .execute(
                "INSERT INTO openappa_external_consults (id, organization_id, session_id, caller_id, started_at, duration_ms, role, external_name, backend, request, outcome, answer, raw_response, http_status, diagnostics, diagnostics_truncated, root, trajectory, call_id, offer_id, call_digest) \
                 SELECT c.id::uuid, $2::text, $3::text, $4::text, c.started_at, c.duration_ms, c.role, c.external_name, c.backend, c.request, c.outcome, c.answer, c.raw_response, c.http_status, c.diagnostics, c.diagnostics_truncated, c.root, c.trajectory, c.call_id, c.offer_id, c.call_digest \
                 FROM UNNEST($1::text[], $5::timestamptz[], $6::int8[], $7::text[], $8::text[], $9::text[], $10::jsonb[], $11::text[], $12::jsonb[], $13::bytea[], $14::int4[], $15::bytea[], $16::bool[], $17::text[], $18::text[], $19::text[], $20::text[], $21::text[]) \
                 AS c(id, started_at, duration_ms, role, external_name, backend, request, outcome, answer, raw_response, http_status, diagnostics, diagnostics_truncated, root, trajectory, call_id, offer_id, call_digest)",
                &[
                    &columns.id,
                    &attribution.organization_id,
                    &attribution.session_id,
                    &attribution.caller_id,
                    &columns.started_at,
                    &columns.duration_ms,
                    &columns.role,
                    &columns.external_name,
                    &columns.backend,
                    &columns.request,
                    &columns.outcome,
                    &columns.answer,
                    &columns.raw_response,
                    &columns.http_status,
                    &columns.diagnostics,
                    &columns.diagnostics_truncated,
                    &columns.root,
                    &columns.trajectory,
                    &columns.call_id,
                    &columns.offer_id,
                    &columns.call_digest,
                ],
            )
            .map(drop)
            .map_err(described)
    })
}

/// The driver's own message is only "db error"; the server's reason is its source.
fn described(error: impl std::error::Error) -> PostgresError {
    match error.source() {
        Some(source) => PostgresError(format!("{error}: {source}")),
        None => PostgresError(error.to_string()),
    }
}

/// The records in the column types the table declares, one array per column:
/// one statement stores a whole dispatch.
#[derive(Default)]
struct Columns {
    id: Vec<String>,
    started_at: Vec<SystemTime>,
    duration_ms: Vec<i64>,
    role: Vec<&'static str>,
    external_name: Vec<String>,
    backend: Vec<&'static str>,
    request: Vec<Value>,
    outcome: Vec<&'static str>,
    answer: Vec<Option<Value>>,
    raw_response: Vec<Option<Vec<u8>>>,
    http_status: Vec<Option<i32>>,
    diagnostics: Vec<Option<Vec<u8>>>,
    diagnostics_truncated: Vec<bool>,
    root: Vec<String>,
    trajectory: Vec<String>,
    call_id: Vec<Option<String>>,
    offer_id: Vec<Option<String>>,
    call_digest: Vec<Option<String>>,
}

impl FromIterator<ConsultRecord> for Columns {
    fn from_iter<I: IntoIterator<Item = ConsultRecord>>(records: I) -> Self {
        let mut columns = Columns::default();
        for record in records {
            let (diagnostics, diagnostics_truncated) = match record.diagnostics {
                Some(diagnostics) => (Some(diagnostics.bytes), diagnostics.truncated),
                None => (None, false),
            };
            columns.id.push(record.id.to_string());
            columns.started_at.push(record.started_at.into());
            columns
                .duration_ms
                .push(i64::try_from(record.duration_ms).unwrap_or(i64::MAX));
            columns.role.push(role_name(record.role));
            columns.external_name.push(record.external_name);
            columns.backend.push(backend_name(record.backend));
            columns.request.push(record.request);
            columns.outcome.push(outcome_name(record.outcome));
            columns.answer.push(record.answer);
            columns.raw_response.push(record.raw_response);
            columns.http_status.push(record.http_status.map(i32::from));
            columns.diagnostics.push(diagnostics);
            columns.diagnostics_truncated.push(diagnostics_truncated);
            columns.root.push(record.context.root);
            columns.trajectory.push(record.context.trajectory);
            columns.call_id.push(record.context.call_id);
            columns.offer_id.push(record.context.offer_id);
            columns.call_digest.push(record.context.call_digest);
        }
        columns
    }
}

// The stored names are the runtime's own serde names. The backend's zod enums
// list the same strings.
fn role_name(role: ExternalRole) -> &'static str {
    match role {
        ExternalRole::Authority => "authority",
        ExternalRole::Sanitizer => "sanitizer",
        ExternalRole::Annotator => "annotator",
        ExternalRole::AudienceSource => "audience_source",
        ExternalRole::Input => "input",
    }
}

fn backend_name(backend: ConsultBackend) -> &'static str {
    match backend {
        ConsultBackend::Url => "url",
        ConsultBackend::Command => "command",
        ConsultBackend::Module => "module",
        ConsultBackend::Llm => "llm",
        ConsultBackend::ClaudeCode => "claude_code",
        ConsultBackend::Hitl => "hitl",
    }
}

/// A no-answer is stored as its class alone; a url external's status is in
/// `http_status`.
fn outcome_name(outcome: ExternalOutcome) -> &'static str {
    match outcome {
        ExternalOutcome::Answered => "answered",
        ExternalOutcome::NoAnswer(class) => match class {
            NoAnswerClass::Unregistered => "unregistered",
            NoAnswerClass::Unreachable => "unreachable",
            NoAnswerClass::Dismissed => "dismissed",
            NoAnswerClass::NonSuccess { .. } => "non_success",
            NoAnswerClass::Timeout => "timeout",
            NoAnswerClass::Transport => "transport",
            NoAnswerClass::Malformed => "malformed",
            NoAnswerClass::Oversized => "oversized",
            NoAnswerClass::UnsupportedVersion => "unsupported_version",
            NoAnswerClass::ModuleError => "module_error",
            NoAnswerClass::ModulePanicked => "module_panicked",
        },
    }
}

#[cfg(test)]
mod tests {
    use super::{BUFFER_CAP, ConsultBuffer, backend_name, outcome_name, role_name};
    use appa_runtime::api::{
        ConsultBackend, ConsultContext, ConsultRecord, ConsultRecorder, ExternalOutcome,
        ExternalRole, NoAnswerClass,
    };
    use serde_json::{Value, json};

    fn record() -> ConsultRecord {
        ConsultRecord {
            id: uuid::Uuid::now_v7(),
            started_at: chrono::Utc::now(),
            duration_ms: 1,
            role: ExternalRole::Annotator,
            external_name: "scan".into(),
            backend: ConsultBackend::Url,
            request: json!({}),
            outcome: ExternalOutcome::Answered,
            answer: Some(json!({})),
            raw_response: None,
            http_status: Some(200),
            diagnostics: None,
            context: ConsultContext {
                root: "root".into(),
                trajectory: "root".into(),
                call_id: None,
                offer_id: None,
                call_digest: None,
            },
        }
    }

    #[test]
    fn a_dispatch_keeps_its_first_records_up_to_the_cap_and_counts_the_rest() {
        let buffer = ConsultBuffer::default();
        let first = record();
        buffer.record(first.clone());
        for _ in 1..BUFFER_CAP + 3 {
            buffer.record(record());
        }
        let taken = buffer.take();
        assert_eq!(taken.records.len(), BUFFER_CAP);
        assert_eq!(taken.records[0], first);
        assert_eq!(taken.dropped, 3);
        assert!(
            buffer.take().records.is_empty(),
            "taking empties the buffer"
        );
    }

    #[test]
    fn stored_role_and_backend_names_are_the_runtime_serde_names() {
        for role in [
            ExternalRole::Authority,
            ExternalRole::Sanitizer,
            ExternalRole::Annotator,
            ExternalRole::AudienceSource,
            ExternalRole::Input,
        ] {
            assert_eq!(serde_json::to_value(role).unwrap(), json!(role_name(role)));
        }
        for backend in [
            ConsultBackend::Url,
            ConsultBackend::Command,
            ConsultBackend::Module,
            ConsultBackend::Llm,
            ConsultBackend::ClaudeCode,
            ConsultBackend::Hitl,
        ] {
            assert_eq!(
                serde_json::to_value(backend).unwrap(),
                json!(backend_name(backend))
            );
        }
    }

    #[test]
    fn a_stored_outcome_is_the_serde_name_of_its_class() {
        assert_eq!(
            serde_json::to_value(ExternalOutcome::Answered).unwrap(),
            json!(outcome_name(ExternalOutcome::Answered))
        );
        for class in [
            NoAnswerClass::Unregistered,
            NoAnswerClass::Unreachable,
            NoAnswerClass::Dismissed,
            NoAnswerClass::NonSuccess { status: 503 },
            NoAnswerClass::Timeout,
            NoAnswerClass::Transport,
            NoAnswerClass::Malformed,
            NoAnswerClass::Oversized,
            NoAnswerClass::UnsupportedVersion,
            NoAnswerClass::ModuleError,
            NoAnswerClass::ModulePanicked,
        ] {
            let class_name = match serde_json::to_value(class).unwrap() {
                Value::String(name) => name,
                Value::Object(fields) => fields.keys().next().unwrap().clone(),
                other => panic!("unexpected class shape {other}"),
            };
            assert_eq!(outcome_name(ExternalOutcome::NoAnswer(class)), class_name);
        }
    }
}
