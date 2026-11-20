use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, State},
    routing::post,
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use ring::{digest, hmac};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use subtle::ConstantTimeEq;

const RECEIPT_DOMAIN: &str = "archestra.appa.child-trajectory.v2";
const EMPTY_PROMPT: &str = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

pub(crate) fn router() -> Router {
    Router::new()
        .route(
            "/internal/v1/openai/delegation-attachment",
            post(verify_attachment).layer(DefaultBodyLimit::max(72 * 1024 * 1024)),
        )
        .route(
            "/internal/v1/openai/delegation-proof",
            post(verify).layer(DefaultBodyLimit::max(64 * 1024)),
        )
        .with_state(super::openai_runtime_proof::signing_key())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Attachment {
    before: Map<String, Value>,
    after: Map<String, Value>,
    field: String,
    appended: Value,
    organization_id: String,
    id: String,
    name: String,
    binding: Option<Binding>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Binding {
    caller_id: Option<String>,
    spawner_native_id: String,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
enum Verdict {
    Authorized,
    Continuation,
    Denied,
}

async fn verify_attachment(
    State(key): State<Option<hmac::Key>>,
    Json(input): Json<Attachment>,
) -> Json<Verdict> {
    Json(
        key.as_ref()
            .map_or(Verdict::Denied, |key| attachment(key, input)),
    )
}

fn attachment(root: &hmac::Key, mut input: Attachment) -> Verdict {
    let before = input.before.remove(&input.field);
    let after = input.after.remove(&input.field);
    if input.before != input.after {
        return Verdict::Denied;
    }
    let (line, prompt) = match (&before, &after, &input.appended) {
        (Some(Value::String(before)), Some(Value::String(after)), Value::String(suffix))
            if !trim_js(before).is_empty() && after.strip_prefix(before) == Some(suffix) =>
        {
            let Some(line) = suffix.strip_prefix("\n\n") else {
                return Verdict::Denied;
            };
            (line, before.as_str())
        }
        (Some(Value::Array(before)), Some(Value::Array(after)), Value::Object(item))
            if !before.is_empty()
                && after.strip_prefix(before.as_slice())
                    == Some(std::slice::from_ref(&input.appended))
                && item.len() == 2
                && item.get("type").and_then(Value::as_str) == Some("text") =>
        {
            let Some(line) = item.get("text").and_then(Value::as_str) else {
                return Verdict::Denied;
            };
            (line, "")
        }
        _ => return Verdict::Denied,
    };
    if let Some(binding) = &input.binding
        && let Some(marker) = direct_marker(&input, binding, line, prompt)
        && valid(root, &marker)
    {
        return Verdict::Authorized;
    }
    if input.appended.is_string()
        && input.name == "spawn_subagent"
        && input.field == "prompt"
        && input
            .before
            .get("resume_from")
            .is_some_and(Value::is_string)
    {
        return Verdict::Continuation;
    }
    Verdict::Denied
}

fn direct_marker(
    input: &Attachment,
    binding: &Binding,
    line: &str,
    prompt: &str,
) -> Option<Request> {
    let line = line.strip_suffix('\r').unwrap_or(line);
    let (token, parent_id) = line
        .strip_prefix("[appa] delegated trajectory ")?
        .strip_suffix('.')?
        .split_once(" — child of ")?;
    if parent_id.is_empty() || parent_id.contains('\n') {
        return None;
    }
    let mut parts = token.split('.');
    let head = parts.next()?;
    let (spawn, runtime) = if let Some(spawn) = head.strip_prefix("appa3-") {
        (
            spawn,
            Some(String::from_utf8(URL_SAFE_NO_PAD.decode(parts.next()?).ok()?).ok()?),
        )
    } else {
        (head.strip_prefix("appa2-")?, None)
    };
    if input.id.is_empty() || URL_SAFE_NO_PAD.decode(spawn).ok()?.as_slice() != input.id.as_bytes()
    {
        return None;
    }
    let hash = digest::digest(&digest::SHA256, trim_js(prompt).as_bytes());
    Some(Request {
        token: token.into(),
        organization_id: input.organization_id.clone(),
        caller_id: binding.caller_id.clone(),
        parent_id: parent_id.into(),
        spawner_native_id: binding.spawner_native_id.clone(),
        prompt_digest: hash
            .as_ref()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect(),
        spawn_call_id: Some(input.id.clone()),
        runtime_session_id: runtime.filter(|id| !id.is_empty()),
        receipt_token: None,
    })
}

fn trim_js(text: &str) -> &str {
    text.trim_matches(|c| {
        matches!(c,
            '\t'..='\r' | ' ' | '\u{00a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}'
            | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'
        )
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    token: String,
    organization_id: String,
    caller_id: Option<String>,
    parent_id: String,
    spawner_native_id: String,
    prompt_digest: String,
    spawn_call_id: Option<String>,
    runtime_session_id: Option<String>,
    receipt_token: Option<String>,
}

async fn verify(State(key): State<Option<hmac::Key>>, Json(request): Json<Request>) -> Json<bool> {
    Json(key.as_ref().is_some_and(|key| valid(key, &request)))
}

fn valid(root: &hmac::Key, input: &Request) -> bool {
    let decode = |text| {
        URL_SAFE_NO_PAD
            .decode(text)
            .ok()
            .and_then(|bytes| String::from_utf8(bytes).ok())
            .filter(|value| !value.is_empty())
    };
    let parts: Vec<_> = input.token.split('.').collect();
    let (version, tail) = match parts.as_slice() {
        [one] if input.spawn_call_id.is_none() && input.runtime_session_id.is_none() => {
            let Some(tail) = one.strip_prefix("appa-") else {
                return false;
            };
            ("v1", tail)
        }
        [first, tail]
            if input.runtime_session_id.is_none()
                && first.strip_prefix("appa2-").and_then(decode).as_ref()
                    == input.spawn_call_id.as_ref()
                && input.spawn_call_id.is_some() =>
        {
            ("v2", *tail)
        }
        [first, runtime, tail]
            if input.spawn_call_id.is_some()
                && input.runtime_session_id.is_some()
                && first.strip_prefix("appa3-").and_then(decode).as_ref()
                    == input.spawn_call_id.as_ref()
                && decode(runtime).as_ref() == input.runtime_session_id.as_ref() =>
        {
            ("v3", *tail)
        }
        _ => return false,
    };
    if tail.len() != 40
        || !tail
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return false;
    }
    let (nonce, tag) = tail.split_at(16);
    if let Some(token) = &input.receipt_token {
        let Some((payload, tag)) = token
            .strip_prefix("appact2-")
            .and_then(|token| token.split_once('.'))
        else {
            return false;
        };
        if !matches_hex(
            &derive(root, RECEIPT_DOMAIN),
            &format!("{RECEIPT_DOMAIN}\n{payload}"),
            tag,
            32,
        ) {
            return false;
        }
        let Ok(contents) = URL_SAFE_NO_PAD.decode(payload) else {
            return false;
        };
        let Ok(claims) = serde_json::from_slice::<Vec<serde_json::Value>>(&contents) else {
            return false;
        };
        let field = |index: usize| claims.get(index).and_then(serde_json::Value::as_str);
        if contents.len() > 16 * 1024
            || field(1) != Some(input.organization_id.as_str())
            || field(2) != input.caller_id.as_deref()
            || field(3) != Some(input.parent_id.as_str())
            || field(6) != Some(input.spawner_native_id.as_str())
            || field(7) != input.spawn_call_id.as_deref()
        {
            return false;
        }
    }
    let key = derive(root, "archestra.appa.delegation.v1");
    let verify_digest = |digest| {
        let mut values = vec![
            version,
            &input.organization_id,
            input.caller_id.as_deref().unwrap_or(""),
            &input.parent_id,
            &input.spawner_native_id,
            digest,
        ];
        values.extend(input.spawn_call_id.as_deref());
        values.extend(input.runtime_session_id.as_deref());
        values.push(nonce);
        serde_json::to_string(&values).is_ok_and(|text| matches_hex(&key, &text, tag, 12))
    };
    verify_digest(&input.prompt_digest)
        || (input.receipt_token.is_some() && verify_digest(EMPTY_PROMPT))
}

fn derive(key: &hmac::Key, label: &str) -> hmac::Key {
    hmac::Key::new(
        hmac::HMAC_SHA256,
        hmac::sign(key, label.as_bytes()).as_ref(),
    )
}

fn matches_hex(key: &hmac::Key, text: &str, tag: &str, bytes: usize) -> bool {
    let expected: String = hmac::sign(key, text.as_bytes()).as_ref()[..bytes]
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    expected.as_bytes().ct_eq(tag.as_bytes()).into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn structured_attachment_preserves_items_and_binds_call() {
        let key = hmac::Key::new(hmac::HMAC_SHA256, b"fixture");
        let nonce = "0000000000000000";
        let signed = serde_json::to_string(&[
            "v2",
            "org",
            "",
            "parent",
            "spawner",
            EMPTY_PROMPT,
            "call",
            nonce,
        ])
        .unwrap();
        let tag: String = hmac::sign(
            &derive(&key, "archestra.appa.delegation.v1"),
            signed.as_bytes(),
        )
        .as_ref()[..12]
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        let item = serde_json::json!({
            "type": "text",
            "text": format!("[appa] delegated trajectory appa2-{}.{nonce}{tag} — child of parent.", URL_SAFE_NO_PAD.encode("call")),
        });
        let check = |first, id| {
            attachment(
                &key,
                serde_json::from_value(serde_json::json!({
                    "before": {"messages":[{"type":"text","text":"approved"}]},
                    "after": {"messages":[{"type":"text","text":first}, item]},
                    "field": "messages",
                    "appended": item,
                    "organizationId": "org",
                    "id": id,
                    "name": "delegate",
                    "binding": {"spawnerNativeId":"spawner"}
                }))
                .unwrap(),
            )
        };
        assert_eq!(check("approved", "call"), Verdict::Authorized);
        assert_eq!(check("changed", "call"), Verdict::Denied);
        assert_eq!(check("approved", "other-call"), Verdict::Denied);
    }

    #[test]
    fn continuation_requires_a_matching_signed_receipt() {
        let key = hmac::Key::new(hmac::HMAC_SHA256, b"fixture");
        let tag = |key: &hmac::Key, payload: &str, length| {
            hmac::sign(key, payload.as_bytes()).as_ref()[..length]
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>()
        };
        let nonce = "0000000000000000";
        let signed = serde_json::to_string(&[
            "v2",
            "org",
            "",
            "parent",
            "spawner",
            EMPTY_PROMPT,
            "call",
            nonce,
        ])
        .unwrap();
        let token = format!(
            "appa2-{}.{}{}",
            URL_SAFE_NO_PAD.encode("call"),
            nonce,
            tag(&derive(&key, "archestra.appa.delegation.v1"), &signed, 12)
        );
        let receipt = |spawner| {
            let payload = URL_SAFE_NO_PAD.encode(
                serde_json::json!([2, "org", null, "parent", "child", null, spawner, "call"])
                    .to_string(),
            );
            format!(
                "appact2-{payload}.{}",
                tag(
                    &derive(&key, RECEIPT_DOMAIN),
                    &format!("{RECEIPT_DOMAIN}\n{payload}"),
                    32
                )
            )
        };
        let mut request = Request {
            token,
            organization_id: "org".into(),
            caller_id: None,
            parent_id: "parent".into(),
            spawner_native_id: "spawner".into(),
            prompt_digest: "different digest".into(),
            spawn_call_id: Some("call".into()),
            runtime_session_id: None,
            receipt_token: None,
        };
        assert!(!valid(&key, &request));
        request.receipt_token = Some(receipt("different spawner"));
        assert!(!valid(&key, &request));
        request.receipt_token = Some(receipt("spawner"));
        assert!(valid(&key, &request));
        request.receipt_token.as_mut().unwrap().push('a');
        assert!(!valid(&key, &request));
    }
}
