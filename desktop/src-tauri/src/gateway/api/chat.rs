use crate::models::chat::{ChatDefinition, ChatWithMessages, Model as Chat};
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::Json;
use axum::routing::get;
use axum::Router;
use sea_orm::DatabaseConnection;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use utoipa::ToSchema;

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct CreateChatRequest {
    pub llm_provider: String,
    pub llm_model: String,
}

pub struct Service {
    db: Arc<DatabaseConnection>,
}

impl Service {
    pub fn new(db: DatabaseConnection) -> Self {
        Self { db: Arc::new(db) }
    }

    pub async fn get_all_chats(&self) -> Result<Vec<Chat>, sea_orm::DbErr> {
        Chat::load_all(&self.db).await
    }

    pub async fn get_chat_by_id(
        &self,
        id: i32,
    ) -> Result<Option<ChatWithMessages>, sea_orm::DbErr> {
        Chat::load_with_messages(id, &self.db).await
    }

    pub async fn create_chat(&self, request: CreateChatRequest) -> Result<Chat, sea_orm::DbErr> {
        let definition = ChatDefinition {
            llm_provider: request.llm_provider,
            llm_model: request.llm_model,
        };
        Chat::save(definition, &self.db).await
    }

    pub async fn delete_chat(&self, id: i32) -> Result<(), sea_orm::DbErr> {
        Chat::delete(id, &self.db).await
    }
}

#[utoipa::path(
    get,
    path = "/api/chat",
    tag = "chat",
    responses(
        (status = 200, description = "List all chats", body = Vec<Chat>),
        (status = 500, description = "Internal server error")
    )
)]
pub async fn get_all_chats(
    State(service): State<Arc<Service>>,
) -> Result<Json<Vec<Chat>>, StatusCode> {
    service
        .get_all_chats()
        .await
        .map(Json)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

#[utoipa::path(
    get,
    path = "/api/chat/{id}",
    tag = "chat",
    params(
        ("id" = i32, Path, description = "Chat ID")
    ),
    responses(
        (status = 200, description = "Chat with messages found", body = ChatWithMessages),
        (status = 404, description = "Chat not found"),
        (status = 500, description = "Internal server error")
    )
)]
pub async fn get_chat_by_id(
    State(service): State<Arc<Service>>,
    Path(id): Path<i32>,
) -> Result<Json<ChatWithMessages>, StatusCode> {
    match service.get_chat_by_id(id).await {
        Ok(Some(chat)) => Ok(Json(chat)),
        Ok(None) => Err(StatusCode::NOT_FOUND),
        Err(_) => Err(StatusCode::INTERNAL_SERVER_ERROR),
    }
}

#[utoipa::path(
    post,
    path = "/api/chat",
    tag = "chat",
    request_body = CreateChatRequest,
    responses(
        (status = 201, description = "Chat created successfully", body = Chat),
        (status = 500, description = "Internal server error")
    )
)]
pub async fn create_chat(
    State(service): State<Arc<Service>>,
    Json(request): Json<CreateChatRequest>,
) -> Result<(StatusCode, Json<Chat>), StatusCode> {
    service
        .create_chat(request)
        .await
        .map(|chat| (StatusCode::CREATED, Json(chat)))
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

#[utoipa::path(
    delete,
    path = "/api/chat/{id}",
    tag = "chat",
    params(
        ("id" = i32, Path, description = "Chat ID")
    ),
    responses(
        (status = 204, description = "Chat deleted successfully"),
        (status = 500, description = "Internal server error")
    )
)]
pub async fn delete_chat(
    State(service): State<Arc<Service>>,
    Path(id): Path<i32>,
) -> Result<StatusCode, StatusCode> {
    service
        .delete_chat(id)
        .await
        .map(|_| StatusCode::NO_CONTENT)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

pub fn create_router(db: DatabaseConnection) -> Router {
    let service = Arc::new(Service::new(db));

    Router::new()
        .route("/", get(get_all_chats).post(create_chat))
        .route("/{id}", get(get_chat_by_id).delete(delete_chat))
        .with_state(service)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_fixtures::database;
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use rstest::rstest;
    use tower::ServiceExt;

    #[rstest]
    #[tokio::test]
    async fn test_create_and_get_chat(#[future] database: DatabaseConnection) {
        let db = database.await;
        let router = create_router(db.clone());

        let create_request = CreateChatRequest {
            llm_provider: "ollama".to_string(),
            llm_model: "llama3.2".to_string(),
        };

        let response = router
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/")
                    .header("content-type", "application/json")
                    .body(Body::from(serde_json::to_string(&create_request).unwrap()))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::CREATED);

        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let created_chat: Chat = serde_json::from_slice(&body).unwrap();
        assert_eq!(created_chat.llm_provider, "ollama");
        assert_eq!(created_chat.llm_model, "llama3.2");

        let response = router
            .clone()
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri(format!("/{}", created_chat.id))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);

        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let chat_with_messages: ChatWithMessages = serde_json::from_slice(&body).unwrap();
        assert_eq!(chat_with_messages.chat.id, created_chat.id);
        assert_eq!(chat_with_messages.messages.len(), 0);
    }

    #[rstest]
    #[tokio::test]
    async fn test_get_all_chats(#[future] database: DatabaseConnection) {
        let db = database.await;
        let router = create_router(db.clone());

        let response = router
            .clone()
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);

        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let chats: Vec<Chat> = serde_json::from_slice(&body).unwrap();
        assert_eq!(chats.len(), 0);
    }

    #[rstest]
    #[tokio::test]
    async fn test_delete_chat(#[future] database: DatabaseConnection) {
        let db = database.await;
        let router = create_router(db.clone());

        let create_request = CreateChatRequest {
            llm_provider: "ollama".to_string(),
            llm_model: "llama3.2".to_string(),
        };

        let response = router
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/")
                    .header("content-type", "application/json")
                    .body(Body::from(serde_json::to_string(&create_request).unwrap()))
                    .unwrap(),
            )
            .await
            .unwrap();

        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let created_chat: Chat = serde_json::from_slice(&body).unwrap();

        let response = router
            .clone()
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri(format!("/{}", created_chat.id))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::NO_CONTENT);

        let response = router
            .clone()
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri(format!("/{}", created_chat.id))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }
}
