//! Completed operation receipts that the host lookup SQL cannot read inside.
//!
//! PostgreSQL `text` and `jsonb` refuse U+0000, so the store keeps a plaintext
//! receipt that holds it under the plaintext escape. JSONB paths read nothing
//! from an escaped receipt, as from an encrypted one. The host lookups leave
//! these receipts out of their SQL and read them here, whole and decoded.
use appa_eventlog::{encryption::StorageCipher, postgres::PostgresError};
use postgres::types::ToSql;
use serde_json::Value;
use std::time::SystemTime;

/// Matches a receipt whose input or decision can be sealed. Plaintext that only
/// carries this key matches too; decoding returns it unchanged.
pub(crate) const SEALED: &str =
    "(o.input ? '__appa_encrypted' OR COALESCE(o.decision ? '__appa_encrypted', false))";

pub(crate) struct OpenedReceipt {
    pub session_id: String,
    pub operation_id: String,
    pub created_at: SystemTime,
    pub input: Value,
    pub decision: Value,
}

impl OpenedReceipt {
    /// What `COALESCE(o.input->'semantic'->>key, o.input->>key)` reads.
    pub fn input_text(&self, key: &str) -> Option<String> {
        json_text(
            self.input
                .get("semantic")
                .and_then(|semantic| semantic.get(key)),
        )
        .or_else(|| json_text(self.input.get(key)))
    }

    /// What `o.decision->>key` reads.
    pub fn decision_text(&self, key: &str) -> Option<String> {
        json_text(self.decision.get(key))
    }
}

/// The completed receipts in `scope` that [`SEALED`] matches, newest first.
/// `scope` is SQL conditions over `o` (`openappa_operations`), bound to
/// `params`. A plaintext view cannot open an encrypted receipt; it is left out,
/// as the lookup SQL leaves it out.
pub(crate) fn read(
    client: &mut postgres::Client,
    scope: &str,
    params: &[&(dyn ToSql + Sync)],
) -> Result<Vec<OpenedReceipt>, PostgresError> {
    let rows = client.query(
        &format!(
            "SELECT o.session_id, o.operation_id, o.created_at, o.input, o.decision \
             FROM openappa_operations o \
             WHERE o.status='complete' AND {SEALED} AND {scope} \
             ORDER BY o.created_at DESC LIMIT 10001"
        ),
        params,
    )?;
    Ok(rows
        .iter()
        .filter_map(|row| {
            let input = StorageCipher::Plain.open_json("", row.get(3)).ok()?;
            let decision = StorageCipher::Plain
                .open_json("", row.get::<_, Option<Value>>(4)?)
                .ok()?;
            Some(OpenedReceipt {
                session_id: row.get(0),
                operation_id: row.get(1),
                created_at: row.get(2),
                input,
                decision,
            })
        })
        .collect())
}

/// What SQL's `->>` reads: a string's content, other JSON as its text, and
/// nothing for JSON null.
fn json_text(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::Null => None,
        Value::String(text) => Some(text.clone()),
        other => Some(other.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn receipt(input: Value, decision: Value) -> OpenedReceipt {
        OpenedReceipt {
            session_id: "session".into(),
            operation_id: "operation".into(),
            created_at: SystemTime::UNIX_EPOCH,
            input,
            decision,
        }
    }

    #[test]
    fn fields_read_as_the_lookup_sql_reads_them() {
        let semantic = receipt(
            json!({"semantic": {"event": "child_end", "output": "a\0b", "spawn_call_id": null}, "event": "outer"}),
            json!({"decision": "ack", "value": {"n": 1}}),
        );
        assert_eq!(semantic.input_text("event").as_deref(), Some("child_end"));
        assert_eq!(semantic.input_text("output").as_deref(), Some("a\0b"));
        assert_eq!(semantic.input_text("spawn_call_id"), None);
        assert_eq!(semantic.decision_text("decision").as_deref(), Some("ack"));
        assert_eq!(
            semantic.decision_text("value").as_deref(),
            Some(r#"{"n":1}"#)
        );
        assert_eq!(semantic.decision_text("missing"), None);

        // A receipt from before the input envelope keeps its fields at the top.
        let legacy = receipt(json!({"event": "child_address", "output": "x"}), json!({}));
        assert_eq!(legacy.input_text("event").as_deref(), Some("child_address"));
        assert_eq!(legacy.input_text("output").as_deref(), Some("x"));
    }
}
