use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use base64::{Engine as _, engine::general_purpose};
use bytes::Bytes;
use futures::Stream;
use reqwest::redirect::Policy;
use reqwest::{Client, ClientBuilder, Method, Response};
use serde::Serialize;
use serde_json::Value as JsonValue;
use tokio::sync::Mutex;
use tokio::time::{Duration, sleep, timeout};

const DEFAULT_CHAT_TIMEOUT_S: f64 = 1800.0;

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
}

impl std::fmt::Display for ClientError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ClientError::Api(e) => write!(f, "{e}"),
            ClientError::Contract(e) => write!(f, "{e}"),
            ClientError::Config(s) => write!(f, "config error: {s}"),
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
    pub tool_exposure_mode: String,
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
                    if let Some(obj) = body.as_object()
                        && obj.get("database").and_then(|v| v.as_str()) == Some("connected")
                    {
                        return Ok(body);
                    }
                    last = Some(format!("reachable but not connected: {body}"));
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

    pub async fn create_conversation(
        &self,
        agent_id: &str,
        title: Option<&str>,
        model_id: Option<&str>,
        chat_api_key_id: Option<&str>,
    ) -> Result<HashMap<String, JsonValue>, ClientError> {
        let mut body = serde_json::Map::new();
        body.insert(
            "agentId".to_string(),
            JsonValue::String(agent_id.to_string()),
        );
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

    pub async fn stream_chat_records(
        &self,
        conversation_id: &str,
        text: &str,
        files: &[FilePart],
    ) -> Result<impl Stream<Item = ChatStreamRecord> + use<'_>, ClientError> {
        let mut parts = vec![serde_json::json!({
            "type": "text",
            "text": text,
        })];
        for file in files {
            parts.push(file.to_data_url_part());
        }
        let body = serde_json::json!({
            "id": conversation_id,
            "messages": [{
                "id": uuid::Uuid::new_v4().to_string(),
                "role": "user",
                "parts": parts,
            }],
            "trigger": "submit-message",
        });
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

        Ok(stream_chat_records(resp))
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

fn stream_chat_records(resp: Response) -> impl Stream<Item = ChatStreamRecord> {
    ChatRecordStream::new(resp)
}

fn sse_data_payload(line: &str) -> Option<&str> {
    if !line.starts_with("data:") {
        return None;
    }
    Some(line[5..].trim())
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sse_data_payload() {
        assert_eq!(sse_data_payload("data: hello"), Some("hello"));
        assert_eq!(sse_data_payload("data:  [DONE]"), Some("[DONE]"));
        assert_eq!(sse_data_payload("event: message"), None);
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
