use std::{
    collections::HashMap,
    io::{Read, Write},
    net::TcpListener,
    sync::{Arc, Mutex},
    thread,
    time::Duration,
};

use appa_eventlog::{Backend, LogStore};
use appa_runtime::{api::Runtime, hooks};
use appa_runtime_api::{
    Actor, HookDecision, HookEvent, OutcomeBody, ProposedCall, ToolOutcome, TrajectoryId,
};

use crate::policy;

struct Room {
    trust: &'static str,
    readers: Option<Vec<&'static str>>,
}

fn rooms() -> HashMap<String, Room> {
    HashMap::from([
        (
            "room-command".into(),
            Room {
                trust: "trusted",
                readers: Some(vec!["alice@example.com", "bob@example.com"]),
            },
        ),
        (
            "room-a".into(),
            Room {
                trust: "suspicious",
                readers: Some(vec!["alice@example.com", "bob@example.com"]),
            },
        ),
        (
            "room-subset".into(),
            Room {
                trust: "suspicious",
                readers: Some(vec!["alice@example.com"]),
            },
        ),
        (
            "room-super".into(),
            Room {
                trust: "suspicious",
                readers: Some(vec![
                    "alice@example.com",
                    "bob@example.com",
                    "eve@example.com",
                ]),
            },
        ),
        (
            "room-other".into(),
            Room {
                trust: "suspicious",
                readers: Some(vec!["carol@example.com"]),
            },
        ),
        (
            "room-unresolved".into(),
            Room {
                trust: "suspicious",
                readers: None,
            },
        ),
    ])
}

fn serve(listener: TcpListener, rooms: Arc<Mutex<HashMap<String, Room>>>) {
    for stream in listener.incoming() {
        let Ok(mut stream) = stream else { continue };
        let rooms = rooms.clone();
        let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
        let mut buffer = Vec::new();
        let mut chunk = [0_u8; 4096];
        loop {
            match stream.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(read) => {
                    buffer.extend_from_slice(&chunk[..read]);
                    if buffer.windows(4).any(|window| window == b"\r\n\r\n") {
                        let header_end = buffer
                            .windows(4)
                            .position(|window| window == b"\r\n\r\n")
                            .unwrap();
                        let headers = String::from_utf8_lossy(&buffer[..header_end]);
                        let length = headers
                            .lines()
                            .find_map(|line| {
                                line.to_ascii_lowercase()
                                    .strip_prefix("content-length:")
                                    .map(|value| value.trim().parse::<usize>().unwrap_or(0))
                            })
                            .unwrap_or(0);
                        if buffer.len() >= header_end + 4 + length {
                            break;
                        }
                    }
                }
            }
        }
        let text = String::from_utf8_lossy(&buffer);
        let path = text
            .lines()
            .next()
            .unwrap_or("")
            .split_whitespace()
            .nth(1)
            .unwrap_or("");
        let body = text.split("\r\n\r\n").nth(1).unwrap_or("");
        let response = consult(path, body, &rooms.lock().expect("rooms"));
        let status = if response.is_some() {
            "200 OK"
        } else {
            "502 Bad Gateway"
        };
        let payload = response.unwrap_or_else(|| "{\"version\":1,\"answer\":null}".into());
        let http = format!(
            "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{payload}",
            payload.len()
        );
        let _ = stream.write_all(http.as_bytes());
        let _ = stream.flush();
        drop(stream);
    }
}

