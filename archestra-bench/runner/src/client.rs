use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use base64::{Engine as _, engine::general_purpose};
use futures::Stream;
use reqwest::redirect::Policy;
use reqwest::{Client, ClientBuilder, Method};
use serde::Serialize;
use serde_json::Value as JsonValue;
use tokio::sync::Mutex;
use tokio::time::{Duration, sleep, timeout};
use tracing::info;

use crate::chat_stream;
use crate::config::types::ToolExposureMode;
use crate::elicitation::{ElicitationAnswer, ElicitationParse, answer_for, parse_elicitation_event};

const DEFAULT_CHAT_TIMEOUT_S: f64 = 1800.0;

/// Sampling temperature pinned on every benchmark chat request. Greedy decoding (`0.0`) is the main
/// lever against run-to-run variance — see the reproducibility notes in the repo README.
pub(crate) const BENCH_TEMPERATURE: f32 = 0.0;

#[derive(Debug, Clone)]
pub struct ArchestraApiError {
    pub method: String,
    pub url: String,
    pub status: u16,
    pub body: String,
}

impl std::fmt::Display for ArchestraApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{} {} -> {}: {}",
            self.method, self.url, self.status, self.body
        )
    }
}

impl std::error::Error for ArchestraApiError {}

#[derive(Debug, Clone)]
pub struct ContractError(pub String);

impl std::fmt::Display for ContractError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "contract error: {}", self.0)
    }
}

impl std::error::Error for ContractError {}

#[derive(Debug, Clone)]
pub enum ClientError {
    Api(ArchestraApiError),
    Contract(ContractError),
    Config(String),
    /// A terminal readiness failure that retrying cannot clear (the sandbox is disabled/unreachable).
    /// Distinct from `Config` so callers fast-fail instead of polling out the readiness deadline.
    SandboxFatal(String),
}

impl std::fmt::Display for ClientError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ClientError::Api(e) => write!(f, "{e}"),
            ClientError::Contract(e) => write!(f, "{e}"),
            ClientError::Config(s) => write!(f, "config error: {s}"),
            ClientError::SandboxFatal(s) => write!(f, "{s}"),
        }
    }
}

impl std::error::Error for ClientError {}

impl From<ArchestraApiError> for ClientError {
    fn from(e: ArchestraApiError) -> Self {
        ClientError::Api(e)
    }
}

