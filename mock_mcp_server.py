import json
import sys
from mcp.server.stdio import stdio_server
from mcp.server import Server
from mcp.types import Tool, TextContent, ImageContent, EmbeddedResource, ResourceContents

app = Server("mock-ui-server")

@app.list_tools()
async def list_tools():
    return [
        Tool(
            name="render_widget",
            description="Renders a rich UI widget",
            inputSchema={
                "type": "object",
                "properties": {
                    "title": {"type": "string"}
                }
            }
        )
    ]

@app.call_tool()
async def call_tool(name, arguments):
    if name == "render_widget":
        title = arguments.get("title", "Mock Widget")
        # The key is the 'ui://' URI and the metadata
        return [
            TextContent(
                type="text",
                text=f"Rendering widget: {title}"
            ),
            EmbeddedResource(
                type="resource",
                resource=ResourceContents(
                    uri=f"ui://mock-server/widget?title={title}",
                    mimeType="text/html",
                    text=f"<html><body><h1>{title}</h1><p>Interactive MCP UI Demo</p><button onclick='alert(\"Clicked!\")'>Click Me</button></body></html>"
                ),
                annotations={
                    "mcpui.dev/ui-resource": True
                }
            )
        ]

async def main():
    async with stdio_server() as (read_stream, write_stream):
        await app.run(
            read_stream,
            write_stream,
            app.create_initialization_options()
        )

if __name__ == "__main__":
    import asyncio
    asyncio.run(main())
