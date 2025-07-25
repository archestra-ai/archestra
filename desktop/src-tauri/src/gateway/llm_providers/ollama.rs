use crate::models::chat::Model as Chat;
use crate::models::message::{MessageDefinition, Model as Message};
use crate::ollama::{emit_chat_title_updated, OLLAMA_SERVER_PORT};
use axum::{
    body::Body,
    extract::State,
    http::{Request, Response, StatusCode},
    response::IntoResponse,
    Router,
};
use futures_util::StreamExt;
use reqwest::Client;
use sea_orm::DatabaseConnection;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::Duration;

// Constants for resource management
// Also, make the request timeout very high as it can take some time for the LLM to respond
const REQUEST_TIMEOUT: Duration = Duration::from_secs(180);

#[derive(Debug, Clone, Deserialize, Serialize)]
struct OllamaMessage {
    role: String,
    content: String,
}

#[derive(Debug, Deserialize)]
struct OllamaChatRequest {
    model: String,
    messages: Vec<OllamaMessage>,
}

struct Service {
    db: Arc<DatabaseConnection>,
    http_client: Client,
}

impl Service {
    pub fn new(db: DatabaseConnection) -> Self {
        Self {
            db: Arc::new(db),
            http_client: Client::builder()
                .timeout(REQUEST_TIMEOUT)
                .build()
                .unwrap_or_default(),
        }
    }
}

async fn proxy_handler(
    State(service): State<Arc<Service>>,
    req: Request<Body>,
) -> impl IntoResponse {
    let is_chat_endpoint = req.uri().path() == "/api/chat";
    let is_post = req.method() == "POST";

    let path_and_query = req
        .uri()
        .path_and_query()
        .map(|pq| pq.as_str())
        .unwrap_or("");
    let target_url = format!("http://127.0.0.1:{OLLAMA_SERVER_PORT}{path_and_query}");

    let method = req.method().clone();
    let headers = req.headers().clone();
    let body_bytes = match axum::body::to_bytes(req.into_body(), usize::MAX).await {
        Ok(bytes) => bytes,
        Err(_) => return (StatusCode::BAD_REQUEST, "Failed to read request body").into_response(),
    };

    // Parse chat request if it's the chat endpoint
    let chat_request = if is_chat_endpoint && is_post && !body_bytes.is_empty() {
        match serde_json::from_slice::<OllamaChatRequest>(&body_bytes) {
            Ok(chat_req) => {
                // Create or get existing chat and save user message
                let last_user_message = chat_req
                    .messages
                    .last()
                    .filter(|msg| msg.role == "user")
                    .cloned();

                if let Some(msg) = last_user_message {
                    let db = service.db.clone();
                    let model = chat_req.model.clone();

                    // Spawn a task to handle database operations
                    tokio::spawn(async move {
                        if let Ok(chat_id) = create_or_get_chat(&db, &model).await {
                            let _ = save_message(&db, chat_id, &msg).await;
                        }
                    });
                }

                Some(chat_req)
            }
            Err(e) => {
                eprintln!("Failed to parse chat request: {e}");
                None
            }
        }
    } else {
        None
    };

    let mut request = service.http_client.request(method, &target_url);

    for (name, value) in headers.iter() {
        request = request.header(name, value);
    }

    if !body_bytes.is_empty() {
        request = request.body(body_bytes);
    }

    match request.send().await {
        Ok(resp) => {
            let status = resp.status();
            let mut response_builder = Response::builder().status(status);

            // Copy headers from the upstream response
            for (name, value) in resp.headers().iter() {
                response_builder = response_builder.header(name, value);
            }

            // Handle chat endpoint specially to capture assistant response
            if is_chat_endpoint && is_post && chat_request.is_some() {
                let service_clone = service.clone();
                let chat_request = chat_request.unwrap();

                // Create a channel to collect chunks
                use tokio::sync::mpsc;
                let (tx, mut rx) = mpsc::unbounded_channel::<Vec<u8>>();

                // Stream the response while capturing chunks
                let body_stream = resp.bytes_stream();
                let db = service_clone.db.clone();
                let model = chat_request.model.clone();

                // Spawn a task to collect chunks and save the message
                tokio::spawn(async move {
                    let mut accumulated_chunks = Vec::new();
                    while let Some(chunk) = rx.recv().await {
                        accumulated_chunks.extend_from_slice(&chunk);
                    }

                    // Save message after stream completes
                    if !accumulated_chunks.is_empty() {
                        if let Ok(chat_id) = create_or_get_chat(&db, &model).await {
                            let content = extract_assistant_content(&accumulated_chunks);
                            if !content.is_empty() {
                                let assistant_msg = OllamaMessage {
                                    role: "assistant".to_string(),
                                    content,
                                };
                                let _ = save_message(&db, chat_id, &assistant_msg).await;

                                // Check if we need to generate title
                                if let Ok(count) = Chat::count_messages(chat_id, &db).await {
                                    if count == 4 {
                                        generate_chat_title(db.clone(), chat_id).await;
                                    }
                                }
                            }
                        }
                    }
                });

                let mapped_stream = body_stream.map(move |result| {
                    match result {
                        Ok(bytes) => {
                            // Send a copy of the chunk to the collector
                            let _ = tx.send(bytes.to_vec());
                            Ok(axum::body::Bytes::from(bytes.to_vec()))
                        }
                        Err(e) => Err(std::io::Error::other(e)),
                    }
                });

                let body = Body::from_stream(mapped_stream);
                response_builder.body(body).unwrap_or_else(|_| {
                    (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        "Failed to build response",
                    )
                        .into_response()
                })
            } else {
                // Non-chat endpoints: stream as-is
                let body_stream = resp.bytes_stream();
                let mapped_stream = body_stream.map(|result| {
                    result
                        .map(|bytes| axum::body::Bytes::from(bytes.to_vec()))
                        .map_err(std::io::Error::other)
                });
                let body = Body::from_stream(mapped_stream);

                response_builder.body(body).unwrap_or_else(|_| {
                    (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        "Failed to build response",
                    )
                        .into_response()
                })
            }
        }
        Err(e) => (StatusCode::BAD_GATEWAY, format!("Proxy error: {e}")).into_response(),
    }
}

