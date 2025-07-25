use axum::routing::Router;
use sea_orm::DatabaseConnection;
pub mod ollama;

pub fn create_router(db: DatabaseConnection) -> Router {
    Router::new().nest_service("/ollama", ollama::create_router(db))
}
