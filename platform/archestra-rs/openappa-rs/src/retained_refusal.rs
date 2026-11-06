//! Decode host-scoped retained decisions without executing a remedy.
//! The host checks organization, caller, session and parent ownership before
//! passing these records. Cipher context binds each decision to its journal row.
use appa_eventlog::{
    encryption::{StorageCipher, field_context},
    postgres::PostgresError,
};
use serde::Deserialize;
use serde_json::Value;

#[derive(Deserialize)]
pub(crate) struct Lookup {
    organization_id: String,
    session_id: String,
    offer_id: String,
    records: Vec<Record>,
}

#[derive(Deserialize)]
struct Record {
    operation_id: String,
    decision: Value,
}

pub(crate) fn find(input: Lookup, cipher: &StorageCipher) -> Result<Option<String>, PostgresError> {
    let mut budget = crate::child_returns::ReceiptLookupBudget::default();
    let mut found = None;
    for record in input.records {
        let decision = cipher.open_json(
            &field_context(&[
                "openappa_operations",
                &input.organization_id,
                &input.session_id,
                &record.operation_id,
                "decision",
            ]),
            record.decision,
        )?;
        budget.take(decision.to_string().len())?;
        let matches = decision["offers"].as_array().is_some_and(|offers| {
            offers
                .iter()
                .any(|offer| offer["offer_id"].as_str() == Some(&input.offer_id))
        });
        if matches && found.is_none() {
            found = decision["feedback"]
                .as_str()
                .filter(|feedback| !feedback.trim().is_empty())
                .map(str::to_owned);
        }
    }
    Ok(found)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn lookup(decision: Value) -> Lookup {
        serde_json::from_value(json!({
            "organization_id": "org",
            "session_id": "session",
            "offer_id": "offer",
            "records": [{"operation_id": "call:1", "decision": decision}]
        }))
        .unwrap()
    }

    fn decision(feedback: &str) -> Value {
        json!({"decision":"deny_call", "feedback":feedback, "offers":[{"offer_id":"offer"}]})
    }

    fn context() -> String {
        field_context(&[
            "openappa_operations",
            "org",
            "session",
            "call:1",
            "decision",
        ])
    }

    #[test]
    fn preserves_plain_and_escaped_refusals() {
        for feedback in [
            "soft refusal",
            "requires attention: blocked",
            "soft\0refusal",
        ] {
            let stored = StorageCipher::Plain
                .seal_json(&context(), &decision(feedback))
                .unwrap();
            assert_eq!(
                find(lookup(stored), &StorageCipher::Plain).unwrap(),
                Some(feedback.into())
            );
        }
    }

    #[test]
    fn encrypted_refusal_requires_matching_key_and_journal_context() {
        let cipher = StorageCipher::encrypted(&[7; 32], "scope".into()).unwrap();
        let stored = cipher
            .seal_json(&context(), &decision("soft refusal"))
            .unwrap();
        assert_eq!(
            find(lookup(stored.clone()), &cipher).unwrap(),
            Some("soft refusal".into())
        );
        let wrong_key = StorageCipher::encrypted(&[8; 32], "scope".into()).unwrap();
        assert!(find(lookup(stored.clone()), &wrong_key).is_err());
        let mut wrong_session = lookup(stored);
        wrong_session.session_id = "other".into();
        assert!(find(wrong_session, &cipher).is_err());
    }

    #[test]
    fn unknown_offer_has_no_refusal() {
        let mut input = lookup(decision("soft refusal"));
        input.offer_id = "unknown".into();
        assert_eq!(find(input, &StorageCipher::Plain).unwrap(), None);
    }
}
