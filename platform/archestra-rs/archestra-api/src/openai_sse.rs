use std::{collections::HashMap, io};

use axum::{Json, body::Body, http::StatusCode};
use futures_util::{Stream, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use time::OffsetDateTime;

const MAX_EVENT_BYTES: usize = 16 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Terminal {
    id: String,
    model: String,
    stop_reason: Option<String>,
    replaced: bool,
    separate_usage: bool,
    usage: Option<Map<String, Value>>,
}

pub(crate) async fn terminal(Json(terminal): Json<Terminal>) -> Json<String> {
    let created = OffsetDateTime::now_utc().unix_timestamp();
    let finish_reason = if terminal.replaced {
        "stop"
    } else {
        terminal.stop_reason.as_deref().unwrap_or("stop")
    };
    let (inline, trailing) = if terminal.separate_usage {
        (None, terminal.usage)
    } else {
        (terminal.usage, None)
    };
    let chunk = |choices, usage| chat_chunk(&terminal.id, &terminal.model, created, choices, usage);
    let mut events = chunk(
        json!([{"index": 0, "delta": {}, "finish_reason": finish_reason}]),
        inline,
    );
    if let Some(usage) = trailing {
        events.push_str(&chunk(json!([]), Some(usage)));
    }
    events.push_str("data: [DONE]\n\n");
    Json(events)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct PolicyOutput {
    id: String,
    model: String,
    output: PolicyDelta,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum PolicyDelta {
    Text { text: String },
    Tools { calls: Vec<PolicyCall> },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PolicyCall {
    id: String,
    wire_id: Option<String>,
    name: String,
    arguments: String,
}

pub(crate) async fn policy_output(Json(mut request): Json<PolicyOutput>) -> Json<String> {
    let now = OffsetDateTime::now_utc();
    let delta = match request.output {
        PolicyDelta::Text { text } => {
            if request.id.is_empty() {
                request.id = format!("chatcmpl-{}", now.unix_timestamp_nanos() / 1_000_000);
            }
            json!({"role": "assistant", "content": text})
        }
        PolicyDelta::Tools { calls } => {
            let calls: Vec<_> = calls.into_iter().enumerate().map(|(index, call)| {
                json!({"index": index, "id": call.wire_id.unwrap_or(call.id), "type": "function",
                       "function": {"name": call.name, "arguments": call.arguments}})
            }).collect();
            json!({"tool_calls": calls})
        }
    };
    Json(chat_chunk(
        &request.id,
        &request.model,
        now.unix_timestamp(),
        json!([{"index": 0, "delta": delta, "finish_reason": null}]),
        None,
    ))
}

fn chat_chunk(
    id: &str,
    model: &str,
    created: i64,
    choices: Value,
    usage: Option<Map<String, Value>>,
) -> String {
    let mut chunk = json!({
        "id": id, "object": "chat.completion.chunk",
        "created": created, "model": model, "choices": choices,
    });
    if let Some(usage) = usage {
        chunk["usage"] = Value::Object(usage);
    }
    format!("data: {chunk}\n\n")
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ReceiptPrefix {
    id: String,
    model: String,
    prefix: String,
    immediate_sse: Option<String>,
    separate_content: bool,
}

pub(crate) async fn receipt_prefix(
    Json(request): Json<ReceiptPrefix>,
) -> Result<Json<String>, StatusCode> {
    let mut output = chat_chunk(
        &request.id,
        &request.model,
        OffsetDateTime::now_utc().unix_timestamp(),
        json!([{"index": 0, "delta": {"content": request.prefix}, "finish_reason": null}]),
        None,
    );
    if request.separate_content {
        let data = request
            .immediate_sse
            .as_deref()
            .and_then(|sse| sse.strip_prefix("data: "))
            .and_then(|data| data.strip_suffix("\n\n"))
            .ok_or(StatusCode::BAD_REQUEST)?;
        let mut chunk: Value = serde_json::from_str(data).map_err(|_| StatusCode::BAD_REQUEST)?;
        let content = chunk
            .pointer_mut("/choices/0/delta/content")
            .ok_or(StatusCode::BAD_REQUEST)?;
        *content = json!(format!(
            "\n\n{}",
            content.as_str().ok_or(StatusCode::BAD_REQUEST)?
        ));
        output.push_str(&format!("data: {chunk}\n\n"));
    } else if let Some(immediate) = request.immediate_sse {
        output.push_str(&immediate);
    }
    Ok(Json(output))
}

pub(crate) fn decode(response: reqwest::Response) -> Body {
    Body::from_stream(frames(response))
}

fn frames(response: reqwest::Response) -> impl Stream<Item = io::Result<Vec<u8>>> {
    let input = response.bytes_stream();
    async_stream::try_stream! {
        futures_util::pin_mut!(input);
        let mut reader = SseReader::default();
        let mut state = StreamState::default();
        while let Some(bytes) = input.next().await {
            let bytes = bytes.map_err(io::Error::other)?;
            for byte in bytes {
                if state.done {
                    break;
                }
                let Some(data) = reader.push(byte)? else {
                    continue;
                };
                if let Some(frame) = state.frame(&data) {
                    let terminal_usage = matches!(frame, Frame::Chunk { terminal_usage: true, .. });
                    let terminal_error = !matches!(frame, Frame::Chunk { .. });
                    let line = encode(&frame)?;
                    if terminal_usage && !state.tools.calls.is_empty() {
                        yield encode(&Frame::ToolCalls { tool_calls: &state.tools.calls })?;
                    }
                    yield line;
                    if terminal_error {
                        return;
                    }
                }
            }
        }
        if !state.tools.calls.is_empty() {
            yield encode(&Frame::ToolCalls { tool_calls: &state.tools.calls })?;
        }
    }
}

fn encode(frame: &Frame<'_>) -> io::Result<Vec<u8>> {
    let mut line = serde_json::to_vec(frame).map_err(io::Error::other)?;
    line.push(b'\n');
    Ok(line)
}

#[derive(Default)]
struct SseReader {
    line: Vec<u8>,
    data: Vec<u8>,
    skip_lf: bool,
    seen_line: bool,
}

impl SseReader {
    fn push(&mut self, byte: u8) -> io::Result<Option<Vec<u8>>> {
        if std::mem::take(&mut self.skip_lf) && byte == b'\n' {
            return Ok(None);
        }
        if !matches!(byte, b'\r' | b'\n') {
            if self.line.len() + self.data.len() >= MAX_EVENT_BYTES {
                return Err(io::Error::other("OpenAI SSE event too large"));
            }
            self.line.push(byte);
            return Ok(None);
        }
        self.skip_lf = byte == b'\r';
        let line = if std::mem::replace(&mut self.seen_line, true) {
            self.line.as_slice()
        } else {
            self.line
                .strip_prefix(b"\xef\xbb\xbf")
                .unwrap_or(&self.line)
        };
        let data = if line.is_empty() && !self.data.is_empty() {
            self.data.pop(); // Remove the final field separator.
            Some(std::mem::take(&mut self.data))
        } else {
            if let Some(field) = line.strip_prefix(b"data:") {
                self.data
                    .extend_from_slice(field.strip_prefix(b" ").unwrap_or(field));
                self.data.push(b'\n');
            } else if line == b"data" {
                self.data.push(b'\n');
            }
            None
        };
        self.line.clear();
        Ok(data)
    }
}

#[derive(Default)]
struct StreamState {
    done: bool,
    stop_reason: Option<String>,
    tools: ToolCalls,
}

#[derive(Default)]
struct ToolCalls {
    positions: HashMap<i64, usize>,
    calls: Vec<ToolCall>,
    bytes: usize,
}

#[derive(Default, Serialize)]
struct ToolCall {
    id: String,
    name: String,
    arguments: String,
}

impl ToolCalls {
    fn append(&mut self, deltas: &[Value]) -> io::Result<()> {
        for delta in deltas {
            let index = delta
                .get("index")
                .and_then(Value::as_i64)
                .ok_or_else(|| io::Error::other("Invalid OpenAI tool index"))?;
            let position = *self.positions.entry(index).or_insert_with(|| {
                self.calls.push(ToolCall::default());
                self.calls.len() - 1
            });
            let call = &mut self.calls[position];
            let id = string_field(delta.get("id"));
            let name = string_field(delta.pointer("/function/name"));
            let arguments = string_field(delta.pointer("/function/arguments"));
            self.bytes += id.len() + name.len() + arguments.len() + 1;
            if self.bytes > MAX_EVENT_BYTES {
                return Err(io::Error::other("OpenAI tool deltas too large"));
            }
            if !id.is_empty() {
                call.id = id.into();
            }
            if !name.is_empty() {
                call.name = name.into();
            }
            call.arguments.push_str(arguments);
        }
        Ok(())
    }
}

fn string_field(value: Option<&Value>) -> &str {
    value.and_then(Value::as_str).unwrap_or_default()
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum Frame<'a> {
    Chunk {
        chunk: Value,
        immediate_sse: Option<String>,
        held_tool_sse: Option<String>,
        stop_reason: Option<&'a str>,
        terminal_usage: bool,
    },
    ToolCalls {
        tool_calls: &'a [ToolCall],
    },
    ProviderError {
        error: Value,
    },
    InvalidJson,
    InvalidToolDeltas,
}

impl StreamState {
    fn frame(&mut self, data: &[u8]) -> Option<Frame<'_>> {
        if data.starts_with(b"[DONE]") {
            self.done = true;
            return None;
        }
        let Ok(chunk) = serde_json::from_str::<Value>(&String::from_utf8_lossy(data)) else {
            return Some(Frame::InvalidJson);
        };
        if let Some(error) = chunk.get("error").filter(|value| truthy(value)) {
            return Some(Frame::ProviderError {
                error: error.clone(),
            });
        }
        let choice = chunk.pointer("/choices/0").filter(|value| truthy(value));
        if let Some(reason) = choice
            .and_then(|choice| choice.get("finish_reason"))
            .and_then(Value::as_str)
            .filter(|reason| !reason.is_empty())
        {
            self.stop_reason = Some(reason.to_owned());
        }
        let terminal_usage = choice.is_none()
            && self.stop_reason.is_some()
            && chunk.get("usage").is_some_and(truthy);
        // Only the first choice participates in the policy verdict. Refuse
        // executable fragments in other choices instead of passing them through.
        if chunk
            .get("choices")
            .and_then(Value::as_array)
            .is_some_and(|choices| {
                choices
                    .iter()
                    .skip(1)
                    .any(|choice| match choice.pointer("/delta/tool_calls") {
                        Some(Value::Array(calls)) => !calls.is_empty(),
                        Some(value) => truthy(value),
                        None => false,
                    })
            })
        {
            return Some(Frame::InvalidToolDeltas);
        }
        if let Some(deltas) = choice
            .and_then(|choice| choice.pointer("/delta/tool_calls"))
            .filter(|value| truthy(value))
        {
            let Some(deltas) = deltas.as_array() else {
                return Some(Frame::InvalidToolDeltas);
            };
            if self.tools.append(deltas).is_err() {
                return Some(Frame::InvalidToolDeltas);
            }
        }
        let (immediate_sse, held_tool_sse) = split_output(&chunk, choice);
        Some(Frame::Chunk {
            chunk,
            immediate_sse,
            held_tool_sse,
            stop_reason: self.stop_reason.as_deref(),
            terminal_usage,
        })
    }
}

fn split_output(chunk: &Value, choice: Option<&Value>) -> (Option<String>, Option<String>) {
    let Some(choice) = choice else {
        return (None, None);
    };
    let Some(delta) = choice.get("delta") else {
        return (None, None);
    };
    let visible = delta.get("content").is_some_and(truthy)
        || ["reasoning_content", "reasoning"]
            .iter()
            .any(|key| !string_field(delta.get(key)).is_empty())
        || delta
            .get("audio")
            .is_some_and(|value| value.is_object() || value.is_array());
    let tools = delta.get("tool_calls").is_some_and(truthy);
    let role = delta.get("role").filter(|role| truthy(role));
    match (visible || (!tools && role.is_some()), tools) {
        (true, true) => {
            let mut split = chunk.clone();
            if let Some(choices) = split["choices"].as_array_mut() {
                choices.truncate(1);
            }
            let mut tool_delta = Map::new();
            if let Some(role) = role {
                tool_delta.insert("role".into(), role.clone());
            }
            tool_delta.insert("tool_calls".into(), delta["tool_calls"].clone());
            split["choices"][0]["delta"] = Value::Object(tool_delta);
            let held = format!("data: {split}\n\n");

            let mut visible_delta = delta.as_object().cloned().unwrap_or_default();
            visible_delta.remove("tool_calls");
            split["choices"][0]["delta"] = Value::Object(visible_delta);
            split["choices"][0]["finish_reason"] = Value::Null;
            (Some(format!("data: {split}\n\n")), Some(held))
        }
        (true, false) => (Some(format!("data: {chunk}\n\n")), None),
        (false, true) => (None, Some(format!("data: {chunk}\n\n"))),
        (false, false) => (None, None),
    }
}

fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(value) => value.as_f64().is_some_and(|value| value != 0.0),
        Value::String(value) => !value.is_empty(),
        _ => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn tool_only_receipt_does_not_synthesize_an_executable_delta() {
        let Json(events) = receipt_prefix(Json(ReceiptPrefix {
            id: "fixture".into(),
            model: "model".into(),
            prefix: "receipt\nsecond line".into(),
            immediate_sse: None,
            separate_content: false,
        }))
        .await
        .unwrap();
        let lines: Vec<_> = events.lines().filter(|line| !line.is_empty()).collect();
        assert_eq!(lines.len(), 1);
        let frame: Value = serde_json::from_str(lines[0].strip_prefix("data: ").unwrap()).unwrap();
        assert_eq!(
            frame["choices"],
            json!([{"index":0, "delta":{"content":"receipt\nsecond line"}, "finish_reason":null}])
        );
    }

    #[test]
    fn splits_combined_deltas_without_releasing_tools_or_finishing_early() {
        let mut state = StreamState::default();
        let Some(Frame::Chunk {
            immediate_sse: Some(immediate),
            held_tool_sse: Some(held),
            ..
        }) = state.frame(br#"{"id":"one","choices":[{"index":0,"delta":{"role":"assistant","reasoning":"note","audio":{"transcript":"hi"},"tool_calls":[{"index":0,"function":{"arguments":"{}"}}]},"finish_reason":"tool_calls"}]}"#) else {
            panic!("expected separate visible and held frames");
        };
        let parse = |event: &str| {
            serde_json::from_str::<Value>(event.strip_prefix("data: ").unwrap()).unwrap()
        };
        let immediate = parse(&immediate);
        let held = parse(&held);
        assert_eq!(
            immediate["choices"][0]["delta"],
            json!({"role":"assistant","reasoning":"note","audio":{"transcript":"hi"}})
        );
        assert_eq!(immediate["choices"][0]["finish_reason"], Value::Null);
        assert_eq!(
            held["choices"][0]["delta"],
            json!({"role":"assistant","tool_calls":[
                {"index":0,"function":{"arguments":"{}"}}
            ]})
        );
        assert_eq!(held["choices"][0]["finish_reason"], "tool_calls");
    }

    #[test]
    fn rejects_tools_from_choices_the_policy_does_not_review() {
        let mut state = StreamState::default();
        assert!(matches!(state.frame(br#"{"choices":[{"index":0,"delta":{"content":"hi"}},{"index":1,"delta":{"tool_calls":[{"index":0}]}}]}"#),
            Some(Frame::InvalidToolDeltas)));
    }

    #[test]
    fn assembles_interleaved_tool_arguments_in_first_seen_order() {
        let mut state = StreamState::default();
        for chunk in [
            br#"{"choices":[{"delta":{"tool_calls":[{"index":3,"id":"a","function":{"name":"note","arguments":"{\"note\":"}},{"index":0,"id":"b","function":{"name":"other","arguments":"{}"}}]}}]}"#.as_slice(),
            br#"{"choices":[{"delta":{"tool_calls":[{"index":3,"function":{"arguments":"\"caf\u00e9\"}"}}]}}]}"#.as_slice(),
        ] {
            assert!(matches!(state.frame(chunk), Some(Frame::Chunk { .. })));
        }
        let calls = &state.tools.calls;
        assert_eq!(calls.len(), 2);
        assert_eq!(
            (&*calls[0].id, &*calls[0].name, &*calls[0].arguments),
            ("a", "note", r#"{"note":"café"}"#)
        );
        assert_eq!(
            (&*calls[1].id, &*calls[1].name, &*calls[1].arguments),
            ("b", "other", "{}")
        );
    }

    #[test]
    fn reads_multiline_data_and_ignores_comments_across_line_endings() {
        let mut reader = SseReader::default();
        let wire = b"\xef\xbb\xbf: note\r\nid: 1\rdata: {\"text\":\n\
            data: \"H\xc3\xa9llo\"}\r\n\r\ndata: unfinished\n";
        let events: Vec<_> = wire
            .iter()
            .filter_map(|byte| reader.push(*byte).unwrap())
            .collect();
        assert_eq!(events, [b"{\"text\":\n\"H\xc3\xa9llo\"}".to_vec()]);
    }

    #[test]
    fn only_usage_after_finish_is_terminal_and_errors_remain_distinct() {
        let mut stream = StreamState::default();
        assert!(matches!(
            stream.frame(br#"{"usage":{},"choices":[]}"#),
            Some(Frame::Chunk {
                terminal_usage: false,
                stop_reason: None,
                ..
            })
        ));
        assert!(matches!(
            stream.frame(br#"{"usage":{},"choices":[{"finish_reason":"stop"}]}"#),
            Some(Frame::Chunk {
                terminal_usage: false,
                stop_reason: Some("stop"),
                ..
            })
        ));
        assert!(matches!(
            stream.frame(br#"{"usage":{},"choices":[]}"#),
            Some(Frame::Chunk {
                terminal_usage: true,
                stop_reason: Some("stop"),
                ..
            })
        ));
        assert!(matches!(
            stream.frame(br#"{"error":{"message":"fixture"}}"#),
            Some(Frame::ProviderError { .. })
        ));
        assert!(matches!(stream.frame(b"{"), Some(Frame::InvalidJson)));
        assert!(stream.frame(b"[DONE]").is_none() && stream.done);
    }
}
