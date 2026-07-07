//! Standalone MCP server (stdio) exposing the dummy tools the AFC agent governs. It is a real
//! `rmcp` server — any MCP client can spawn it and call `tools/list` / `tools/call`; the agent does
//! exactly that. The tool surface and dummy content come from `afc_agent::catalog`.

use std::future::Future;

use rmcp::model::{
    CallToolRequestParams, CallToolResult, Content, Implementation, ListToolsResult,
    PaginatedRequestParams, ServerCapabilities, ServerInfo, Tool,
};
use rmcp::service::{MaybeSendFuture, RequestContext, RoleServer};
use rmcp::{ErrorData as McpError, ServerHandler, ServiceExt};

#[derive(Clone)]
struct McpToolsHandler;

impl ServerHandler for McpToolsHandler {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build()).with_server_info(
            Implementation::new("afc-mcp-tools", env!("CARGO_PKG_VERSION")),
        )
    }

    fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> impl Future<Output = Result<ListToolsResult, McpError>> + MaybeSendFuture + '_ {
        let tools: Vec<Tool> = afc_agent::catalog::catalog()
            .into_iter()
            .map(|t| {
                Tool::new(
                    t.tool_name,
                    t.description,
                    t.schema.as_object().cloned().unwrap_or_default(),
                )
            })
            .collect();
        std::future::ready(Ok(ListToolsResult::with_all_items(tools)))
    }

    fn call_tool(
        &self,
        request: CallToolRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> impl Future<Output = Result<CallToolResult, McpError>> + MaybeSendFuture + '_ {
        let args = request.arguments.unwrap_or_default();
        let out = afc_agent::catalog::respond(request.name.as_ref(), &args);
        std::future::ready(Ok(CallToolResult::success(vec![Content::text(out)])))
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let service = McpToolsHandler.serve(rmcp::transport::io::stdio()).await?;
    service.waiting().await?;
    Ok(())
}