fn consult(path: &str, body: &str, rooms: &HashMap<String, Room>) -> Option<String> {
    let parsed: serde_json::Value = serde_json::from_str(body).ok()?;
    if path.ends_with("/native-room") {
        let tool = parsed["artifact"]["tool"].as_str().unwrap_or("");
        if !tool.contains("native_ingress") && !tool.contains("native_reply") {
            return Some(r#"{"version":1,"answer":null}"#.into());
        }
        let room_id = parsed["artifact"]["arguments"]["room_id"].as_str()?;
        let Some(room) = rooms.get(room_id) else {
            return Some(format!(
                r#"{{"version":1,"answer":{{"missing":true,"room_id":"{room_id}"}}}}"#
            ));
        };
        let readers = if room.readers.is_some() {
            "resolved"
        } else {
            "unresolved"
        };
        return Some(format!(
            r#"{{"version":1,"answer":{{"room_id":"{room_id}","trust":"{}","readers":"{readers}"}}}}"#,
            room.trust
        ));
    }
    if path.ends_with("/native") {
        let selector = parsed["artifact"]["selector"].as_str().unwrap_or("");
        let room_id = selector.strip_prefix("room/")?;
        let room = rooms.get(room_id)?;
        let readers = room.readers.as_ref()?;
        let members = serde_json::to_string(readers).ok()?;
        return Some(format!(
            r#"{{"version":1,"answer":{{"members":{members}}}}}"#
        ));
    }
    if path.ends_with("/noop") {
        return Some(
            r#"{"version":1,"answer":{"delta":{},"requires":{"history":[],"attention":[]},"emits":[]}}"#
                .into(),
        );
    }
    if path.ends_with("/native.source-trust") || path.ends_with("/native.reply-check") {
        return annotate(path, &parsed);
    }
    None
}

fn annotate(path: &str, parsed: &serde_json::Value) -> Option<String> {
    let answer = &parsed["artifact"]["context"]["native-room"]["answer"];
    if answer["missing"].as_bool() == Some(true) || answer["readers"].as_str().is_none() {
        return None;
    }
    let room_id = answer["room_id"].as_str()?;
    let argued = parsed["artifact"]["args"]["arguments"]["room_id"].as_str();
    if argued.is_some_and(|argued| argued != room_id) {
        return None;
    }
    // A forged trust field in the call arguments is not the label.
    if path.ends_with("/native.source-trust") {
        let low_rank = parsed["declaration"]["trust_ranks"][0].as_str()?;
        let trust = if answer["trust"] == "suspicious" {
            format!(r#","trust":"{low_rank}""#)
        } else {
            String::new()
        };
        return Some(format!(
            r#"{{"version":1,"answer":{{"delta":{{"audience":["@native:room/{room_id}"]{trust}}},"requires":{{"history":[],"attention":[]}},"emits":["native.admitted"]}}}}"#
        ));
    }
    Some(format!(
        r#"{{"version":1,"answer":{{"delta":{{}},"requires":{{"audience":{{"contains":["@native:room/{room_id}"]}},"history":[{{"contains":"native.admitted"}}],"attention":[]}},"emits":["native.reply"]}}}}"#
    ))
}

fn runtime_for(root: &str, port: u16) -> Runtime {
    // Cross-language tests supply the real TS bridge. Standalone Rust tests
    // continue to run their local process-boundary fixture, never skip.
    let port = std::env::var("APPA_NATIVE_TEST_PORT")
        .map(|value| value.parse::<u16>().expect("test bridge port"))
        .unwrap_or(port);
    let url = format!(
        "http://127.0.0.1:{port}/api/openappa/helpers/00000000-0000-4000-8000-0000000000aa"
    );
    let composed = policy::compose_with_native_url(root, &[], &url).expect("compose");
    let store = Arc::new(LogStore::open(Backend::Memory).unwrap());
    policy::open(
        policy::compile(&composed.content, |var| {
            if var.starts_with("APPA_ARCHESTRA_") {
                return Some(
                    std::env::var("APPA_NATIVE_TEST_TOKEN")
                        .unwrap_or_else(|_| "native-test".to_owned()),
                );
            }
            None
        })
        .unwrap(),
        store,
    )
    .unwrap()
}

fn room_id(name: &str) -> String {
    match std::env::var("APPA_NATIVE_TEST_ROOMS") {
        Ok(mapping) => {
            let rooms: HashMap<String, String> =
                serde_json::from_str(&mapping).expect("test room mapping");
            rooms
                .get(name)
                .unwrap_or_else(|| panic!("missing test room {name}"))
                .clone()
        }
        Err(_) => name.to_owned(),
    }
}

fn call(actor: &Actor, id: &str, tool: &str, arguments: serde_json::Value) -> HookEvent {
    HookEvent::ToolCall {
        actor: actor.clone(),
        call_id: Some(format!("call:{id}")),
        call: ProposedCall {
            tool: tool.to_owned(),
            arguments: serde_json::value::to_raw_value(&arguments).unwrap(),
            cwd: None,
        },
        spawn: None,
        prompt: None,
        ruling: None,
    }
}

async fn accept_narrowing(
    runtime: &Runtime,
    actor: &Actor,
    id: &str,
    tool: &str,
    arguments: serde_json::Value,
) {
    let decision = hooks::handle(runtime, call(actor, id, tool, arguments.clone())).await;
    let HookDecision::DenyCall {
        offers, feedback, ..
    } = &decision
    else {
        panic!("ingress narrowing should offer acceptance, got {decision:?}");
    };
    let offer = offers
        .first()
        .unwrap_or_else(|| panic!("no offer: {feedback}"));
    let accepted = runtime
        .execute_remedy(actor, appa_runtime::api::OfferId(offer.id.clone()))
        .await;
    assert!(
        matches!(
            accepted,
            appa_runtime::api::RemedyOutcome::Authorized { .. }
        ),
        "host must be able to accept its own ingress narrowing, got {accepted:?}"
    );
    let released = hooks::handle(runtime, call(actor, id, tool, arguments)).await;
    assert!(
        matches!(released, HookDecision::AllowCall { .. }),
        "accepted ingress must release, got {released:?}"
    );
}

async fn succeed(
    runtime: &Runtime,
    actor: &Actor,
    id: &str,
    tool: &str,
    arguments: serde_json::Value,
    body: &str,
) {
    let decision = hooks::handle(
        runtime,
        HookEvent::ToolResult {
            actor: actor.clone(),
            call: ProposedCall {
                tool: tool.to_owned(),
                arguments: serde_json::value::to_raw_value(&arguments).unwrap(),
                cwd: None,
            },
            call_id: Some(format!("call:{id}")),
            outcome: ToolOutcome::Success {
                body: OutcomeBody::Available(body.into()),
            },
        },
    )
    .await;
    assert!(
        matches!(decision, HookDecision::Ack),
        "result of {tool} was {decision:?}"
    );
}

fn root_policy() -> String {
    r#"[policy]
version = 2
[[policy.tool]]
name = "host/archestra/privileged_send"
delta = {}
requires = { trust = "trusted" }

[[policy.tool]]
name = "host/archestra/private_read"
delta = {}
requires = { audience = { within = ["self"] } }
"#
    .to_owned()
}

fn wildcard_root() -> String {
    r#"[policy]
version = 2

[[policy.annotator]]
name = "noop"

[externals.annotators.noop]
url = "http://127.0.0.1:9/noop"
token_env = "APPA_TEST_NOOP"

[[policy.tool]]
name = "*"
annotator = "noop"
"#
    .to_owned()
}

#[tokio::test]
async fn an_attachment_cannot_borrow_the_trust_of_an_authenticated_command() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let room_facts = Arc::new(Mutex::new(rooms()));
    thread::spawn(move || serve(listener, room_facts));
    let runtime = runtime_for(&root_policy(), port);
    let actor = Actor {
        root: TrajectoryId("attachment-trust".into()),
        child: None,
    };
    assert!(matches!(
        hooks::handle(
            &runtime,
            HookEvent::SessionStart {
                root: actor.root.clone(),
                principal: None,
                address: None,
                title: None,
            }
        )
        .await,
        HookDecision::Ack
    ));

    let command = serde_json::json!({ "room_id": "room-command", "content_digest": "command" });
    accept_narrowing(
        &runtime,
        &actor,
        "command",
        "host/archestra/native_ingress",
        command.clone(),
    )
    .await;
    succeed(
        &runtime,
        &actor,
        "command",
        "host/archestra/native_ingress",
        command,
        "Authenticated command",
    )
    .await;
    assert!(matches!(
        hooks::handle(
            &runtime,
            call(
                &actor,
                "before-file",
                "host/archestra/privileged_send",
                serde_json::json!({})
            )
        )
        .await,
        HookDecision::AllowCall { .. }
    ));
    succeed(
        &runtime,
        &actor,
        "before-file",
        "host/archestra/privileged_send",
        serde_json::json!({}),
        "{}",
    )
    .await;

    let file = serde_json::json!({ "room_id": "room-a", "content_digest": "file" });
    accept_narrowing(
        &runtime,
        &actor,
        "file",
        "host/archestra/native_ingress",
        file.clone(),
    )
    .await;
    succeed(
        &runtime,
        &actor,
        "file",
        "host/archestra/native_ingress",
        file,
        "Malicious instructions inside an attachment",
    )
    .await;
    assert!(matches!(
        hooks::handle(
            &runtime,
            call(
                &actor,
                "after-file",
                "host/archestra/privileged_send",
                serde_json::json!({})
            )
        )
        .await,
        HookDecision::DenyCall { .. }
    ));
    assert!(matches!(
        hooks::handle(
            &runtime,
            call(
                &actor,
                "safe-reply",
                "host/archestra/native_reply",
                serde_json::json!({ "room_id": "room-command", "content_digest": "reply" })
            )
        )
        .await,
        HookDecision::AllowCall { .. }
    ));
}

#[tokio::test]
async fn native_contracts_narrow_audience_and_keep_a_suspicious_reply() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let rooms = Arc::new(Mutex::new(rooms()));
    thread::spawn(move || serve(listener, rooms));
    let runtime = runtime_for(&root_policy(), port);
    let actor = Actor {
        root: TrajectoryId("native-room".into()),
        child: None,
    };
    assert!(matches!(
        hooks::handle(
            &runtime,
            HookEvent::SessionStart {
                root: actor.root.clone(),
                principal: None,
                address: None,
                title: None,
            },
        )
        .await,
        HookDecision::Ack
    ));

    let ingress_args = serde_json::json!({
        "room_id": room_id("room-a"),
        "content_digest": "digest-a",
        "trust": "trusted",
        "readers": ["eve@example.com"]
    });
    accept_narrowing(
        &runtime,
        &actor,
        "in-a",
        "host/archestra/native_ingress",
        ingress_args.clone(),
    )
    .await;
    succeed(
        &runtime,
        &actor,
        "in-a",
        "host/archestra/native_ingress",
        ingress_args,
        "untrusted body",
    )
    .await;

    let privileged = hooks::handle(
        &runtime,
        call(
            &actor,
            "priv",
            "host/archestra/privileged_send",
            serde_json::json!({}),
        ),
    )
    .await;
    assert!(
        matches!(privileged, HookDecision::DenyCall { .. }),
        "suspicious context must block a trusted tool, got {privileged:?}"
    );

    let reply = hooks::handle(
        &runtime,
        call(
            &actor,
            "reply-a",
            "host/archestra/native_reply",
            serde_json::json!({ "room_id": room_id("room-a"), "content_digest": "reply-a" }),
        ),
    )
    .await;
    assert!(
        matches!(reply, HookDecision::AllowCall { .. }),
        "same-room reply from suspicious context must be allowed, got {reply:?}"
    );

    let wider = hooks::handle(
        &runtime,
        call(
            &actor,
            "reply-super",
            "host/archestra/native_reply",
            serde_json::json!({ "room_id": room_id("room-super"), "content_digest": "reply-super" }),
        ),
    )
    .await;
    assert!(
        !matches!(wider, HookDecision::AllowCall { .. }),
        "a new member must not be covered, got {wider:?}"
    );

    let other = hooks::handle(
        &runtime,
        call(
            &actor,
            "reply-other",
            "host/archestra/native_reply",
            serde_json::json!({ "room_id": room_id("room-other"), "content_digest": "reply-other" }),
        ),
    )
    .await;
    assert!(
        !matches!(other, HookDecision::AllowCall { .. }),
        "an unrelated room must be blocked, got {other:?}"
    );

    let subset = hooks::handle(
        &runtime,
        call(
            &actor,
            "reply-subset",
            "host/archestra/native_reply",
            serde_json::json!({ "room_id": room_id("room-subset"), "content_digest": "reply-subset" }),
        ),
    )
    .await;
    assert!(
        matches!(subset, HookDecision::AllowCall { .. }),
        "a reader subset of the admitted room must be allowed, got {subset:?}"
    );

    let missing = hooks::handle(
        &runtime,
        call(
            &actor,
            "reply-missing",
            "host/archestra/native_reply",
            serde_json::json!({ "room_id": room_id("room-missing"), "content_digest": "reply-missing" }),
        ),
    )
    .await;
    assert!(
        matches!(missing, HookDecision::Refuse { .. }),
        "unknown readers must fail closed, got {missing:?}"
    );

    let unknown = Actor {
        root: TrajectoryId("native-unknown".into()),
        child: None,
    };
    assert!(matches!(
        hooks::handle(
            &runtime,
            HookEvent::SessionStart {
                root: unknown.root.clone(),
                principal: None,
                address: None,
                title: None,
            },
        )
        .await,
        HookDecision::Ack
    ));
    let unknown_args = serde_json::json!({
        "room_id": room_id("room-unresolved"),
        "content_digest": "unknown"
    });
    accept_narrowing(
        &runtime,
        &unknown,
        "in-unknown",
        "host/archestra/native_ingress",
        unknown_args.clone(),
    )
    .await;
    succeed(
        &runtime,
        &unknown,
        "in-unknown",
        "host/archestra/native_ingress",
        unknown_args,
        "public channel",
    )
    .await;
    let same_unknown = hooks::handle(
        &runtime,
        call(
            &unknown,
            "reply-unknown",
            "host/archestra/native_reply",
            serde_json::json!({ "room_id": room_id("room-unresolved"), "content_digest": "reply-unknown" }),
        ),
    )
    .await;
    assert!(
        matches!(same_unknown, HookDecision::AllowCall { .. }),
        "the same unresolved room is reflexive, got {same_unknown:?}"
    );
    let private = hooks::handle(
        &runtime,
        call(
            &unknown,
            "private",
            "host/archestra/private_read",
            serde_json::json!({}),
        ),
    )
    .await;
    assert!(
        !matches!(private, HookDecision::AllowCall { .. }),
        "a membership proof the source cannot give must refuse, got {private:?}"
    );
}