fn extract_assistant_content(response_data: &[u8]) -> String {
    if let Ok(text) = std::str::from_utf8(response_data) {
        let mut content = String::new();

        // Try parsing as streaming response (multiple JSON lines)
        for line in text.lines() {
            if line.trim().is_empty() {
                continue;
            }

            if let Ok(json) = serde_json::from_str::<serde_json::Value>(line) {
                if let Some(message) = json.get("message") {
                    if let Some(msg_content) = message.get("content").and_then(|c| c.as_str()) {
                        content.push_str(msg_content);
                    }
                }
            }
        }

        // If no content found, try parsing as single response
        if content.is_empty() {
            if let Ok(json) = serde_json::from_slice::<serde_json::Value>(response_data) {
                if let Some(message) = json.get("message") {
                    if let Some(msg_content) = message.get("content").and_then(|c| c.as_str()) {
                        content = msg_content.to_string();
                    }
                }
            }
        }

        content
    } else {
        String::new()
    }
}

async fn create_or_get_chat(db: &DatabaseConnection, model: &str) -> Result<i32, String> {
    // For now, we'll use the most recent chat or create a new one
    // In the future, this could be improved to track chat context better
    let chats = Chat::load_all(db)
        .await
        .map_err(|e| format!("Failed to load chats: {e}"))?;

    if let Some(chat) = chats.first() {
        Ok(chat.id)
    } else {
        // Create new chat
        let chat_def = crate::models::chat::ChatDefinition {
            llm_provider: "ollama".to_string(),
            llm_model: model.to_string(),
        };

        Chat::save(chat_def, db)
            .await
            .map(|chat| chat.id)
            .map_err(|e| format!("Failed to create chat: {e}"))
    }
}

async fn save_message(
    db: &DatabaseConnection,
    chat_id: i32,
    message: &OllamaMessage,
) -> Result<(), String> {
    let msg_def = MessageDefinition {
        chat_id,
        role: message.role.clone(),
        content: message.content.clone(),
    };

    Message::save(msg_def, db)
        .await
        .map(|_| ())
        .map_err(|e| format!("Failed to save message: {e}"))
}

async fn generate_chat_title(db: Arc<DatabaseConnection>, chat_id: i32) {
    // Load chat with messages
    let chat_with_messages = match Chat::load_with_messages(chat_id, &db).await {
        Ok(Some(cwm)) => cwm,
        _ => return,
    };

    // Build context from messages
    let mut context = String::new();
    for msg in &chat_with_messages.messages {
        context.push_str(&format!("{}: {}\n", msg.role, msg.content));
    }

    // Request title generation from Ollama
    let prompt = format!(
        "Based on this conversation, generate a brief 5-6 word title that captures the main topic. Return only the title, no quotes or extra text:\n\n{context}"
    );

    let request_body = serde_json::json!({
        "model": chat_with_messages.chat.llm_model,
        "prompt": prompt,
        "stream": false,
        "options": {
            "temperature": 0.7,
            "num_predict": 20
        }
    });

    let target_url = format!("http://127.0.0.1:{OLLAMA_SERVER_PORT}/api/generate");

    let client = Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .unwrap_or_default();

    match client.post(&target_url).json(&request_body).send().await {
        Ok(resp) => {
            if let Ok(json) = resp.json::<serde_json::Value>().await {
                if let Some(title) = json.get("response").and_then(|r| r.as_str()) {
                    let title = title.trim().to_string();

                    // Update chat title
                    if Chat::update_title(chat_id, title.clone(), &db)
                        .await
                        .is_ok()
                    {
                        // Emit event to frontend
                        emit_chat_title_updated(chat_id, title);
                    }
                }
            }
        }
        Err(e) => {
            eprintln!("Failed to generate chat title: {e}");
        }
    }
}

