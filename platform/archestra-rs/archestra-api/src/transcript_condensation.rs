use axum::{Json, Router, extract::DefaultBodyLimit, routing::post};
use serde::{Deserialize, Serialize};
use serde_json::{Value, value::RawValue};

const MAX_PARTS: usize = 200;
const MAX_TEXT: usize = 4000;
const MAX_INPUT: usize = 2000;
const REDACTED: &str = "[redacted]";

pub(crate) fn router() -> Router {
    Router::new()
        .route(
            "/internal/v1/mcp/tools/condense-schedule-transcript",
            post(condense),
        )
        .layer(DefaultBodyLimit::max(72 * 1024 * 1024))
}

#[derive(Deserialize)]
struct Message {
    role: String,
    parts: Vec<Value>,
}

#[derive(Serialize)]
struct Transcript {
    messages: Vec<CondensedMessage>,
    truncated: bool,
}

#[derive(Serialize)]
struct CondensedMessage {
    role: String,
    parts: Vec<Part>,
}

#[derive(Default, Serialize)]
struct Part {
    #[serde(rename = "type")]
    kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<Box<RawValue>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_call_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    parent_tool_call_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    state: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    input: Option<Box<RawValue>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    output: Option<Box<RawValue>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error_text: Option<Box<RawValue>>,
}

async fn condense(Json(messages): Json<Vec<Message>>) -> Json<Transcript> {
    Json(render(messages))
}

fn render(messages: Vec<Message>) -> Transcript {
    let mut result = Transcript {
        messages: Vec::new(),
        truncated: false,
    };
    let mut remaining = MAX_PARTS;
    for message in messages.into_iter().rev() {
        let mut parts = Vec::new();
        for part in message.parts.into_iter().rev().filter_map(condense_part) {
            if remaining == 0 {
                result.truncated = true;
                break;
            }
            remaining -= 1;
            parts.push(part);
        }
        if !parts.is_empty() {
            parts.reverse();
            result.messages.push(CondensedMessage {
                role: message.role,
                parts,
            });
        }
        if result.truncated {
            break;
        }
    }
    result.messages.reverse();
    result
}

fn condense_part(raw: Value) -> Option<Part> {
    if !raw.is_object() && !raw.is_array() {
        return None;
    }
    let kind = raw["type"].as_str().unwrap_or("unknown");
    let mut part = Part {
        kind: kind.into(),
        ..Part::default()
    };
    let string = |key: &str| raw[key].as_str().map(str::to_owned);
    let coalesce = |primary: &str, fallback: &str| {
        raw.get(primary)
            .filter(|value| !value.is_null())
            .or_else(|| raw.get(fallback))
    };
    match kind {
        "reasoning" | "step-start" => return None,
        "text" => part.text = shorten(js_string(&raw["text"]), MAX_TEXT),
        "blocked-tool" => {
            part.kind = "tool".into();
            part.tool_name = Some(js_string(&raw["toolName"]));
            part.state = Some("blocked".into());
            part.input = raw
                .get("toolArguments")
                .filter(|value| value.is_string())
                .and_then(|value| shorten(redacted_arguments(value), MAX_INPUT));
            part.error_text = shorten(
                js_string(coalesce("fullRefusal", "reason").unwrap_or(&Value::Null)),
                MAX_TEXT,
            );
        }
        "data-subagent-tool-call" if raw["data"].is_object() => {
            let data = &raw["data"];
            part.kind = "tool".into();
            part.tool_name = Some(js_string(&data["toolName"]));
            part.tool_call_id = data["toolCallId"].as_str().map(str::to_owned);
            part.parent_tool_call_id = data["parentToolCallId"].as_str().map(str::to_owned);
            part.state = data["state"].as_str().map(str::to_owned);
            tool_payload(
                &mut part,
                data.get("input"),
                data.get("output"),
                &data["errorText"],
            );
        }
        _ if kind == "dynamic-tool" || kind.starts_with("tool-") => {
            let legacy = matches!(kind, "tool-call" | "tool-result");
            part.kind = "tool".into();
            part.tool_name = Some(if legacy || kind == "dynamic-tool" {
                js_string(&raw["toolName"])
            } else {
                kind[5..].to_owned()
            });
            part.tool_call_id = string("toolCallId");
            part.state = if legacy {
                Some(kind.into())
            } else {
                string("state")
            };
            let (input, output) = if legacy {
                (coalesce("args", "input"), coalesce("result", "output"))
            } else {
                (raw.get("input"), raw.get("output"))
            };
            tool_payload(&mut part, input, output, &raw["errorText"]);
        }
        _ if kind.starts_with("data-") => {
            part.output = raw.get("data").cloned().and_then(|mut value| {
                redact(&mut value, 0);
                shorten(as_json(&value), MAX_TEXT)
            });
        }
        _ => {}
    }
    Some(part)
}