#[test]
fn an_explicit_root_rule_overrides_the_host_reply_contract() {
    let root = r#"[policy]
version = 2
[[policy.tool]]
name = "host/archestra/native_reply"
delta = {}
requires = { trust = "trusted" }
"#;
    let composed = policy::compose(root, &[]).unwrap();
    let names = tool_rules(&composed.content, "host/archestra/native_reply");
    assert!(
        names[0].contains("trusted"),
        "the root rule must stay first: {names:?}"
    );
    assert!(
        names.last().unwrap().contains("native.reply-check"),
        "the host contract remains for arguments the root rule does not cover: {names:?}"
    );
}

#[test]
fn a_noop_wildcard_does_not_mask_the_declared_native_contract() {
    let composed = policy::compose(&wildcard_root(), &[]).unwrap();
    let document: toml::Table = toml::from_str(&composed.content).unwrap();
    let tools = document["policy"]["tool"].as_array().unwrap();
    let ingress = tools
        .iter()
        .find(|tool| tool["name"].as_str() == Some("host/archestra/native_ingress"))
        .unwrap();
    assert_eq!(ingress["annotator"].as_str(), Some("native.source-trust"));
    assert!(tools.iter().any(|tool| tool["name"].as_str() == Some("*")));
}

#[test]
fn a_custom_trust_chain_is_kept_and_native_uses_its_bottom_rank() {
    let root = r#"[policy]
version = 2
trust_chain = ["untrusted", "trusted"]
[[policy.tool]]
name = "read"
delta = {}
"#;
    let composed = policy::compose(root, &[]).unwrap();
    let document: toml::Table = toml::from_str(&composed.content).unwrap();
    let chain: Vec<_> = document["policy"]["trust_chain"]
        .as_array()
        .unwrap()
        .iter()
        .map(|rank| rank.as_str().unwrap())
        .collect();
    assert_eq!(
        chain,
        ["untrusted", "trusted"],
        "the root chain must be unchanged"
    );
    assert!(
        composed.content.contains("ranks = [\"untrusted\"]"),
        "native annotators use the bottom rank, not a hardcoded suspicious: {}",
        composed.content
    );
    assert!(
        !composed.content.contains("ranks = [\"suspicious\"]"),
        "suspicious is not in this chain: {}",
        composed.content
    );
}

fn tool_rules(content: &str, name: &str) -> Vec<String> {
    let document: toml::Table = toml::from_str(content).unwrap();
    document["policy"]["tool"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|tool| tool["name"].as_str() == Some(name))
        .map(|tool| tool.to_string())
        .collect()
}
