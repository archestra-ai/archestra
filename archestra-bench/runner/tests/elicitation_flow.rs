//! End-to-end: a chat stream emits an MCP elicitation event, the harness answers it via the same
//! `EvalClient::answer_if_elicitation` that `drive_stage` calls, and the tool unblocks. A local HTTP
//! server plays the backend (real network I/O over a TCP boundary, no mocking of the runner's own
//! code): it streams an elicitation event, then withholds the `finish` event until the runner has
//! POSTed an answer — so a passing test proves the auto-answer is what lets the run continue.

use std::collections::HashMap;
use std::sync::Arc;

use archestra_bench::client::EvalClient;
use axum::{
    Json, Router,
    body::Body,
    extract::{Path, State},
    http::StatusCode,
    response::Response,
    routing::post,
};
use bytes::Bytes;
use futures::StreamExt;
use serde_json::{Value, json};
use tokio::net::TcpListener;
use tokio::sync::{Mutex, Notify};
use tokio::time::{Duration, timeout};

struct BackendState {
    posted_body: Mutex<Option<Value>>,
    answered: Notify,
}

enum StreamStep {
    Elicit,
    AwaitAnswer,
    Done,
}

async fn chat_handler(State(state): State<Arc<BackendState>>) -> Response {
    let elicit_line = format!(
        "data: {}\n",
        json!({
            "type": "data-mcp-elicitation",
            "data": {
                "id": "elicit-xyz",
                "conversationId": "conv-abc",
                "toolName": "refine_app",
                "mode": "form",
                "requestedSchema": {
                    "type": "object",
                    "properties": {
                        "access_level": {
                            "type": "string",
                            "enum": ["read-only", "admin"],
                            "default": "read-only"
                        }
                    }
                }
            }
        })
    );
    let finish_line = format!("data: {}\n", json!({ "type": "finish", "finishReason": "stop" }));

    let stream = futures::stream::unfold(
        (StreamStep::Elicit, state, elicit_line, finish_line),
        |(step, state, elicit_line, finish_line)| async move {
            match step {
                StreamStep::Elicit => Some((
                    Ok::<Bytes, std::io::Error>(Bytes::from(elicit_line.clone())),
                    (StreamStep::AwaitAnswer, state, elicit_line, finish_line),
                )),
                StreamStep::AwaitAnswer => {
                    // Gate the finish event on the runner's answer, so the assertion below proves
                    // the POST is what unblocks the stream.
                    state.answered.notified().await;
                    Some((
                        Ok(Bytes::from(finish_line.clone())),
                        (StreamStep::Done, state, elicit_line, finish_line),
                    ))
                }
                StreamStep::Done => None,
            }
        },
    );

    Response::builder()
        .header("content-type", "text/event-stream")
        .body(Body::from_stream(stream))
        .unwrap()
}

async fn elicitation_handler(
    Path(_id): Path<String>,
    State(state): State<Arc<BackendState>>,
    Json(body): Json<Value>,
) -> Json<Value> {
    *state.posted_body.lock().await = Some(body);
    state.answered.notify_one();
    Json(json!({ "success": true }))
}

async fn serve(app: Router) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    format!("http://{addr}")
}

#[tokio::test]
async fn auto_answers_form_elicitation_and_unblocks_stream() {
    let state = Arc::new(BackendState {
        posted_body: Mutex::new(None),
        answered: Notify::new(),
    });
    let base_url = serve(
        Router::new()
            .route("/api/chat", post(chat_handler))
            .route("/api/chat/elicitation/{id}", post(elicitation_handler))
            .with_state(state.clone()),
    )
    .await;

    let client = EvalClient::new(base_url, None);

    let saw_finish = timeout(Duration::from_secs(10), async {
        let mut stream = client
            .stream_chat_records("conv-abc", &[], "hi", &[], "turn-1")
            .await
            .expect("chat stream opens");

        // Exercise the exact per-event path drive_stage uses.
        let mut saw_finish = false;
        while let Some(record) = stream.next().await {
            let Some(event) = &record.event else { continue };
            client
                .answer_if_elicitation(event)
                .await
                .expect("elicitation answer posts");
            if event.get("type").and_then(|v| v.as_str()) == Some("finish") {
                saw_finish = true;
            }
        }
        saw_finish
    })
    .await
    .expect("stream completes within the timeout");

    assert!(saw_finish, "finish only arrives after the elicitation is answered");

    let posted = state
        .posted_body
        .lock()
        .await
        .clone()
        .expect("elicitation POST was received");
    assert_eq!(
        posted,
        json!({
            "conversationId": "conv-abc",
            "action": "accept",
            "content": { "access_level": "read-only" }
        })
    );
}

#[tokio::test]
async fn failed_answer_post_surfaces_error() {
    // A 5xx from the elicitation endpoint must surface as Err so drive_stage fails the stage rather
    // than waiting out the backend's 10-minute elicitation timeout.
    let base_url = serve(Router::new().route(
        "/api/chat/elicitation/{id}",
        post(|| async { (StatusCode::INTERNAL_SERVER_ERROR, "boom") }),
    ))
    .await;
    let client = EvalClient::new(base_url, None);

    let event: HashMap<String, Value> = serde_json::from_value(json!({
        "type": "data-mcp-elicitation",
        "data": {
            "id": "e1",
            "conversationId": "c1",
            "mode": "form",
            "requestedSchema": { "type": "object", "properties": {} }
        }
    }))
    .unwrap();

    assert!(
        client.answer_if_elicitation(&event).await.is_err(),
        "a failed answer POST must surface as an error"
    );
}

#[tokio::test]
async fn malformed_elicitation_event_surfaces_error() {
    // Typed as an elicitation but missing the id needed to answer it. It must fail loudly rather
    // than be silently skipped (which would leave the tool blocked). No POST is attempted, so the
    // base URL is never contacted.
    let client = EvalClient::new("http://127.0.0.1:1", None);
    let event: HashMap<String, Value> = serde_json::from_value(json!({
        "type": "data-mcp-elicitation",
        "data": { "conversationId": "c1" }
    }))
    .unwrap();

    assert!(
        client.answer_if_elicitation(&event).await.is_err(),
        "an unanswerable elicitation event must surface as an error"
    );
}
