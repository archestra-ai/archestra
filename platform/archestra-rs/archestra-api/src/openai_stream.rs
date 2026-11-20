use std::{io, time::Duration};

use crate::openai_sse;
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

const STATUS_HEADER: &str = "x-archestra-upstream-status";
const FRAMES_HEADER: &str = "x-archestra-openai-frames";

#[derive(Clone)]
pub(crate) struct Upstream {
    client: Client,
    target: Url,
}

impl Upstream {
    pub(crate) fn from_env() -> Result<Option<Self>, Box<dyn std::error::Error>> {
        if std::env::var("ARCHESTRA_LLM_PROXY_RUST_OPENAI_STREAM_ENABLED").as_deref() != Ok("true")
        {
            return Ok(None);
        }
        let base = std::env::var("ARCHESTRA_OPENAI_BASE_URL")
            .unwrap_or_else(|_| "https://api.openai.com/v1".to_owned());
        let mut target =
            Url::parse(&base).map_err(|_| io::Error::other("invalid OpenAI base URL"))?;
        let official = target.scheme() == "https"
            && target.host_str() == Some("api.openai.com")
            && target.port().is_none()
            && target.path().trim_end_matches('/') == "/v1";
        let loopback =
            target.scheme() == "http" && matches!(target.host_str(), Some("127.0.0.1" | "[::1]"));
        if !(official || loopback)
            || !target.username().is_empty()
            || target.password().is_some()
            || target.query().is_some()
            || target.fragment().is_some()
        {
            return Err(io::Error::other(
                "Rust OpenAI transport requires the official or a loopback base URL",
            )
            .into());
        }
        target.set_path(&format!(
            "{}/chat/completions",
            target.path().trim_end_matches('/')
        ));
        let client = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .no_proxy()
            .connect_timeout(Duration::from_secs(10))
            .read_timeout(Duration::from_secs(300))
            .build()?;
        Ok(Some(Self { client, target }))
    }
}

pub(crate) fn router(upstream: Upstream) -> Router {
    Router::new()
        .route(
            "/internal/v1/openai/terminal-sse",
            post(openai_sse::terminal),
        )
        .route("/internal/v1/openai/chat-stream", post(stream))
        .layer(DefaultBodyLimit::max(144 * 1024 * 1024))
        .with_state(upstream)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    url: String,
    headers: Vec<(String, String)>,
    body: String,
}

async fn stream(
    State(upstream): State<Upstream>,
    Json(request): Json<Request>,
) -> Result<Response, StatusCode> {
    // Never let request input select an egress destination or follow redirects.
    if request.url != upstream.target.as_str() {
        return Err(StatusCode::BAD_REQUEST);
    }
    let mut headers = HeaderMap::new();
    for (name, value) in request.headers {
        let name = HeaderName::try_from(name).map_err(|_| StatusCode::BAD_REQUEST)?;
        if !is_transport_header(&name) && name != "accept-encoding" {
            headers.append(
                name,
                HeaderValue::try_from(value).map_err(|_| StatusCode::BAD_REQUEST)?,
            );
        }
    }
    headers.insert("accept-encoding", HeaderValue::from_static("identity"));
    let response = upstream
        .client
        .post(upstream.target)
        .headers(headers)
        .body(request.body)
        .send()
        .await
        .map_err(|_| StatusCode::BAD_GATEWAY)?;
    let status = response.status();
    if status.is_redirection()
        || response
            .headers()
            .get("content-encoding")
            .is_some_and(|value| value != "identity")
    {
        return Err(StatusCode::BAD_GATEWAY);
    }
    let mut output = Response::builder()
        .status(StatusCode::OK)
        .header(STATUS_HEADER, status.as_str());
    let framed = status.is_success() && !matches!(status.as_u16(), 204 | 205);
    for (name, value) in response.headers() {
        if !is_transport_header(name)
            && name != STATUS_HEADER
            && name != FRAMES_HEADER
            && !(framed && (name == "content-type" || name == "content-encoding"))
        {
            output = output.header(name, value);
        }
    }
    let body = if framed {
        output = output
            .header(FRAMES_HEADER, "1")
            .header("content-type", "application/x-ndjson");
        openai_sse::decode(response)
    } else {
        Body::from_stream(response.bytes_stream())
    };
    output.body(body).map_err(|_| StatusCode::BAD_GATEWAY)
}

fn is_transport_header(name: &HeaderName) -> bool {
    matches!(
        name.as_str(),
        "connection"
            | "keep-alive"
            | "content-length"
            | "transfer-encoding"
            | "upgrade"
            | "proxy-authenticate"
            | "proxy-authorization"
            | "host"
            | "te"
            | "trailer"
    )
}
