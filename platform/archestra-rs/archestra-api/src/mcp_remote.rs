use axum::{
    Json, Router,
    body::Body,
    extract::{DefaultBodyLimit, State},
    http::{HeaderMap, HeaderName, HeaderValue, StatusCode},
    response::Response,
    routing::post,
};
use reqwest::{Client, Url};
use serde::Deserialize;
use serde_json::Value;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Call {
    url: UrlString,
    headers: Vec<(String, String)>,
    body: String,
}

#[derive(Deserialize)]
struct UrlString(String);

pub(crate) fn router() -> Result<Router, reqwest::Error> {
    let client = Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .build()?;
    Ok(Router::new()
        .route("/internal/v1/mcp/remote-call", post(call))
        .layer(DefaultBodyLimit::max(144 * 1024 * 1024))
        .with_state(client))
}

async fn call(
    State(client): State<Client>,
    Json(input): Json<Call>,
) -> Result<Response, StatusCode> {
    // This is the catalog URL already admitted by the gateway's egress policy.
    let url = Url::parse(&input.url.0).map_err(|_| StatusCode::BAD_REQUEST)?;
    let request: Value = serde_json::from_str(&input.body).map_err(|_| StatusCode::BAD_REQUEST)?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || request["method"] != "tools/call"
        || request["jsonrpc"] != "2.0"
        || !(request["id"].is_number() || request["id"].is_string())
    {
        return Err(StatusCode::BAD_REQUEST);
    }
    let mut headers = HeaderMap::new();
    for (name, value) in input.headers {
        let name = HeaderName::try_from(name).map_err(|_| StatusCode::BAD_REQUEST)?;
        match name.as_str() {
            "host"
            | "connection"
            | "content-length"
            | "transfer-encoding"
            | "keep-alive"
            | "upgrade"
            | "te"
            | "trailer"
            | "proxy-authorization" => continue,
            _ => headers.append(
                name,
                HeaderValue::try_from(value).map_err(|_| StatusCode::BAD_REQUEST)?,
            ),
        };
    }
    let sigv4 = headers
        .get("authorization")
        .is_some_and(|value| value.as_bytes().starts_with(b"AWS4-HMAC-SHA256 "));
    if sigv4 {
        headers
            .entry("accept-encoding")
            .or_insert(HeaderValue::from_static("identity"));
    } else {
        headers.insert("accept-encoding", HeaderValue::from_static("identity"));
    }
    let upstream = client
        .post(url)
        .headers(headers)
        .body(input.body)
        .send()
        .await
        .map_err(|_| StatusCode::BAD_GATEWAY)?;
    if upstream.status().is_redirection()
        || upstream
            .headers()
            .get("content-encoding")
            .is_some_and(|v| v != "identity")
    {
        return Err(StatusCode::BAD_GATEWAY);
    }
    let mut reply =
        Response::builder().header("x-archestra-upstream-status", upstream.status().as_str());
    for name in ["content-type", "www-authenticate", "mcp-session-id"] {
        for value in upstream.headers().get_all(name) {
            reply = reply.header(name, value);
        }
    }
    reply
        .body(Body::from_stream(upstream.bytes_stream()))
        .map_err(|_| StatusCode::BAD_GATEWAY)
}
