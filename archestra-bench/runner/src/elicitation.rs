//! Elicitation concern: turn a backend `data-mcp-elicitation` chat event into an auto-answer the
//! headless benchmark can POST back, so a tool that elicits mid-call unblocks instead of stalling
//! until the backend's 10-minute elicitation timeout.
//!
//! The backend writes `{ type: "data-mcp-elicitation", data: { id, conversationId, mode,
//! requestedSchema, ... } }` and then polls a cache for a `POST /api/chat/elicitation/:id`
//! (`platform/backend/src/clients/chat-mcp-elicitation.ts`). The answer content is validated only
//! against the primitive union `string | number | boolean | string[]`, not the original
//! `requestedSchema`, so this module coerces every value into that union.

use std::collections::HashMap;

use serde_json::{Map, Value as JsonValue};

const ELICITATION_EVENT_TYPE: &str = "data-mcp-elicitation";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ElicitationMode {
    Form,
    Url,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ElicitationRequest {
    pub id: String,
    pub conversation_id: String,
    pub mode: ElicitationMode,
    pub requested_schema: Option<JsonValue>,
}

/// A response ready to POST to `/api/chat/elicitation/:id`. `action` is a wire literal ("accept" /
/// "decline"); `content` is present only for an accepted form.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ElicitationAnswer {
    pub action: &'static str,
    pub content: Option<Map<String, JsonValue>>,
}

/// Parse a chat SSE event into an elicitation request, or `None` when it is not one. Fields live
/// under the nested `data` object, matching the backend writer and frontend reader.
pub fn parse_elicitation_request(event: &HashMap<String, JsonValue>) -> Option<ElicitationRequest> {
    if event.get("type").and_then(|v| v.as_str()) != Some(ELICITATION_EVENT_TYPE) {
        return None;
    }
    let data = event.get("data").and_then(|v| v.as_object())?;
    let id = data.get("id").and_then(|v| v.as_str())?.to_string();
    let conversation_id = data
        .get("conversationId")
        .and_then(|v| v.as_str())?
        .to_string();
    let mode = match data.get("mode").and_then(|v| v.as_str()) {
        // The backend defaults an absent mode to "form" (chat-mcp-elicitation.ts), so mirror that.
        Some("url") => ElicitationMode::Url,
        _ => ElicitationMode::Form,
    };
    Some(ElicitationRequest {
        id,
        conversation_id,
        mode,
        requested_schema: data.get("requestedSchema").cloned(),
    })
}

/// The auto-answer: accept a form with recommended defaults; decline a URL flow (it cannot be
/// completed headlessly, and declining unblocks the tool).
pub fn answer_for(req: &ElicitationRequest) -> ElicitationAnswer {
    match req.mode {
        ElicitationMode::Form => ElicitationAnswer {
            action: "accept",
            content: Some(default_content_from_schema(req.requested_schema.as_ref())),
        },
        ElicitationMode::Url => ElicitationAnswer {
            action: "decline",
            content: None,
        },
    }
}

/// Build form content from a requested schema, recommended default first: the property's declared
/// `default`, else its first `enum` value, else a typed zero-value. Every value is coerced into the
/// backend-allowed union; a property that cannot yield an allowed value is omitted.
pub fn default_content_from_schema(schema: Option<&JsonValue>) -> Map<String, JsonValue> {
    let mut content = Map::new();
    let Some(properties) = schema
        .and_then(|s| s.get("properties"))
        .and_then(|p| p.as_object())
    else {
        return content;
    };
    for (key, prop) in properties {
        if let Some(value) = default_for_property(prop) {
            content.insert(key.clone(), value);
        }
    }
    content
}

fn default_for_property(prop: &JsonValue) -> Option<JsonValue> {
    if let Some(value) = prop.get("default").and_then(coerce_allowed) {
        return Some(value);
    }
    if let Some(value) = prop
        .get("enum")
        .and_then(|v| v.as_array())
        .and_then(|values| values.iter().find_map(coerce_allowed))
    {
        return Some(value);
    }
    match prop.get("type").and_then(|v| v.as_str()) {
        Some("string") => Some(JsonValue::String(String::new())),
        Some("number") | Some("integer") => Some(JsonValue::from(0)),
        Some("boolean") => Some(JsonValue::Bool(false)),
        Some("array") => Some(JsonValue::Array(Vec::new())),
        _ => None,
    }
}

