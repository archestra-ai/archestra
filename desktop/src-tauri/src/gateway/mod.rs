use axum::Router;
use sea_orm::DatabaseConnection;
use std::net::SocketAddr;
use tokio::net::TcpListener;

pub mod api;
pub mod llm_providers;
mod mcp;
mod mcp_proxy;

pub const GATEWAY_SERVER_PORT: u16 = 54587;

pub async fn start_gateway(
    user_id: String,
    db: DatabaseConnection,
) -> Result<(), Box<dyn std::error::Error>> {
    let mcp_service = mcp::create_streamable_http_service(user_id, db.clone()).await;
    let mcp_proxy_router = mcp_proxy::create_router(db.clone());
    let api_router = api::create_router(db.clone());
    let llm_providers_router = llm_providers::create_router(db.clone());

    let app = Router::new()
        .nest("/mcp_proxy", mcp_proxy_router)
        .nest("/llm", llm_providers_router)
        .nest("/api", api_router)
        .nest_service("/mcp", mcp_service);

    let addr = SocketAddr::from(([127, 0, 0, 1], GATEWAY_SERVER_PORT));
    let listener = TcpListener::bind(addr).await?;

    println!("Gateway started successfully on http://{addr}");
    println!("  - Archestra MCP endpoint (streamable HTTP): http://{addr}/mcp");
    println!("  - Proxy endpoints: http://{addr}/mcp_proxy/<server_name>");
    println!("  - LLM endpoints: http://{addr}/llm/<provider>");
    println!("  - API endpoints: http://{addr}/api");

    let server = axum::serve(listener, app);

    if let Err(e) = server.await {
        eprintln!("Server error: {e}");
    }

    println!("Server has been shut down");
    Ok(())
}
