//! Completed operation receipts that the host lookup SQL cannot read inside.
//!
//! An encrypted view seals every receipt. A plaintext view stores a receipt
//! that holds U+0000 under the plaintext escape, because PostgreSQL `text` and
//! `jsonb` refuse that character. JSONB paths read nothing from either. The
//! host lookups read such receipts here, whole and decoded, under the same
//! bounds as their SQL.
use appa_eventlog::{
    encryption::{StorageCipher, field_context},
    postgres::PostgresError,
};
use postgres::types::ToSql;
use serde_json::Value;
use std::time::SystemTime;

/// The base64 text every plaintext escape starts with: the storage magic and
/// the plaintext mode byte. An encrypted envelope never starts with it.
const ESCAPE_PREFIX: &str = "AGFwcGEtc3RvcmFnZS12MQAA";

/// Matches a receipt whose input or decision is stored under the plaintext
/// escape. Never NULL, so `NOT` keeps every other receipt.
pub(crate) const ESCAPED: &str = "(COALESCE(starts_with(o.input->>'__appa_encrypted', 'AGFwcGEtc3RvcmFnZS12MQAA'), false) \
     OR COALESCE(starts_with(o.decision->>'__appa_encrypted', 'AGFwcGEtc3RvcmFnZS12MQAA'), false))";

/// Which completed receipts [`read`] returns.
pub(crate) enum Receipts {
    /// Every receipt in scope, for an encrypted view.
    All,
    /// Only the receipts [`ESCAPED`] matches, for a plaintext view.
    Escaped,
}

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

/// The completed receipts in `scope`, newest first, decoded with `cipher`.
/// `scope` is SQL conditions over `o` (`openappa_operations`), bound to
/// `params`. A receipt that does not decode fails the read, and so does a
/// read past the lookup budget.
pub(crate) fn read(
    client: &mut postgres::Client,
    cipher: &StorageCipher,
    receipts: Receipts,
    scope: &str,
    params: &[&(dyn ToSql + Sync)],
) -> Result<Vec<OpenedReceipt>, PostgresError> {
    let escaped = match receipts {
        Receipts::All => String::new(),
        Receipts::Escaped => format!("AND {ESCAPED} "),
    };
    let rows = client.query(
        &format!(
            "SELECT o.organization_id, o.session_id, o.operation_id, o.created_at, o.input, o.decision \
             FROM openappa_operations o \
             WHERE o.status='complete' {escaped}AND {scope} \
             ORDER BY o.created_at DESC LIMIT 10001"
        ),
        params,
    )?;
    let mut budget = crate::ReceiptLookupBudget::default();
    rows.iter()
        .map(|row| {
            let organization_id: String = row.get(0);
            let session_id: String = row.get(1);
            let operation_id: String = row.get(2);
            let field = |name: &str| {
                field_context(&[
                    "openappa_operations",
                    &organization_id,
                    &session_id,
                    &operation_id,
                    name,
                ])
            };
            let input = cipher.open_json(&field("input"), row.get(4))?;
            let decision = cipher.open_json(&field("decision"), row.get(5))?;
            budget.take(input.to_string().len() + decision.to_string().len())?;
            Ok(OpenedReceipt {
                session_id,
                operation_id,
                created_at: row.get(3),
                input,
                decision,
            })
        })
        .collect()
}

/// `value` as stored, with a plaintext escape decoded. Any other value,
/// an encrypted envelope included, is returned unchanged.
pub(crate) fn unescape(value: Value) -> Result<Value, PostgresError> {
    let escaped = value.as_object().is_some_and(|object| {
        object.len() == 1
            && object
                .get("__appa_encrypted")
                .and_then(Value::as_str)
                .is_some_and(|text| text.starts_with(ESCAPE_PREFIX))
    });
    if !escaped {
        return Ok(value);
    }
    Ok(StorageCipher::Plain.open_json("", value)?)
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

    #[test]
    fn only_the_store_s_plaintext_escape_is_escaped() {
        let value = json!({"arguments": {"prompt": "a\0b"}});
        let stored = StorageCipher::Plain.seal_json("input", &value).unwrap();
        let text = stored["__appa_encrypted"].as_str().unwrap();
        assert!(text.starts_with(ESCAPE_PREFIX), "{text}");
        assert!(ESCAPED.contains(&format!("'{ESCAPE_PREFIX}'")));
        assert_eq!(unescape(stored).unwrap(), value);

        let encrypted = StorageCipher::encrypted(&[7; 32], "scope".into())
            .unwrap()
            .seal_json("input", &value)
            .unwrap();
        assert!(
            !encrypted["__appa_encrypted"]
                .as_str()
                .unwrap()
                .starts_with(ESCAPE_PREFIX)
        );
        assert_eq!(unescape(encrypted.clone()).unwrap(), encrypted);
        assert_eq!(
            unescape(json!({"tool": "Bash"})).unwrap(),
            json!({"tool": "Bash"})
        );
    }
}
