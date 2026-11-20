use std::{io, time::Duration};

use axum::{body::Body, http::StatusCode};
use futures_util::{Stream, StreamExt, TryStreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::time::{Instant, MissedTickBehavior, interval_at, sleep_until};
use tokio_util::{
    codec::{FramedRead, LinesCodec},
    io::StreamReader,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Start {
    subscription_id: Value,
    tools_list_changed: bool,
    poll_interval_ms: u32,
    heartbeat_ms: u32,
    max_duration_ms: u32,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum Update {
    Fingerprint { value: String },
    Failed,
    End,
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum Frame {
    Sse { value: String },
    Poll,
}

type Input = FramedRead<
    StreamReader<
        futures_util::stream::MapErr<axum::body::BodyDataStream, fn(axum::Error) -> io::Error>,
        axum::body::Bytes,
    >,
    LinesCodec,
>;

pub(crate) async fn subscribe(body: Body) -> Result<Body, StatusCode> {
    let mut input: Input = FramedRead::new(
        StreamReader::new(
            body.into_data_stream()
                .map_err(io::Error::other as fn(axum::Error) -> io::Error),
        ),
        LinesCodec::new_with_max_length(72 * 1024 * 1024),
    );
    let line = input
        .next()
        .await
        .and_then(Result::ok)
        .ok_or(StatusCode::BAD_REQUEST)?;
    let start: Start = serde_json::from_str(&line).map_err(|_| StatusCode::BAD_REQUEST)?;
    if start.subscription_id.is_null() || start.poll_interval_ms == 0 || start.heartbeat_ms == 0 {
        return Err(StatusCode::BAD_REQUEST);
    }
    Ok(Body::from_stream(frames(start, input)))
}

fn frames(start: Start, mut input: Input) -> impl Stream<Item = io::Result<String>> {
    async_stream::try_stream! {
        let now = Instant::now();
        let heartbeat = Duration::from_millis(start.heartbeat_ms.into());
        let mut heartbeat = interval_at(now + heartbeat, heartbeat);
        heartbeat.set_missed_tick_behavior(MissedTickBehavior::Skip);
        let poll = Duration::from_millis(start.poll_interval_ms.into());
        let mut poll = interval_at(now + poll, poll);
        poll.set_missed_tick_behavior(MissedTickBehavior::Skip);
        let expiry = sleep_until(now + Duration::from_millis(start.max_duration_ms.into()));
        tokio::pin!(expiry);
        let id = start.subscription_id;
        let meta = json!({ "io.modelcontextprotocol/subscriptionId": id });
        let accepted = if start.tools_list_changed { json!({"toolsListChanged": true}) } else { json!({}) };
        yield encode(Frame::Sse { value: message(json!({
            "jsonrpc": "2.0", "method": "notifications/subscriptions/acknowledged",
            "params": { "_meta": meta, "notifications": accepted },
        })) })?;
        let mut baseline = None;
        let mut pending = start.tools_list_changed;
        if pending { yield encode(Frame::Poll)?; }
        enum Tick<T> { Incoming(T), Expired, Heartbeat, Poll }
        loop {
            let tick = tokio::select! {
                incoming = input.next() => Tick::Incoming(incoming),
                _ = &mut expiry, if start.max_duration_ms > 0 => Tick::Expired,
                _ = heartbeat.tick() => Tick::Heartbeat,
                _ = poll.tick(), if start.tools_list_changed && baseline.is_some() && !pending => Tick::Poll,
            };
            match tick {
                Tick::Incoming(incoming) => {
                    let Some(line) = incoming else { return; };
                    let line = line.map_err(io::Error::other)?;
                    match serde_json::from_str::<Update>(&line).map_err(io::Error::other)? {
                        Update::End => break,
                        Update::Failed if pending && baseline.is_none() => break,
                        Update::Failed if pending => pending = false,
                        Update::Fingerprint { value } if pending => {
                            pending = false;
                            let changed = baseline.as_ref().is_some_and(|last| last != &value);
                            if baseline.is_none() { poll.reset(); }
                            baseline = Some(value);
                            if changed {
                                yield encode(Frame::Sse { value: message(json!({
                                    "jsonrpc": "2.0", "method": "notifications/tools/list_changed",
                                    "params": { "_meta": meta },
                                })) })?;
                            }
                        }
                        _ => Err(io::Error::other("unsolicited subscription update"))?,
                    }
                }
                Tick::Expired => break,
                Tick::Heartbeat => yield encode(Frame::Sse { value: ": keep-alive\n\n".into() })?,
                Tick::Poll => {
                    pending = true;
                    yield encode(Frame::Poll)?;
                }
            }
        }
        yield encode(Frame::Sse { value: message(json!({
            "jsonrpc": "2.0", "id": id, "result": { "resultType": "complete", "_meta": meta },
        })) })?;
    }
}

fn message(value: Value) -> String {
    format!("event: message\ndata: {value}\n\n")
}

fn encode(frame: Frame) -> io::Result<String> {
    let mut frame = serde_json::to_string(&frame).map_err(io::Error::other)?;
    frame.push('\n');
    Ok(frame)
}