impl From<ContractError> for ClientError {
    fn from(e: ContractError) -> Self {
        ClientError::Contract(e)
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentCreate {
    pub name: String,
    pub scope: String,
    #[serde(rename = "agentType")]
    pub agent_type: String,
    #[serde(rename = "systemPrompt", skip_serializing_if = "Option::is_none")]
    pub system_prompt: Option<String>,
    #[serde(rename = "toolExposureMode")]
    pub tool_exposure_mode: ToolExposureMode,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub teams: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CatalogCreate {
    pub name: String,
    #[serde(rename = "serverType")]
    pub server_type: String,
    pub scope: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(rename = "serverUrl", skip_serializing_if = "Option::is_none")]
    pub server_url: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct LlmKeyCreate {
    pub provider: String,
    pub scope: String,
    #[serde(rename = "apiKey")]
    pub api_key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(rename = "baseUrl", skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    #[serde(rename = "isPrimary", skip_serializing_if = "Option::is_none")]
    pub is_primary: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ToolAssignment {
    #[serde(rename = "agentId")]
    pub agent_id: String,
    #[serde(rename = "toolId")]
    pub tool_id: String,
}

#[derive(Debug, Clone)]
pub struct FilePart {
    pub filename: String,
    pub mime_type: String,
    pub data: Vec<u8>,
}

impl FilePart {
    fn to_data_url_part(&self) -> JsonValue {
        let b64 = general_purpose::STANDARD.encode(&self.data);
        serde_json::json!({
            "type": "file",
            "url": format!("data:{};base64,{}", self.mime_type, b64),
            "filename": self.filename,
            "mediaType": self.mime_type,
        })
    }
}

#[derive(Clone)]
pub struct EvalClient {
    base_url: String,
    http: Client,
    auth: Arc<Mutex<Option<String>>>,
    timeout_secs: Arc<AtomicU64>,
}

impl EvalClient {
    pub fn new(base_url: impl Into<String>, api_key: Option<String>) -> Self {
        let base_url = base_url.into().trim_end_matches('/').to_string();
        let http = ClientBuilder::new()
            .redirect(Policy::none())
            .cookie_store(true)
            .build()
            .expect("reqwest client builds");
        Self {
            base_url,
            http,
            auth: Arc::new(Mutex::new(api_key)),
            timeout_secs: Arc::new(AtomicU64::new(30)),
        }
    }

    pub fn new_with_timeout(
        base_url: impl Into<String>,
        api_key: Option<String>,
        timeout: Duration,
    ) -> Self {
        let client = Self::new(base_url, api_key);
        client.set_timeout(timeout);
        client
    }

    pub async fn sibling(&self) -> Self {
        let auth = self.auth.lock().await.clone();
        Self::new_with_timeout(self.base_url.clone(), auth, self.timeout())
    }

    fn timeout(&self) -> Duration {
        Duration::from_secs(self.timeout_secs.load(Ordering::SeqCst))
    }

    fn set_timeout(&self, timeout: Duration) {
        self.timeout_secs
            .store(timeout.as_secs().max(1), Ordering::SeqCst);
    }

    fn url(&self, path: &str, params: Option<&[(String, String)]>) -> String {
        let mut url = if path.starts_with("http://") || path.starts_with("https://") {
            path.to_string()
        } else {
            format!("{}/{}", self.base_url, path.trim_start_matches('/'))
        };
        if let Some(params) = params {
            let query = url::form_urlencoded::Serializer::new(String::new())
                .extend_pairs(params)
                .finish();
            if !query.is_empty() {
                url.push('?');
                url.push_str(&query);
            }
        }
        url
    }

    async fn request(
        &self,
        method: Method,
        path: &str,
        params: Option<&[(String, String)]>,
        body: Option<&JsonValue>,
    ) -> Result<JsonValue, ArchestraApiError> {
        let url = self.url(path, params);
        let mut req = self
            .http
            .request(method.clone(), &url)
            .header("Accept-Encoding", "identity");

        let auth = self.auth.lock().await.clone();
        if let Some(key) = auth {
            req = req.header("Authorization", key);
        }

        if let Some(body) = body {
            req = req.json(body);
        }

        let resp = match timeout(self.timeout(), req.send()).await {
            Ok(Ok(resp)) => resp,
            Ok(Err(e)) => {
                return Err(ArchestraApiError {
                    method: method.to_string(),
                    url,
                    status: 0,
                    body: format!("{e}"),
                });
            }
            Err(_) => {
                return Err(ArchestraApiError {
                    method: method.to_string(),
                    url,
                    status: 0,
                    body: "request timed out".to_string(),
                });
            }
        };

        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        if status.is_success() {
            if text.trim().is_empty() {
                return Ok(JsonValue::Null);
            }
            match serde_json::from_str(&text) {
                Ok(v) => Ok(v),
                Err(e) => Err(ArchestraApiError {
                    method: method.to_string(),
                    url,
                    status: status.as_u16(),
                    body: format!("invalid JSON: {e}: {text}"),
                }),
            }
        } else {
            Err(ArchestraApiError {
                method: method.to_string(),
                url,
                status: status.as_u16(),
                body: text,
            })
        }
    }

    pub async fn wait_ready(
        &self,
        timeout_s: f64,
        interval_s: f64,
    ) -> Result<JsonValue, ClientError> {
        let deadline = tokio::time::Instant::now() + Duration::from_secs_f64(timeout_s);
        let mut last: Option<String>;
        loop {
            match self.request(Method::GET, "ready", None, None).await {
                Ok(body) => {
                    let db_connected =
                        body.get("database").and_then(|v| v.as_str()) == Some("connected");
                    if db_connected {
                        match sandbox_readiness(&body) {
                            SandboxReadiness::Ready => return Ok(body),
                            // The sandbox is terminally broken (disabled/unreachable). Nothing runs a
                            // sandbox command during this poll, so the boot status is frozen and will
                            // not recover — fail now instead of waiting out the deadline. A dedicated
                            // variant (not Config) so the caller's retry loop treats this as terminal.
                            SandboxReadiness::Fatal(reason) => {
                                return Err(ClientError::SandboxFatal(format!(
                                    "{reason} — see backend log"
                                )));
                            }
                            SandboxReadiness::Pending => {
                                last = Some(format!("db connected, sandbox not ready yet: {body}"));
                            }
                        }
                    } else {
                        last = Some(format!("reachable but not connected: {body}"));
                    }
                }
                Err(e) if (400..500).contains(&e.status) => {
                    return Err(ClientError::Api(e));
                }
                Err(e) => {
                    last = Some(e.to_string());
                }
            }
            if tokio::time::Instant::now() >= deadline {
                return Err(ClientError::Config(format!(
                    "archestra not ready after {timeout_s}s; last: {}",
                    last.as_deref().unwrap_or("no response")
                )));
            }
            sleep(Duration::from_secs_f64(interval_s)).await;
        }
    }

    pub async fn sign_in(&self, email: &str, password: &str) -> Result<(), ClientError> {
        require_secure_transport(&self.base_url)?;
        self.request(
            Method::POST,
            "/api/auth/sign-in/email",
            None,
            Some(&serde_json::json!({
                "email": email,
                "password": password,
            })),
        )
        .await?;
        Ok(())
    }

    pub async fn mint_api_key(&self, name: &str) -> Result<String, ClientError> {
        let body = require_dict(
            self.request(
                Method::POST,
                "/api/api-keys",
                None,
                Some(&serde_json::json!({"name": name})),
            )
            .await?,
            "POST /api/api-keys",
        )?;
        let key = require_str_field(&body, "key", "POST /api/api-keys")?;
        *self.auth.lock().await = Some(key.clone());
        Ok(key)
    }

    pub async fn list_agents(
        &self,
        name: Option<&str>,
        scope: Option<&str>,
    ) -> Result<Vec<HashMap<String, JsonValue>>, ClientError> {
        let mut params: Vec<(String, String)> = Vec::new();
        if let Some(name) = name {
            params.push(("name".to_string(), name.to_string()));
        }
        if let Some(scope) = scope {
            params.push(("scope".to_string(), scope.to_string()));
        }
        let params_ref: Vec<(String, String)> = params;
        let slice: &[(String, String)] = &params_ref;
        let body = self
            .request(Method::GET, "/api/agents", Some(slice), None)
            .await?;
        items(body)
    }

    pub async fn create_agent(
        &self,
        payload: &AgentCreate,
    ) -> Result<HashMap<String, JsonValue>, ClientError> {
        require_dict(
            self.request(
                Method::POST,
                "/api/agents",
                None,
                Some(&serde_json::to_value(payload).unwrap()),
            )
            .await?,
            "POST /api/agents",
        )
    }

    pub async fn create_team(&self, name: &str) -> Result<String, ClientError> {
        let body = require_dict(
            self.request(
                Method::POST,
                "/api/teams",
                None,
                Some(&serde_json::json!({"name": name})),
            )
            .await?,
            "POST /api/teams",
        )?;
        require_str_field(&body, "id", "POST /api/teams")
    }

    /// Create a project. Files produced in its conversations are owned by the project rather than the
    /// author; the bench creates one per rollout, so concurrent lanes and successive tasks never
    /// collide on identically named files, and a rollout's stages share one file namespace.
    pub async fn create_project(&self, name: &str) -> Result<String, ClientError> {
        let body = require_dict(
            self.request(
                Method::POST,
                "/api/projects",
                None,
                Some(&serde_json::json!({"name": name})),
            )
            .await?,
            "POST /api/projects",
        )?;
        require_str_field(&body, "id", "POST /api/projects")
    }

    pub async fn list_skills(
        &self,
        search: Option<&str>,
    ) -> Result<Vec<HashMap<String, JsonValue>>, ClientError> {
        let params = search.map(|s| vec![("search".to_string(), s.to_string())]);
        let slice = params.as_deref();
        items(
            self.request(Method::GET, "/api/skills", slice, None)
                .await?,
        )
    }

    pub async fn enable_skill_defaults(&self) -> Result<(), ClientError> {
        self.request(Method::POST, "/api/skills/enable-defaults", None, None)
            .await?;
        Ok(())
    }

    /// Turn off org-wide tool auto-assignment so `search_tools` returns only each agent's *assigned*
    /// tools. Without this, a shared backend's discovery surfaces every lane's sibling `final_answer`
    /// submit server, leaving the model to guess which one is its own.
    pub async fn disable_tool_auto_assignment(&self) -> Result<(), ClientError> {
        self.request(
            Method::PATCH,
            "/api/organization/security-settings",
            None,
            Some(&serde_json::json!({ "allowToolAutoAssignment": false })),
        )
        .await?;
        Ok(())
    }

    pub async fn list_catalog(&self) -> Result<Vec<HashMap<String, JsonValue>>, ClientError> {
        items(
            self.request(Method::GET, "/api/internal_mcp_catalog", None, None)
                .await?,
        )
    }

    pub async fn create_catalog_item(
        &self,
        payload: &CatalogCreate,
    ) -> Result<HashMap<String, JsonValue>, ClientError> {
        require_dict(
            self.request(
                Method::POST,
                "/api/internal_mcp_catalog",
                None,
                Some(&serde_json::to_value(payload).unwrap()),
            )
            .await?,
            "POST /api/internal_mcp_catalog",
        )
    }

    pub async fn list_mcp_servers(
        &self,
        catalog_id: Option<&str>,
    ) -> Result<Vec<HashMap<String, JsonValue>>, ClientError> {
        let params = catalog_id.map(|s| vec![("catalogId".to_string(), s.to_string())]);
        let slice = params.as_deref();
        items(
            self.request(Method::GET, "/api/mcp_server", slice, None)
                .await?,
        )
    }

    pub async fn list_llm_keys(
        &self,
        search: Option<&str>,
        provider: Option<&str>,
    ) -> Result<Vec<HashMap<String, JsonValue>>, ClientError> {
        let mut params: Vec<(String, String)> = Vec::new();
        if let Some(search) = search {
            params.push(("search".to_string(), search.to_string()));
        }
        if let Some(provider) = provider {
            params.push(("provider".to_string(), provider.to_string()));
        }
        let params_ref = params;
        let slice: &[(String, String)] = &params_ref;
        items(
            self.request(Method::GET, "/api/llm-provider-api-keys", Some(slice), None)
                .await?,
        )
    }

    pub async fn create_llm_key(
        &self,
        payload: &LlmKeyCreate,
    ) -> Result<HashMap<String, JsonValue>, ClientError> {
        require_dict(
            self.request(
                Method::POST,
                "/api/llm-provider-api-keys",
                None,
                Some(&serde_json::to_value(payload).unwrap()),
            )
            .await?,
            "POST /api/llm-provider-api-keys",
        )
    }

    pub async fn list_tools(
        &self,
        search: Option<&str>,
    ) -> Result<Vec<HashMap<String, JsonValue>>, ClientError> {
        let params = search.map(|s| vec![("search".to_string(), s.to_string())]);
        let slice = params.as_deref();
        items(self.request(Method::GET, "/api/tools", slice, None).await?)
    }

    pub async fn bulk_assign_tools(
        &self,
        assignments: &[ToolAssignment],
    ) -> Result<HashMap<String, JsonValue>, ClientError> {
        let body = serde_json::json!({ "assignments": assignments });
        require_dict(
            self.request(
                Method::POST,
                "/api/agents/tools/bulk-assign",
                None,
                Some(&body),
            )
            .await?,
            "POST /api/agents/tools/bulk-assign",
        )
    }

    pub async fn list_agent_tools(
        &self,
        agent_id: &str,
    ) -> Result<Vec<HashMap<String, JsonValue>>, ClientError> {
        items(
            self.request(
                Method::GET,
                &format!("/api/agents/{agent_id}/tools"),
                None,
                None,
            )
            .await?,
        )
    }

    pub async fn unassign_tool(&self, agent_id: &str, tool_id: &str) -> Result<(), ClientError> {
        self.request(
            Method::DELETE,
            &format!("/api/agents/{agent_id}/tools/{tool_id}"),
            None,
            None,
        )
        .await?;
        Ok(())
    }

    pub async fn get_json(&self, path: &str) -> Result<JsonValue, ClientError> {
        self.request(Method::GET, path, None, None)
            .await
            .map_err(ClientError::Api)
    }

    /// Auto-answer an MCP elicitation carried by a chat stream event, if the event is one. A tool
    /// that elicits mid-call blocks server-side until this POST answers it, and no human watches a
    /// benchmark stream. A non-elicitation event is a no-op; an answer POST that fails returns `Err`
    /// so the caller can fail the stage rather than wait out the backend's 10-minute timeout.
    pub async fn answer_if_elicitation(
        &self,
        event: &HashMap<String, JsonValue>,
    ) -> Result<(), ClientError> {
        let req = match parse_elicitation_event(event) {
            ElicitationParse::NotElicitation => return Ok(()),
            // A `data-mcp-elicitation` event we can't answer would otherwise leave the tool blocked
            // for 10 minutes; surface it instead of silently ignoring it.
            ElicitationParse::Malformed => {
                return Err(ContractError(
                    "unanswerable data-mcp-elicitation event: missing id/conversationId".to_string(),
                )
                .into());
            }
            ElicitationParse::Request(req) => req,
        };
        let answer = answer_for(&req);
        self.resolve_elicitation(&req.id, &req.conversation_id, &answer)
            .await?;
        info!(
            "auto-answered MCP elicitation {} ({:?}) with {}",
            req.id,
            req.mode,
            answer.action.as_wire()
        );
        Ok(())
    }

    /// POST the answer to `/api/chat/elicitation/:id`. The backend caches the response for its
    /// 10-minute poll window, so a very early POST is still consumed.
    pub(crate) async fn resolve_elicitation(
        &self,
        id: &str,
        conversation_id: &str,
        answer: &ElicitationAnswer,
    ) -> Result<(), ClientError> {
        let mut body = serde_json::json!({
            "conversationId": conversation_id,
            "action": answer.action.as_wire(),
        });
        if let Some(content) = &answer.content {
            body["content"] = JsonValue::Object(content.clone());
        }
        self.request(
            Method::POST,
            &format!("/api/chat/elicitation/{id}"),
            None,
            Some(&body),
        )
        .await?;
        Ok(())
    }

    pub async fn create_conversation(
        &self,
        agent_id: &str,
        title: Option<&str>,
        model_id: Option<&str>,
        chat_api_key_id: Option<&str>,
        project_id: Option<&str>,
    ) -> Result<HashMap<String, JsonValue>, ClientError> {
        let mut body = serde_json::Map::new();
        body.insert(
            "agentId".to_string(),
            JsonValue::String(agent_id.to_string()),
        );
        if let Some(project_id) = project_id {
            body.insert(
                "projectId".to_string(),
                JsonValue::String(project_id.to_string()),
            );
        }
        if let Some(title) = title {
            body.insert("title".to_string(), JsonValue::String(title.to_string()));
        }
        if let Some(model_id) = model_id {
            body.insert(
                "modelId".to_string(),
                JsonValue::String(model_id.to_string()),
            );
        }
        if let Some(chat_api_key_id) = chat_api_key_id {
            body.insert(
                "chatApiKeyId".to_string(),
                JsonValue::String(chat_api_key_id.to_string()),
            );
        }
        require_dict(
            self.request(
                Method::POST,
                "/api/chat/conversations",
                None,
                Some(&JsonValue::Object(body)),
            )
            .await?,
            "POST /api/chat/conversations",
        )
    }

    /// Fetch a conversation's persisted messages in UI-message shape (`{id, role, parts, ...}`).
    /// The platform chat route is request-body-authoritative — it never backfills history from the
    /// DB — so callers must resend these on follow-up turns to preserve context across stages.
    pub async fn get_conversation_messages(
        &self,
        conversation_id: &str,
    ) -> Result<Vec<JsonValue>, ClientError> {
        let body = self
            .get_json(&format!("/api/chat/conversations/{conversation_id}"))
            .await?;
        Ok(body
            .get("messages")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default())
    }

    /// All persisted LLM-proxy interactions for a chat session (the chat route sets the interaction
    /// `sessionId` to the conversation id), in chronological order. Used post-run to recover the
    /// effective prompt the model received. Pages the capped API and waits out the write race: the
    /// proxy persists each row in a `finally` after the chat stream ends, so a naive single fetch
    /// can miss the last call.
    pub async fn fetch_session_interactions(
        &self,
        session_id: &str,
    ) -> Result<Vec<JsonValue>, ClientError> {
        const PAGE: usize = 100;
        const MAX_REFETCH: usize = 5;
        // The total can keep growing while we page (the proxy is still flushing rows), so settle on a
        // stable count, page it fully, then re-verify the count did not move under us; retry if it did.
        for _ in 0..MAX_REFETCH {
            let total = self.stable_interaction_total(session_id).await?;
            let mut all: Vec<JsonValue> = Vec::with_capacity(total);
            while all.len() < total {
                let (page, _) = self.interactions_page(session_id, PAGE, all.len()).await?;
                if page.is_empty() {
                    return Err(ContractError(format!(
                        "GET /api/interactions: pagination gap for session {session_id}: got {} of {total} rows",
                        all.len()
                    ))
                    .into());
                }
                all.extend(page);
            }
            let (_, total_after) = self.interactions_page(session_id, 1, 0).await?;
            if total_after == all.len() {
                return Ok(all);
            }
        }
        Err(ContractError(format!(
            "GET /api/interactions: interaction count for session {session_id} never stabilized"
        ))
        .into())
    }

    /// Poll the interaction count with the cheapest possible query until it holds steady across several
    /// consecutive samples, so a row the proxy is still flushing (it persists each in a `finally` after
    /// the stream ends) is not missed by a single lucky-quiet read.
    async fn stable_interaction_total(&self, session_id: &str) -> Result<usize, ClientError> {
        const NEEDED_STABLE: usize = 3;
        const MAX_ATTEMPTS: usize = 20;
        const INTERVAL: Duration = Duration::from_millis(300);
        let (_, mut prev) = self.interactions_page(session_id, 1, 0).await?;
        let mut stable = 1;
        for _ in 0..MAX_ATTEMPTS {
            sleep(INTERVAL).await;
            let (_, current) = self.interactions_page(session_id, 1, 0).await?;
            if current == prev {
                stable += 1;
                if stable >= NEEDED_STABLE {
                    return Ok(current);
                }
            } else {
                stable = 1;
                prev = current;
            }
        }
        Ok(prev)
    }

    async fn interactions_page(
        &self,
        session_id: &str,
        limit: usize,
        offset: usize,
    ) -> Result<(Vec<JsonValue>, usize), ClientError> {
        let params = [
            ("sessionId".to_string(), session_id.to_string()),
            ("limit".to_string(), limit.to_string()),
            ("offset".to_string(), offset.to_string()),
            ("sortBy".to_string(), "createdAt".to_string()),
            ("sortDirection".to_string(), "asc".to_string()),
        ];
        // Post-run enrichment polls this endpoint repeatedly while many rollouts hammer the same
        // backend, so a transient transport failure (timeout / dropped connection, surfaced as
        // status 0) is expected under load. Retry those with linear backoff so one slow poll does
        // not abort the whole interaction capture; genuine HTTP errors propagate immediately.
        // Up to this many retries on top of the initial request (so 5 total attempts at worst).
        const MAX_TRANSIENT_RETRIES: u32 = 4;
        const RETRY_BACKOFF: Duration = Duration::from_millis(500);
        let mut attempt = 0u32;
        let body = loop {
            match self
                .request(Method::GET, "/api/interactions", Some(&params), None)
                .await
            {
                Ok(body) => break body,
                Err(e) if e.status == 0 && attempt < MAX_TRANSIENT_RETRIES => {
                    attempt += 1;
                    sleep(RETRY_BACKOFF * attempt).await;
                }
                Err(e) => return Err(e.into()),
            }
        };
        let data = body
            .get("data")
            .and_then(JsonValue::as_array)
            .cloned()
            .ok_or_else(|| {
                ContractError(format!(
                    "GET /api/interactions: missing `data` array: {body}"
                ))
            })?;
        let total = body
            .get("pagination")
            .and_then(|p| p.get("total"))
            .and_then(JsonValue::as_u64)
            .ok_or_else(|| {
                ContractError(format!(
                    "GET /api/interactions: missing `pagination.total`: {body}"
                ))
            })? as usize;
        Ok((data, total))
    }

    pub async fn stream_chat_records(
        &self,
        conversation_id: &str,
        prior_messages: &[JsonValue],
        text: &str,
        files: &[FilePart],
        turn_id: &str,
    ) -> Result<impl Stream<Item = chat_stream::ChatStreamRecord> + use<'_>, ClientError> {
        let body = build_chat_body(conversation_id, prior_messages, text, files, turn_id);
        let url = self.url("/api/chat", None);
        let mut req = self
            .http
            .request(Method::POST, &url)
            .header("Accept-Encoding", "identity")
            .header("Content-Type", "application/json")
            .header("Accept", "text/event-stream");

        let auth = self.auth.lock().await.clone();
        if let Some(key) = auth {
            req = req.header("Authorization", key);
        }

        let resp = timeout(
            Duration::from_secs_f64(DEFAULT_CHAT_TIMEOUT_S),
            req.body(body.to_string()).send(),
        )
        .await
        .map_err(|_| ClientError::Config("chat request timed out".to_string()))?
        .map_err(|e| {
            ClientError::Api(ArchestraApiError {
                method: "POST".to_string(),
                url,
                status: 0,
                body: e.to_string(),
            })
        })?;

        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(ClientError::Api(ArchestraApiError {
                method: "POST".to_string(),
                url: self.url("/api/chat", None),
                status: status.as_u16(),
                body,
            }));
        }

        Ok(chat_stream::stream_chat_records(resp))
    }

    pub async fn warm_user_token(&self) -> Result<(), ClientError> {
        self.request(Method::GET, "/api/user-tokens/me", None, None)
            .await?;
        Ok(())
    }

    pub async fn list_conversation_files(
        &self,
        conversation_id: &str,
    ) -> Result<HashMap<String, JsonValue>, ClientError> {
        require_dict(
            self.request(
                Method::GET,
                &format!("/api/chat/conversations/{conversation_id}/files"),
                None,
                None,
            )
            .await?,
            "GET conversation files",
        )
    }

    pub async fn download_file_bytes(
        &self,
        content_url: &str,
        timeout_s: f64,
    ) -> Result<Vec<u8>, ClientError> {
        let url = self.url(content_url, None);
        let mut req = self
            .http
            .request(Method::GET, &url)
            .header("Accept-Encoding", "identity");

        let auth = self.auth.lock().await.clone();
        if let Some(key) = auth {
            req = req.header("Authorization", key);
        }

        let resp = timeout(Duration::from_secs_f64(timeout_s), req.send())
            .await
            .map_err(|_| {
                ClientError::Api(ArchestraApiError {
                    method: "GET".to_string(),
                    url: url.clone(),
                    status: 0,
                    body: "download timed out".to_string(),
                })
            })?
            .map_err(|e| {
                ClientError::Api(ArchestraApiError {
                    method: "GET".to_string(),
                    url: url.clone(),
                    status: 0,
                    body: e.to_string(),
                })
            })?;

        let status = resp.status();
        let bytes = resp.bytes().await.unwrap_or_default();
        if status.is_success() {
            Ok(bytes.to_vec())
        } else {
            Err(ClientError::Api(ArchestraApiError {
                method: "GET".to_string(),
                url,
                status: status.as_u16(),
                body: String::from_utf8_lossy(&bytes).to_string(),
            }))
        }
    }

    pub async fn list_models(&self) -> Result<Vec<HashMap<String, JsonValue>>, ClientError> {
        items(
            self.request(Method::GET, "/api/llm-models", None, None)
                .await?,
        )
    }

    pub async fn sync_models(&self) -> Result<(), ClientError> {
        self.request(Method::POST, "/api/llm-models/sync", None, None)
            .await?;
        Ok(())
    }

    pub async fn discover_github_skills(
        &self,
        repo_url: &str,
        path: Option<&str>,
        ref_: Option<&str>,
    ) -> Result<Vec<HashMap<String, JsonValue>>, ClientError> {
        let mut body = serde_json::Map::new();
        body.insert(
            "repoUrl".to_string(),
            JsonValue::String(pin_repo_url(repo_url, ref_)),
        );
        if let Some(path) = path {
            body.insert("path".to_string(), JsonValue::String(path.to_string()));
        }
        with_github_token(&mut body);
        let result = require_dict(
            self.request(
                Method::POST,
                "/api/skills/github/discover",
                None,
                Some(&JsonValue::Object(body)),
            )
            .await?,
            "POST /api/skills/github/discover",
        )?;
        let skills = result
            .get("skills")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        Ok(skills
            .into_iter()
            .filter_map(|s| s.as_object().cloned().map(map_to_hashmap))
            .collect())
    }

    pub async fn import_github_skills(
        &self,
        repo_url: &str,
        skill_paths: &[String],
        scope: &str,
        ref_: Option<&str>,
    ) -> Result<HashMap<String, JsonValue>, ClientError> {
        let mut body = serde_json::Map::new();
        body.insert(
            "repoUrl".to_string(),
            JsonValue::String(pin_repo_url(repo_url, ref_)),
        );
        body.insert(
            "skillPaths".to_string(),
            JsonValue::Array(
                skill_paths
                    .iter()
                    .map(|s| JsonValue::String(s.clone()))
                    .collect(),
            ),
        );
        body.insert("scope".to_string(), JsonValue::String(scope.to_string()));
        with_github_token(&mut body);

        let prev_timeout = self.timeout();
        self.set_timeout(Duration::from_secs_f64(600.0));
        let result = require_dict(
            self.request(
                Method::POST,
                "/api/skills/github/import",
                None,
                Some(&JsonValue::Object(body)),
            )
            .await?,
            "POST /api/skills/github/import",
        );
        self.set_timeout(prev_timeout);
        result
    }

    pub async fn list_mcp_server_tools(
        &self,
        server_id: &str,
    ) -> Result<Vec<HashMap<String, JsonValue>>, ClientError> {
        items(
            self.request(
                Method::GET,
                &format!("/api/mcp_server/{server_id}/tools"),
                None,
                None,
            )
            .await?,
        )
    }

    pub async fn install_mcp(
        &self,
        name: &str,
        catalog_id: &str,
        scope: &str,
        agent_ids: Option<&[String]>,
    ) -> Result<HashMap<String, JsonValue>, ClientError> {
        let mut body = serde_json::Map::new();
        body.insert("name".to_string(), JsonValue::String(name.to_string()));
        body.insert(
            "catalogId".to_string(),
            JsonValue::String(catalog_id.to_string()),
        );
        body.insert("scope".to_string(), JsonValue::String(scope.to_string()));
        if let Some(agent_ids) = agent_ids {
            body.insert(
                "agentIds".to_string(),
                JsonValue::Array(
                    agent_ids
                        .iter()
                        .map(|s| JsonValue::String(s.clone()))
                        .collect(),
                ),
            );
        }
        require_dict(
            self.request(
                Method::POST,
                "/api/mcp_server",
                None,
                Some(&JsonValue::Object(body)),
            )
            .await?,
            "POST /api/mcp_server",
        )
    }
}

fn require_dict(value: JsonValue, ctx: &str) -> Result<HashMap<String, JsonValue>, ClientError> {
    match value {
        JsonValue::Object(m) => Ok(map_to_hashmap(m)),
        _ => Err(ContractError(format!("{ctx}: expected an object, got {value}")).into()),
    }
}

fn map_to_hashmap(m: serde_json::Map<String, JsonValue>) -> HashMap<String, JsonValue> {
    m.into_iter().collect()
}

fn require_str_field(
    obj: &HashMap<String, JsonValue>,
    key: &str,
    ctx: &str,
) -> Result<String, ClientError> {
    match obj.get(key) {
        Some(JsonValue::String(s)) if !s.is_empty() => Ok(s.clone()),
        other => Err(ContractError(format!(
            "{ctx}: field {key:?} must be a non-empty string, got {other:?}"
        ))
        .into()),
    }
}

fn items(body: JsonValue) -> Result<Vec<HashMap<String, JsonValue>>, ClientError> {
    let rows = match &body {
        JsonValue::Array(arr) => arr.clone(),
        JsonValue::Object(obj) => {
            if let Some(JsonValue::Array(arr)) = obj.get("items") {
                arr.clone()
            } else if let Some(JsonValue::Array(arr)) = obj.get("data") {
                arr.clone()
            } else {
                return Err(
                    ContractError(format!("unexpected list-response shape: {body}")).into(),
                );
            }
        }
        _ => {
            return Err(ContractError(format!("unexpected list-response shape: {body}")).into());
        }
    };
    rows.into_iter()
        .map(|row| match row {
            JsonValue::Object(m) => Ok(map_to_hashmap(m)),
            other => {
                Err(ContractError(format!("unexpected list item (not an object): {other}")).into())
            }
        })
        .collect()
}

fn require_secure_transport(base_url: &str) -> Result<(), ClientError> {
    if let Ok(parsed) = url::Url::parse(base_url) {
        if parsed.scheme() == "https" {
            return Ok(());
        }
        if let Some(host) = parsed.host_str() {
            let host = host.to_lowercase();
            if host == "localhost" || host == "127.0.0.1" || host == "::1" {
                return Ok(());
            }
        }
    }
    Err(ClientError::Config(format!(
        "refusing to send sign-in credentials over insecure transport: {base_url:?} (use https, or localhost/127.0.0.1 for local docker)"
    )))
}

fn pin_repo_url(repo_url: &str, ref_: Option<&str>) -> String {
    match ref_ {
        None => repo_url.to_string(),
        Some(r) => format!("{}/tree/{}", repo_url.trim_end_matches('/'), r),
    }
}

fn with_github_token(body: &mut serde_json::Map<String, JsonValue>) {
    if let Some(token) = github_token() {
        body.insert("githubToken".to_string(), JsonValue::String(token));
    }
}

fn github_token() -> Option<String> {
    std::env::var("GITHUB_TOKEN")
        .or_else(|_| std::env::var("GH_TOKEN"))
        .ok()
        .or_else(|| {
            std::process::Command::new("gh")
                .args(["auth", "token"])
                .output()
                .ok()
                .and_then(|out| {
                    if out.status.success() {
                        String::from_utf8(out.stdout)
                            .ok()
                            .map(|s| s.trim().to_string())
                    } else {
                        None
                    }
                })
        })
}

/// Build the `POST /api/chat` request body. Pinned sampling lives here so reruns of the same config
/// don't diverge on temperature alone — the backend forwards `temperature` to `streamText`, and a
/// provider that can't honor it (e.g. a reasoning model) drops it with a warning rather than erroring.
fn build_chat_body(
    conversation_id: &str,
    prior_messages: &[JsonValue],
    text: &str,
    files: &[FilePart],
    turn_id: &str,
) -> JsonValue {
    let mut parts = vec![serde_json::json!({
        "type": "text",
        "text": text,
    })];
    for file in files {
        parts.push(file.to_data_url_part());
    }
    // Resend the persisted history verbatim (keeping each message's backend id, so
    // persistNewMessages dedupes them) and append the new user turn. `turn_id` is
    // stable across a stage's attempts so a retried turn reuses the same id and is
    // deduped backend-side rather than persisted twice.
    let mut messages = prior_messages.to_vec();
    messages.push(serde_json::json!({
        "id": turn_id,
        "role": "user",
        "parts": parts,
    }));
    serde_json::json!({
        "id": conversation_id,
        "messages": messages,
        "temperature": BENCH_TEMPERATURE,
        "trigger": "submit-message",
    })
}

/// What one `/ready` poll says about the code-execution sandbox.
#[derive(Debug, PartialEq, Eq)]
enum SandboxReadiness {
    /// Still warming (or an older backend that predates the field) — keep polling.
    Pending,
    /// Usable now.
    Ready,
    /// Terminally unusable; the reason is carried for the error message.
    Fatal(String),
}

/// Decide sandbox readiness from a `/ready` body. `ready` → Ready; `initializing` or an absent field
/// → Pending; `disabled`/`unreachable` (or any unknown value) → Fatal, preferring `sandboxReason`.
fn sandbox_readiness(body: &JsonValue) -> SandboxReadiness {
    match body.get("sandbox").and_then(|v| v.as_str()) {
        Some("ready") => SandboxReadiness::Ready,
        Some("initializing") => SandboxReadiness::Pending,
        // No field: a backend that predates it — e.g. a deployed image lagging this runner (the bench
        // image layers a freshly-built runner over the live platform image). A current backend always
        // emits the field, so absence can only mean "can't report it"; fall back to DB-only readiness
        // and proceed rather than poll out the deadline.
        None => SandboxReadiness::Ready,
        Some(other) => {
            let reason = body
                .get("sandboxReason")
                .and_then(|v| v.as_str())
                .unwrap_or(other);
            SandboxReadiness::Fatal(format!("sandbox {reason}"))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sandbox_readiness_classifies_each_state() {
        use serde_json::json;
        assert_eq!(
            sandbox_readiness(&json!({"sandbox": "ready"})),
            SandboxReadiness::Ready
        );
        assert_eq!(
            sandbox_readiness(&json!({"sandbox": "initializing"})),
            SandboxReadiness::Pending
        );
        // absent field (older/lagging backend) falls back to DB-only readiness: proceed, don't gate.
        assert_eq!(
            sandbox_readiness(&json!({"database": "connected"})),
            SandboxReadiness::Ready
        );
        assert_eq!(
            sandbox_readiness(&json!({"sandbox": "disabled", "sandboxReason": "disabled"})),
            SandboxReadiness::Fatal("sandbox disabled".to_string())
        );
        assert_eq!(
            sandbox_readiness(&json!({"sandbox": "unreachable", "sandboxReason": "error"})),
            SandboxReadiness::Fatal("sandbox error".to_string())
        );
        // unreachable without a reason falls back to the status value itself.
        assert_eq!(
            sandbox_readiness(&json!({"sandbox": "unreachable"})),
            SandboxReadiness::Fatal("sandbox unreachable".to_string())
        );
    }

    #[test]
    fn test_chat_body_pins_temperature() {
        let body = build_chat_body("conv-1", &[], "hello", &[], "turn-1");
        assert_eq!(body["temperature"], serde_json::json!(BENCH_TEMPERATURE));
        assert_eq!(body["id"], "conv-1");
        assert_eq!(body["trigger"], "submit-message");
        assert_eq!(body["messages"][0]["parts"][0]["text"], "hello");
        assert_eq!(body["messages"][0]["id"], "turn-1");
    }

    // The backend rejects snake_case keys; every multi-word field must serialize as camelCase.
    #[test]
    fn test_catalog_create_serializes_camelcase_wire_keys() {
        let v = serde_json::to_value(CatalogCreate {
            name: "bench".into(),
            server_type: "remote".into(),
            scope: "org".into(),
            description: None,
            server_url: Some("http://127.0.0.1:1/mcp".into()),
        })
        .unwrap();
        assert_eq!(v["serverType"], "remote");
        assert_eq!(v["serverUrl"], "http://127.0.0.1:1/mcp");
        assert!(v.get("server_url").is_none(), "snake_case key leaked");
    }

    #[test]
    fn test_agent_create_serializes_tool_exposure_mode_wire_value() {
        let agent = AgentCreate {
            name: "a".into(),
            scope: "org".into(),
            agent_type: "agent".into(),
            system_prompt: None,
            tool_exposure_mode: ToolExposureMode::SearchAndRunOnly,
            teams: vec![],
        };
        let v = serde_json::to_value(&agent).unwrap();
        assert_eq!(v["toolExposureMode"], "search_and_run_only");
        assert!(
            v.get("tool_exposure_mode").is_none(),
            "snake_case key leaked"
        );
        assert!(
            v.get("systemPrompt").is_none(),
            "empty prompt must be omitted"
        );

        let full = AgentCreate {
            tool_exposure_mode: ToolExposureMode::Full,
            ..agent
        };
        assert_eq!(
            serde_json::to_value(&full).unwrap()["toolExposureMode"],
            "full"
        );
    }

    #[test]
    fn test_llm_key_create_serializes_camelcase_wire_keys() {
        let v = serde_json::to_value(LlmKeyCreate {
            provider: "anthropic".into(),
            scope: "org".into(),
            api_key: "sk".into(),
            name: Some("bench".into()),
            base_url: Some("https://api.kimi.com/coding/".into()),
            is_primary: Some(true),
        })
        .unwrap();
        assert_eq!(v["apiKey"], "sk");
        assert_eq!(v["baseUrl"], "https://api.kimi.com/coding/");
        assert_eq!(v["isPrimary"], true);
        assert!(v.get("base_url").is_none(), "snake_case key leaked");
    }

    #[test]
    fn test_items_unwraps_envelopes() {
        let body = serde_json::json!({"items": [{"id": "1"}]});
        let got = items(body).unwrap();
        assert_eq!(got.len(), 1);

        let body = serde_json::json!({"data": [{"id": "1"}]});
        let got = items(body).unwrap();
        assert_eq!(got.len(), 1);

        let body = serde_json::json!([{"id": "1"}]);
        let got = items(body).unwrap();
        assert_eq!(got.len(), 1);
    }

    #[test]
    fn test_pin_repo_url() {
        assert_eq!(
            pin_repo_url("https://github.com/foo/bar", Some("abc123")),
            "https://github.com/foo/bar/tree/abc123"
        );
    }
}
