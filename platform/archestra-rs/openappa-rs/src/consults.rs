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
    let rows: Vec<Row> = records.into_iter().map(Row::from).collect();
    if let Err(error) = insert(pg, attribution, rows) {
        eprintln!("OpenAPPA: {count} external consult records were not stored: {error}");
    }
}

fn insert(
    pg: &PostgresStore,
    attribution: Attribution,
    rows: Vec<Row>,
) -> Result<(), PostgresError> {
    pg.with_client(move |client| {
        let mut transaction = client.transaction().map_err(described)?;
        let statement = transaction.prepare(
            "INSERT INTO openappa_external_consults (id, organization_id, session_id, caller_id, started_at, duration_ms, role, external_name, backend, request, outcome, answer, raw_response, http_status, diagnostics, diagnostics_truncated, root, trajectory, call_id, offer_id, call_digest) \
             VALUES ($1::text::uuid,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)",
        ).map_err(described)?;
        for row in &rows {
            transaction.execute(
                &statement,
                &[
                    &row.id,
                    &attribution.organization_id,
                    &attribution.session_id,
                    &attribution.caller_id,
                    &row.started_at,
                    &row.duration_ms,
                    &row.role,
                    &row.external_name,
                    &row.backend,
                    &row.request,
                    &row.outcome,
                    &row.answer,
                    &row.raw_response,
                    &row.http_status,
                    &row.diagnostics,
                    &row.diagnostics_truncated,
                    &row.root,
                    &row.trajectory,
                    &row.call_id,
                    &row.offer_id,
                    &row.call_digest,
                ],
            ).map_err(described)?;
        }
        transaction.commit().map_err(described)
    })
}

/// The driver's own message is only "db error"; the server's reason is its source.
fn described(error: impl std::error::Error) -> PostgresError {
    match error.source() {
        Some(source) => PostgresError(format!("{error}: {source}")),
        None => PostgresError(error.to_string()),
    }
}

/// One record in the column types the table declares.
struct Row {
    id: String,
    started_at: SystemTime,
    duration_ms: i64,
    role: &'static str,
    external_name: String,
    backend: &'static str,
    request: Value,
    outcome: &'static str,
    answer: Option<Value>,
    raw_response: Option<Vec<u8>>,
    http_status: Option<i32>,
    diagnostics: Option<Vec<u8>>,
    diagnostics_truncated: bool,
    root: String,
    trajectory: String,
    call_id: Option<String>,
    offer_id: Option<String>,
    call_digest: Option<String>,
}

impl From<ConsultRecord> for Row {
    fn from(record: ConsultRecord) -> Self {
        let (diagnostics, diagnostics_truncated) = match record.diagnostics {
            Some(diagnostics) => (Some(diagnostics.bytes), diagnostics.truncated),
            None => (None, false),
        };
        Row {
            id: record.id.to_string(),
            started_at: record.started_at.into(),
            duration_ms: i64::try_from(record.duration_ms).unwrap_or(i64::MAX),
            role: role_name(record.role),
            external_name: record.external_name,
            backend: backend_name(record.backend),
            request: record.request,
            outcome: outcome_name(record.outcome),
            answer: record.answer,
            raw_response: record.raw_response,
            http_status: record.http_status.map(i32::from),
            diagnostics,
            diagnostics_truncated,
            root: record.context.root,
            trajectory: record.context.trajectory,
            call_id: record.context.call_id,
            offer_id: record.context.offer_id,
            call_digest: record.context.call_digest,
        }
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
