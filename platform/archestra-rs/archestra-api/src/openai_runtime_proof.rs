use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, State},
    routing::post,
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use ring::{digest, hmac};
use serde::Deserialize;
use std::collections::BTreeMap;
use time::OffsetDateTime;

type Key = Option<hmac::Key>;

pub(crate) fn router() -> Router {
    Router::new()
        .route("/internal/v1/openai/runtime-proof", post(verify))
        .route(
            "/internal/v1/openai/runtime-proof-attachment",
            post(verify_attachment),
        )
        .layer(DefaultBodyLimit::max(72 * 1024 * 1024))
        .with_state(signing_key())
}

pub(crate) fn signing_key() -> Key {
    let secret = std::env::var("ARCHESTRA_OPENAPPA_OFFER_SIGNING_SECRET")
        .ok()
        .filter(|value| !value.is_empty())
        .or_else(|| {
            let auth = std::env::var("ARCHESTRA_AUTH_SESSION_SECRET")
                .ok()
                .map(|value| value.trim().to_owned())
                .filter(|value| !value.is_empty())
                .or_else(|| {
                    std::env::var("ARCHESTRA_AUTH_SECRET")
                        .ok()
                        .filter(|value| !value.is_empty())
                })?;
            let key = hmac::Key::new(hmac::HMAC_SHA256, auth.as_bytes());
            Some(URL_SAFE_NO_PAD.encode(hmac::sign(&key, b"archestra.openappa.offer-signing.v1")))
        });
    secret.map(|value| hmac::Key::new(hmac::HMAC_SHA256, value.as_bytes()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    proof: String,
    organization_id: String,
    caller_id: Option<String>,
    session_id: String,
    parent_id: Option<String>,
    call_id: String,
    action: String,
    arguments: String,
    spawn: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Attachment {
    before: Snapshot,
    after: Snapshot,
    binding: Request,
}

#[derive(Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Wrapper {
    envelope: String,
    form: ArgumentForm,
}

#[derive(Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
enum ArgumentForm {
    Object,
    String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Snapshot {
    wrapper: Option<Wrapper>,
    fields: BTreeMap<String, String>,
}

async fn verify_attachment(State(key): State<Key>, Json(input): Json<Attachment>) -> Json<bool> {
    Json(key.as_ref().is_some_and(|key| {
        valid_attachment(input, key, OffsetDateTime::now_utc().unix_timestamp())
    }))
}

fn valid_attachment(mut input: Attachment, key: &hmac::Key, now: i64) -> bool {
    if input.before.wrapper != input.after.wrapper
        || input.before.fields.contains_key("runtime_proof")
    {
        return false;
    }
    let Some(encoded) = input.after.fields.remove("runtime_proof") else {
        return false;
    };
    let Ok(proof) = serde_json::from_str::<String>(&encoded) else {
        return false;
    };
    input.binding.proof = proof;
    input.before.fields == input.after.fields && valid(key, &input.binding, now)
}

#[derive(Deserialize)]
#[serde(transparent)]
struct NullableString(Option<String>);

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Claims {
    v: u8,
    organization_id: String,
    caller_id: NullableString,
    session_id: String,
    parent_id: NullableString,
    call_id: String,
    action: String,
    arguments_hash: String,
    spawn: bool,
    #[serde(rename = "observed", default, deserialize_with = "observed")]
    _observed: bool,
    iat: i64,
    exp: i64,
}

fn observed<'de, D: serde::Deserializer<'de>>(input: D) -> Result<bool, D::Error> {
    bool::deserialize(input).and_then(|value| {
        if value {
            Ok(true)
        } else {
            Err(serde::de::Error::custom("expected true"))
        }
    })
}

async fn verify(State(key): State<Key>, Json(request): Json<Request>) -> Json<bool> {
    Json(
        key.as_ref()
            .is_some_and(|key| valid(key, &request, OffsetDateTime::now_utc().unix_timestamp())),
    )
}

fn valid(key: &hmac::Key, request: &Request, now: i64) -> bool {
    if request.proof.len() > 16_384 {
        return false;
    }
    let Some((payload, mac)) = request.proof.split_once('.') else {
        return false;
    };
    let Ok(mac) = URL_SAFE_NO_PAD.decode(mac) else {
        return false;
    };
    if hmac::verify(
        key,
        format!("archestra.appa.runtime-tool.v1.{payload}").as_bytes(),
        &mac,
    )
    .is_err()
    {
        return false;
    }
    let Ok(payload) = URL_SAFE_NO_PAD.decode(payload) else {
        return false;
    };
    let Ok(claims) = serde_json::from_slice::<Claims>(&payload) else {
        return false;
    };
    let bounded = |value: &str, max| !value.is_empty() && value.encode_utf16().count() <= max;
    claims.v == 1
        && claims.iat >= 0
        && claims.iat <= now + 30
        && claims.exp > now
        && claims.iat.checked_add(300) == Some(claims.exp)
        && bounded(&claims.organization_id, 512)
        && claims.organization_id == request.organization_id
        && claims
            .caller_id
            .0
            .as_ref()
            .is_none_or(|id| bounded(id, 1024))
        && claims.caller_id.0 == request.caller_id
        && bounded(&claims.session_id, 2048)
        && claims.session_id == request.session_id
        && claims
            .parent_id
            .0
            .as_ref()
            .is_none_or(|id| bounded(id, 2048))
        && claims.parent_id.0 == request.parent_id
        && bounded(&claims.call_id, 256)
        && claims.call_id == request.call_id
        && bounded(&claims.action, 512)
        && claims.action == request.action
        && claims.spawn == request.spawn
        && claims.arguments_hash
            == digest::digest(&digest::SHA256, request.arguments.as_bytes())
                .as_ref()
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn signature_binds_claims_and_expires() {
        let key = hmac::Key::new(hmac::HMAC_SHA256, b"fixture signing key");
        let claims = json!({
            "v": 1, "organization_id": "org", "caller_id": null, "session_id": "session",
            "parent_id": "parent", "call_id": "call", "action": "lookup",
            "arguments_hash": "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
            "spawn": false, "iat": 100, "exp": 400
        });
        let payload = URL_SAFE_NO_PAD.encode(claims.to_string());
        let signature = hmac::sign(
            &key,
            format!("archestra.appa.runtime-tool.v1.{payload}").as_bytes(),
        );
        let mut request = Request {
            proof: format!("{payload}.{}", URL_SAFE_NO_PAD.encode(signature)),
            organization_id: "org".into(),
            caller_id: None,
            session_id: "session".into(),
            parent_id: Some("parent".into()),
            call_id: "call".into(),
            action: "lookup".into(),
            arguments: "{}".into(),
            spawn: false,
        };
        assert!(valid(&key, &request, 100));
        assert!(!valid(&key, &request, 69));
        assert!(!valid(&key, &request, 400));
        request.arguments = r#"{"extra":true}"#.into();
        assert!(!valid(&key, &request, 100));
        request.arguments = "{}".into();
        request.call_id = "different".into();
        assert!(!valid(&key, &request, 100));
        request.call_id = "call".into();
        request.proof.push('a');
        assert!(!valid(&key, &request, 100));
    }

    #[test]
    fn signed_attachment_cannot_change_the_wrapper_or_other_arguments() {
        let key = hmac::Key::new(hmac::HMAC_SHA256, b"fixture signing key");
        let claims = json!({
            "v": 1, "organization_id": "org", "caller_id": null, "session_id": "session",
            "parent_id": null, "call_id": "call", "action": "lookup",
            "arguments_hash": "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
            "spawn": false, "iat": 100, "exp": 400
        });
        let payload = URL_SAFE_NO_PAD.encode(claims.to_string());
        let mac = hmac::sign(
            &key,
            format!("archestra.appa.runtime-tool.v1.{payload}").as_bytes(),
        );
        let proof = json!(format!(
            "{payload}.{}",
            URL_SAFE_NO_PAD.encode(mac.as_ref())
        ))
        .to_string();
        let check = |form, envelope, extra| {
            let mut fields = BTreeMap::from([("runtime_proof".into(), proof.clone())]);
            if extra {
                fields.insert("note".into(), r#""other""#.into());
            }
            valid_attachment(
                Attachment {
                    before: Snapshot {
                        wrapper: Some(Wrapper {
                            form: ArgumentForm::String,
                            envelope: "lookup".into(),
                        }),
                        fields: BTreeMap::new(),
                    },
                    after: Snapshot {
                        wrapper: Some(Wrapper { form, envelope }),
                        fields,
                    },
                    binding: serde_json::from_value(json!({
                        "proof": "", "organizationId": "org", "sessionId": "session",
                        "callId": "call", "action": "lookup", "arguments": "{}", "spawn": false
                    }))
                    .unwrap(),
                },
                &key,
                100,
            )
        };
        assert!(check(ArgumentForm::String, "lookup".into(), false));
        assert!(!check(ArgumentForm::Object, "lookup".into(), false));
        assert!(!check(ArgumentForm::String, "other".into(), false));
        assert!(!check(ArgumentForm::String, "lookup".into(), true));
    }
}
