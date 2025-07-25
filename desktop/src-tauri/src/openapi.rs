use utoipa::OpenApi;
use utoipauto::utoipauto;

#[utoipauto]
#[derive(OpenApi)]
#[openapi(
    tags(
        (name = "chat", description = "Chat and message management API"),
        (name = "external_mcp_client", description = "External MCP Client management API"),
        (name = "mcp_request_log", description = "MCP Request logging and analytics API"),
        (name = "mcp_server", description = "MCP Server management API"),
    ),
    info(
        title = "Archestra API",
        version = "1.0.0",
        description = "API for managing MCP servers, clients, and request logs in Archestra"
    )
)]
pub struct ApiDoc;