pub fn create_router(db: DatabaseConnection) -> Router {
    Router::new()
        .fallback(proxy_handler)
        .with_state(Arc::new(Service::new(db)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_fixtures::database;
    use axum::{
        body::Body,
        http::{Request, StatusCode},
    };
    use rstest::*;
    use tower::ServiceExt;

    fn app(db: DatabaseConnection) -> Router {
        create_router(db)
    }

    #[rstest]
    #[tokio::test]
    async fn test_service_creation(#[future] database: DatabaseConnection) {
        let db = database.await;
        let service = Service::new(db);

        // Just ensure the service is created successfully
        // (We can't easily test the timeout configuration)
        assert!(Arc::strong_count(&service.db) > 0);
    }

    #[rstest]
    #[tokio::test]
    async fn test_proxy_get_request(#[future] database: DatabaseConnection) {
        let db = database.await;
        let app = app(db);

        let response = app
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/api/tags")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        // This will fail with BAD_GATEWAY since Ollama isn't running
        assert_eq!(response.status(), StatusCode::BAD_GATEWAY);

        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let body_str = String::from_utf8(body.to_vec()).unwrap();
        assert!(body_str.contains("Proxy error"));
    }

    #[rstest]
    #[tokio::test]
    async fn test_proxy_with_body(#[future] database: DatabaseConnection) {
        let db = database.await;
        let app = app(db);

        let request_body = serde_json::json!({
            "model": "llama2",
            "prompt": "Hello, world!"
        });

        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/generate")
                    .header("Content-Type", "application/json")
                    .body(Body::from(serde_json::to_string(&request_body).unwrap()))
                    .unwrap(),
            )
            .await
            .unwrap();

        // This will fail with BAD_GATEWAY since Ollama isn't running
        assert_eq!(response.status(), StatusCode::BAD_GATEWAY);

        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let body_str = String::from_utf8(body.to_vec()).unwrap();
        assert!(body_str.contains("Proxy error"));
    }

    #[rstest]
    #[tokio::test]
    async fn test_proxy_with_headers(#[future] database: DatabaseConnection) {
        let db = database.await;
        let app = app(db);

        let response = app
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/api/version")
                    .header("Authorization", "Bearer test-token")
                    .header("X-Custom-Header", "test-value")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        // This will fail with BAD_GATEWAY since Ollama isn't running
        assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
    }

    #[rstest]
    #[tokio::test]
    async fn test_proxy_path_and_query(#[future] database: DatabaseConnection) {
        let db = database.await;
        let app = app(db);

        // Test with query parameters
        let response = app
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/api/pull?name=llama2&insecure=false")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
    }

    #[rstest]
    #[tokio::test]
    async fn test_proxy_empty_path(#[future] database: DatabaseConnection) {
        let db = database.await;
        let app = app(db);

        let response = app
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
    }

    #[rstest]
    #[tokio::test]
    async fn test_concurrent_proxy_requests(#[future] database: DatabaseConnection) {
        let db = database.await;
        let service = Arc::new(Service::new(db));

        let mut handles = vec![];

        for i in 0..5 {
            let service_clone = service.clone();
            let handle = tokio::spawn(async move {
                let req = Request::builder()
                    .method("GET")
                    .uri(format!("/api/test/{i}"))
                    .body(Body::empty())
                    .unwrap();

                let response = proxy_handler(State(service_clone), req)
                    .await
                    .into_response();

                response.status()
            });
            handles.push(handle);
        }

        for handle in handles {
            let status = handle.await.unwrap();
            assert_eq!(status, StatusCode::BAD_GATEWAY);
        }
    }

    #[rstest]
    #[tokio::test]
    async fn test_proxy_large_body(#[future] database: DatabaseConnection) {
        let db = database.await;
        let app = app(db);

        // Create a large body (1MB)
        let large_body = "x".repeat(1024 * 1024);

        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/generate")
                    .header("Content-Type", "text/plain")
                    .body(Body::from(large_body))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
    }

    #[rstest]
    #[tokio::test]
    async fn test_proxy_various_methods(#[future] database: DatabaseConnection) {
        let db = database.await;
        let app = app(db);

        let methods = ["GET", "POST", "PUT", "DELETE", "PATCH"];

        for method_str in &methods {
            let response = app
                .clone()
                .oneshot(
                    Request::builder()
                        .method(*method_str)
                        .uri("/api/test")
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();

            assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
        }
    }
}
