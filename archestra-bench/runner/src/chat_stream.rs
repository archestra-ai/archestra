//! Chat-stream concern: parse the backend's SSE byte stream into typed chat events and fold those
//! events into the run-level [`ChatRunResult`]. The HTTP request that produces the stream lives on
//! `EvalClient::stream_chat_records` (client.rs); this module owns everything from raw bytes onward.

use std::collections::HashMap;

use bytes::Bytes;
use futures::Stream;
use reqwest::Response;
use serde_json::Value as JsonValue;

#[derive(Debug, Clone, Default)]
pub struct ChatRunResult {
    pub text: String,
    pub tool_calls: Vec<String>,
    pub tool_invocations: Vec<HashMap<String, JsonValue>>,
    pub turn_count: usize,
    pub finish_reason: Option<String>,
    pub total_tokens: Option<i64>,
    pub stage_tokens: Option<i64>,
    pub stream_error: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ChatStreamRecord {
    pub kind: ChatRecordKind,
    pub event: Option<HashMap<String, JsonValue>>,
    pub raw: Option<String>,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChatRecordKind {
    Event,
    Ignored,
    ParseError,
}

pub fn apply_chat_event(result: &mut ChatRunResult, event: &HashMap<String, JsonValue>) {
    match event.get("type").and_then(|v| v.as_str()) {
        Some("start-step") => {
            result.turn_count += 1;
        }
        Some("text-delta") => {
            let delta = event
                .get("delta")
                .and_then(|v| v.as_str())
                .or_else(|| event.get("text").and_then(|v| v.as_str()));
            if let Some(delta) = delta {
                result.text.push_str(delta);
            }
        }
        Some("tool-input-available") | Some("tool-call") => {
            if let Some(name) = event.get("toolName").and_then(|v| v.as_str()) {
                result.tool_calls.push(name.to_string());
                let mut invocation = HashMap::new();
                invocation.insert("name".to_string(), JsonValue::String(name.to_string()));
                invocation.insert(
                    "input".to_string(),
                    event.get("input").cloned().unwrap_or(JsonValue::Null),
                );
                result.tool_invocations.push(invocation);
            }
        }
        Some("finish") | Some("finish-step") => {
            if let Some(reason) = event.get("finishReason").and_then(|v| v.as_str()) {
                result.finish_reason = Some(reason.to_string());
            }
        }
        Some("data-token-usage") => {
            if let Some(data) = event.get("data").and_then(|v| v.as_object())
                && let Some(total) = data.get("totalTokens").and_then(|v| v.as_i64())
            {
                result.stage_tokens = Some(total);
            }
        }
        Some("error") => {
            let text = event
                .get("errorText")
                .or_else(|| event.get("error"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .unwrap_or_else(|| serde_json::to_string(event).unwrap_or_default());
            result.stream_error = Some(text);
        }
        _ => {}
    }
}

struct ChatRecordStream {
    stream: std::pin::Pin<Box<dyn Stream<Item = Result<Bytes, reqwest::Error>> + Send>>,
    // Raw bytes, not a String: assemble complete lines before UTF-8 decoding so a multibyte char
    // split across two network chunks is never corrupted (matches Python's line-then-decode order).
    buf: Vec<u8>,
    finished: bool,
}

impl ChatRecordStream {
    fn new(resp: Response) -> Self {
        Self {
            stream: Box::pin(resp.bytes_stream()),
            buf: Vec::new(),
            finished: false,
        }
    }

    fn drain_buffer(&mut self) -> Option<ChatStreamRecord> {
        while let Some(pos) = self.buf.iter().position(|&b| b == b'\n') {
            let line_bytes: Vec<u8> = self.buf.drain(..=pos).collect();
            let text = String::from_utf8_lossy(&line_bytes[..line_bytes.len() - 1]);
            if let Some(record) = process_sse_line(text.trim_end_matches('\r')) {
                return Some(record);
            }
        }
        None
    }

    // Flush any trailing line that arrived without a final newline (an unterminated last SSE line
    // must still be parsed, like httpx's line iteration does on the Python side).
    fn flush_final_line(&mut self) -> Option<ChatStreamRecord> {
        if self.buf.is_empty() {
            return None;
        }
        let line_bytes = std::mem::take(&mut self.buf);
        let text = String::from_utf8_lossy(&line_bytes);
        process_sse_line(text.trim_end_matches('\r'))
    }
}

fn process_sse_line(line: &str) -> Option<ChatStreamRecord> {
    if let Some(payload) = sse_data_payload(line) {
        if payload == "[DONE]" {
            return Some(ChatStreamRecord {
                kind: ChatRecordKind::Ignored,
                event: None,
                raw: Some(line.to_string()),
                reason: Some("done".to_string()),
            });
        }
        if payload.is_empty() {
            return Some(ChatStreamRecord {
                kind: ChatRecordKind::Ignored,
                event: None,
                raw: Some(line.to_string()),
                reason: Some("empty data payload".to_string()),
            });
        }
        // Parse to a value first, then require an object — a valid-but-non-object payload (e.g.
        // `data: 42`) is ignored, not a parse error. Only genuinely malformed JSON is a ParseError
        // (which can fail the rollout).
        return Some(match serde_json::from_str::<JsonValue>(payload) {
            Ok(JsonValue::Object(map)) => ChatStreamRecord {
                kind: ChatRecordKind::Event,
                event: Some(map.into_iter().collect()),
                raw: Some(line.to_string()),
                reason: None,
            },
            Ok(_) => ChatStreamRecord {
                kind: ChatRecordKind::Ignored,
                event: None,
                raw: Some(line.to_string()),
                reason: Some("non-object data payload".to_string()),
            },
            Err(e) => ChatStreamRecord {
                kind: ChatRecordKind::ParseError,
                event: None,
                raw: Some(line.to_string()),
                reason: Some(e.to_string()),
            },
        });
    }
    if !line.is_empty() {
        return Some(ChatStreamRecord {
            kind: ChatRecordKind::Ignored,
            event: None,
            raw: Some(line.to_string()),
            reason: Some("non-data line".to_string()),
        });
    }
    None
}

impl Stream for ChatRecordStream {
    type Item = ChatStreamRecord;

    fn poll_next(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<Self::Item>> {
        if self.finished {
            return std::task::Poll::Ready(None);
        }
        if let Some(record) = self.drain_buffer() {
            return std::task::Poll::Ready(Some(record));
        }
        loop {
            match self.stream.as_mut().poll_next(cx) {
                std::task::Poll::Ready(Some(Ok(bytes))) => {
                    self.buf.extend_from_slice(&bytes);
                    if let Some(record) = self.drain_buffer() {
                        return std::task::Poll::Ready(Some(record));
                    }
                }
                std::task::Poll::Ready(Some(Err(e))) => {
                    self.finished = true;
                    return std::task::Poll::Ready(Some(ChatStreamRecord {
                        kind: ChatRecordKind::ParseError,
                        event: None,
                        raw: None,
                        reason: Some(format!("chat stream interrupted: {e}")),
                    }));
                }
                std::task::Poll::Ready(None) => {
                    self.finished = true;
                    if let Some(record) = self.flush_final_line() {
                        return std::task::Poll::Ready(Some(record));
                    }
                    return std::task::Poll::Ready(None);
                }
                std::task::Poll::Pending => return std::task::Poll::Pending,
            }
        }
    }
}

pub fn stream_chat_records(resp: Response) -> impl Stream<Item = ChatStreamRecord> {
    ChatRecordStream::new(resp)
}

fn sse_data_payload(line: &str) -> Option<&str> {
    if !line.starts_with("data:") {
        return None;
    }
    Some(line[5..].trim())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sse_data_payload() {
        assert_eq!(sse_data_payload("data: hello"), Some("hello"));
        assert_eq!(sse_data_payload("data:  [DONE]"), Some("[DONE]"));
        assert_eq!(sse_data_payload("event: message"), None);
    }

    fn stream_from_chunks(chunks: Vec<Vec<u8>>) -> ChatRecordStream {
        let items: Vec<Result<Bytes, reqwest::Error>> =
            chunks.into_iter().map(|c| Ok(Bytes::from(c))).collect();
        ChatRecordStream {
            stream: Box::pin(futures::stream::iter(items)),
            buf: Vec::new(),
            finished: false,
        }
    }

    async fn collect_events(stream: ChatRecordStream) -> Vec<HashMap<String, JsonValue>> {
        use futures::StreamExt;
        stream
            .filter_map(|r| async move { r.event })
            .collect()
            .await
    }

    #[tokio::test]
    async fn test_sse_multibyte_split_across_chunks() {
        // `data: {"k":"é"}\n` with the two bytes of "é" (0xC3 0xA9) landing in different chunks.
        let full = b"data: {\"k\":\"\xc3\xa9\"}\n";
        let split = 13; // between the two bytes of "é" (0xc3 at 12, 0xa9 at 13)
        let chunks = vec![full[..split].to_vec(), full[split..].to_vec()];
        let events = collect_events(stream_from_chunks(chunks)).await;
        assert_eq!(events.len(), 1);
        assert_eq!(
            events[0].get("k"),
            Some(&JsonValue::String("é".to_string()))
        );
    }

    #[tokio::test]
    async fn test_sse_non_object_payload_is_ignored_not_error() {
        // A valid-but-non-object data line must be ignored (not a ParseError that fails the rollout);
        // only malformed JSON is a parse error.
        use futures::StreamExt;
        let chunks = vec![
            b"data: 42\n".to_vec(),
            b"data: not json\n".to_vec(),
            b"data: {\"k\":\"v\"}\n".to_vec(),
        ];
        let records: Vec<_> = stream_from_chunks(chunks).collect().await;
        let kinds: Vec<_> = records.iter().map(|r| r.kind.clone()).collect();
        assert_eq!(
            kinds,
            vec![
                ChatRecordKind::Ignored,    // 42 — valid JSON, not an object
                ChatRecordKind::ParseError, // not json — malformed
                ChatRecordKind::Event,      // object
            ]
        );
    }

    #[tokio::test]
    async fn test_sse_unterminated_final_line_is_flushed() {
        // final SSE line arrives with no trailing newline — it must still be parsed at EOF.
        let chunks = vec![b"data: {\"k\":\"v\"}".to_vec()];
        let events = collect_events(stream_from_chunks(chunks)).await;
        assert_eq!(events.len(), 1);
        assert_eq!(
            events[0].get("k"),
            Some(&JsonValue::String("v".to_string()))
        );
    }
}
