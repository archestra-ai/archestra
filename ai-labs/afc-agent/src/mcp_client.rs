//! A thin MCP client: spawn the `afc-mcp-tools` server as a child process and talk to it over stdio.
//! This is the real MCP boundary — the agent never calls the dummy tools in-process; it dispatches
//! approved calls to the server through `tools/call`.

use std::path::Path;

use eyre::{Result, WrapErr};
use rmcp::model::CallToolRequestParams;
use rmcp::service::RunningService;
use rmcp::{RoleClient, serve_client};
use serde_json::{Map, Value};

pub struct McpTools {
    client: RunningService<RoleClient, ()>,
}

impl McpTools {
    /// Spawn `server_bin` and connect to it as an MCP client over the child's stdio.
    pub async fn connect(server_bin: &Path) -> Result<Self> {
        let transport =
            rmcp::transport::TokioChildProcess::new(tokio::process::Command::new(server_bin))
                .wrap_err("spawn MCP tool server")?;
        let client = serve_client((), transport)
            .await
            .wrap_err("MCP client handshake")?;
        Ok(Self { client })
    }

    /// The tool names the server advertises via `tools/list`.
    pub async fn tool_names(&self) -> Result<Vec<String>> {
        let tools = self.client.list_all_tools().await.wrap_err("list_tools")?;
        Ok(tools.into_iter().map(|t| t.name.to_string()).collect())
    }

    /// Invoke `tools/call` and return the concatenated text content of the result.
    pub async fn call(&self, tool_name: &str, args: Map<String, Value>) -> Result<String> {
        let mut params = CallToolRequestParams::new(tool_name.to_string());
        params.arguments = Some(args);
        let res = self
            .client
            .call_tool(params)
            .await
            .wrap_err_with(|| format!("call_tool {tool_name}"))?;
        let text = res
            .content
            .iter()
            .filter_map(|c| c.as_text().map(|t| t.text.clone()))
            .collect::<Vec<_>>()
            .join("\n");
        Ok(text)
    }
}