/// Keep a value only if it fits the backend's `string | number | boolean | string[]` union.
fn coerce_allowed(value: &JsonValue) -> Option<JsonValue> {
    match value {
        JsonValue::String(_) | JsonValue::Number(_) | JsonValue::Bool(_) => Some(value.clone()),
        JsonValue::Array(items) if items.iter().all(JsonValue::is_string) => Some(value.clone()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn event_from(value: JsonValue) -> HashMap<String, JsonValue> {
        value
            .as_object()
            .expect("object")
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect()
    }

    #[test]
    fn parses_fields_from_nested_data() {
        // The exact wire shape a benchmark run receives.
        let event = event_from(json!({
            "type": "data-mcp-elicitation",
            "data": {
                "id": "elicit-1",
                "conversationId": "conv-1",
                "toolName": "refine_app",
                "mode": "form",
                "requestedSchema": { "type": "object", "properties": {} }
            }
        }));
        let req = parse_elicitation_request(&event).expect("parsed");
        assert_eq!(req.id, "elicit-1");
        assert_eq!(req.conversation_id, "conv-1");
        assert_eq!(req.mode, ElicitationMode::Form);
        assert!(req.requested_schema.is_some());
    }

    #[test]
    fn absent_mode_defaults_to_form() {
        let event = event_from(json!({
            "type": "data-mcp-elicitation",
            "data": { "id": "a", "conversationId": "b" }
        }));
        assert_eq!(
            parse_elicitation_request(&event).unwrap().mode,
            ElicitationMode::Form
        );
    }

    #[test]
    fn non_elicitation_event_is_none() {
        let event = event_from(json!({ "type": "text-delta", "delta": "hi" }));
        assert!(parse_elicitation_request(&event).is_none());
    }

    #[test]
    fn missing_ids_is_none() {
        let event = event_from(json!({
            "type": "data-mcp-elicitation",
            "data": { "conversationId": "b" }
        }));
        assert!(parse_elicitation_request(&event).is_none());
    }

    #[test]
    fn recommended_default_wins_over_enum_and_type() {
        let schema = json!({
            "type": "object",
            "properties": {
                "level": { "type": "string", "enum": ["read", "admin"], "default": "read" }
            }
        });
        let content = default_content_from_schema(Some(&schema));
        assert_eq!(content.get("level"), Some(&json!("read")));
    }

    #[test]
    fn enum_used_when_no_default() {
        let schema = json!({
            "type": "object",
            "properties": { "level": { "type": "string", "enum": ["read", "admin"] } }
        });
        let content = default_content_from_schema(Some(&schema));
        assert_eq!(content.get("level"), Some(&json!("read")));
    }

    #[test]
    fn typed_zero_values_when_no_default_or_enum() {
        let schema = json!({
            "type": "object",
            "properties": {
                "name": { "type": "string" },
                "count": { "type": "integer" },
                "ratio": { "type": "number" },
                "flag": { "type": "boolean" },
                "tags": { "type": "array" }
            }
        });
        let content = default_content_from_schema(Some(&schema));
        assert_eq!(content.get("name"), Some(&json!("")));
        assert_eq!(content.get("count"), Some(&json!(0)));
        assert_eq!(content.get("ratio"), Some(&json!(0)));
        assert_eq!(content.get("flag"), Some(&json!(false)));
        assert_eq!(content.get("tags"), Some(&json!([])));
    }

    #[test]
    fn disallowed_default_falls_through_to_typed_zero() {
        // An object-valued default cannot cross the backend's primitive union, so it is dropped and
        // the typed zero-value is used instead.
        let schema = json!({
            "type": "object",
            "properties": { "opts": { "type": "string", "default": { "nested": true } } }
        });
        let content = default_content_from_schema(Some(&schema));
        assert_eq!(content.get("opts"), Some(&json!("")));
    }

    #[test]
    fn untyped_property_without_default_is_omitted() {
        let schema = json!({ "type": "object", "properties": { "mystery": {} } });
        assert!(default_content_from_schema(Some(&schema)).is_empty());
    }

    #[test]
    fn absent_schema_yields_empty_content() {
        assert!(default_content_from_schema(None).is_empty());
    }

    #[test]
    fn form_answer_accepts_with_defaults() {
        let req = ElicitationRequest {
            id: "a".into(),
            conversation_id: "b".into(),
            mode: ElicitationMode::Form,
            requested_schema: Some(json!({
                "type": "object",
                "properties": { "name": { "type": "string" } }
            })),
        };
        let answer = answer_for(&req);
        assert_eq!(answer.action, "accept");
        assert_eq!(answer.content.unwrap().get("name"), Some(&json!("")));
    }

    #[test]
    fn url_answer_declines() {
        let req = ElicitationRequest {
            id: "a".into(),
            conversation_id: "b".into(),
            mode: ElicitationMode::Url,
            requested_schema: None,
        };
        let answer = answer_for(&req);
        assert_eq!(answer.action, "decline");
        assert!(answer.content.is_none());
    }
}