fn tool_payload(part: &mut Part, input: Option<&Value>, output: Option<&Value>, error: &Value) {
    part.input = input.and_then(|value| shorten(redacted_arguments(value), MAX_INPUT));
    part.output = output.and_then(|value| shorten(as_json(value), MAX_TEXT));
    part.error_text = error
        .as_str()
        .and_then(|value| shorten(value.to_owned(), MAX_TEXT));
}

fn redacted_arguments(value: &Value) -> String {
    let mut value = match value {
        Value::String(text) => match serde_json::from_str::<Value>(text) {
            Ok(value) => value,
            // Don't echo JSON that Rust could not examine due to a parser limit.
            Err(error)
                if [
                    "recursion limit exceeded",
                    "number out of range",
                    "lone leading surrogate",
                    "unexpected end of hex escape",
                ]
                .iter()
                .any(|prefix| error.to_string().starts_with(prefix)) =>
            {
                return REDACTED.into();
            }
            Err(_) => return text.clone(),
        },
        value => value.clone(),
    };
    redact(&mut value, 0);
    as_json(&value)
}

fn redact(value: &mut Value, depth: usize) -> bool {
    let Some(object) = value.as_object_mut() else {
        return false;
    };
    let mut changed = depth < 3
        && object
            .get_mut("tool_args")
            .is_some_and(|value| redact(value, depth + 1));
    for (container, field) in [("environment", "value"), ("imagePullSecrets", "password")] {
        if let Some(entries) = object.get_mut(container).and_then(Value::as_array_mut) {
            for entry in entries {
                if container == "environment" && entry["type"].as_str() != Some("secret") {
                    continue;
                }
                if let Some(secret) = entry.get_mut(field) {
                    *secret = Value::String(REDACTED.into());
                    changed = true;
                }
            }
        }
    }
    if let Some(oauth) = object.get_mut("oauthConfig").and_then(Value::as_object_mut)
        && (changed || oauth.contains_key("client_secret"))
    {
        oauth.insert("client_secret".into(), Value::String(REDACTED.into()));
        changed = true;
    }
    changed
}

fn as_json(value: &Value) -> String {
    if let Some(text) = value.as_str() {
        return text.into();
    }
    let mut output = String::new();
    write_json(value, &mut output);
    output
}

fn write_json(value: &Value, output: &mut String) {
    match value {
        Value::Number(number) => {
            let number = number.as_f64().unwrap_or_default();
            output.push_str(ryu_js::Buffer::new().format_finite(number));
        }
        Value::Array(items) => {
            output.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    output.push(',');
                }
                write_json(item, output);
            }
            output.push(']');
        }
        Value::Object(fields) => {
            let mut fields: Vec<_> = fields.iter().collect();
            fields.sort_by_key(|(key, _)| {
                key.parse::<u32>()
                    .ok()
                    .filter(|index| *index < u32::MAX && index.to_string() == **key)
                    .unwrap_or(u32::MAX)
            });
            output.push('{');
            for (index, (key, value)) in fields.into_iter().enumerate() {
                if index > 0 {
                    output.push(',');
                }
                output.push_str(&Value::String(key.clone()).to_string());
                output.push(':');
                write_json(value, output);
            }
            output.push('}');
        }
        _ => output.push_str(&value.to_string()),
    }
}

fn js_string(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::Object(_) => "[object Object]".into(),
        Value::Array(items) => items.iter().map(js_string).collect::<Vec<_>>().join(","),
        _ => as_json(value),
    }
}

fn shorten(mut value: String, limit: usize) -> Option<Box<RawValue>> {
    let mut left = limit;
    for (index, ch) in value.char_indices() {
        if ch.len_utf16() > left {
            value.truncate(index);
            if left == 1 {
                // JS slices UTF-16 code units, even when that splits a pair.
                let high = 0xd800 + ((u32::from(ch) - 0x10000) >> 10);
                let mut encoded = serde_json::to_string(&value).ok()?;
                encoded.pop();
                encoded.push_str(&format!("\\u{high:04x}…\""));
                return RawValue::from_string(encoded).ok();
            }
            value.push('…');
            break;
        }
        left -= ch.len_utf16();
    }
    serde_json::value::to_raw_value(&value).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncation_counts_utf16_units_and_preserves_js_wire_escape() {
        let text = shorten("a💡b".into(), 2).unwrap();
        assert_eq!(text.get(), r#""a\ud83d…""#);
        assert_eq!(shorten("a💡".into(), 3).unwrap().get(), r#""a💡""#);
    }

    #[test]
    fn nested_redaction_keeps_js_property_and_number_format() {
        let input = Value::String(
            r#"{"z":1.0,"tool_args":{"oauthConfig":{"client_secret":"secret"}},"0":1e-7}"#.into(),
        );
        let redacted = redacted_arguments(&input);
        assert_eq!(
            redacted,
            r#"{"0":1e-7,"z":1,"tool_args":{"oauthConfig":{"client_secret":"[redacted]"}}}"#
        );
    }
}
