use axum::Router;
use sea_orm::DatabaseConnection;

pub mod chat;
pub mod external_mcp_client;
pub mod mcp_request_log;
pub mod mcp_server;

pub fn create_router(db: DatabaseConnection) -> Router {
    Router::new()
        .nest(
            "/external_mcp_client",
            external_mcp_client::create_router(db.clone()),
        )
        .nest(
            "/mcp_request_log",
            mcp_request_log::create_router(db.clone()),
        )
        .nest("/mcp_server", mcp_server::create_router(db.clone()))
        .nest("/chat", chat::create_router(db))
}
