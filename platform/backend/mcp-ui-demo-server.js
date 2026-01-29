import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
    ReadResourceRequestSchema,
    ListResourcesRequestSchema
} from "@modelcontextprotocol/sdk/types.js";

const server = new Server({
    name: "mcp-ui-demo-server",
    version: "1.0.0",
}, {
    capabilities: {
        tools: {},
        resources: {},
    }
});

server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
        tools: [
            {
                name: "show_token_usage_chart",
                description: "Display a chart of token usage for the current agent",
                inputSchema: { type: "object", properties: {} },
            },
            {
                name: "show_system_status",
                description: "Display the current system status and health",
                inputSchema: { type: "object", properties: {} },
            }
        ]
    };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name === "show_token_usage_chart") {
        return {
            content: [{ type: "text", text: "Generating token usage chart..." }],
            _meta: {
                ui: {
                    resourceUri: "mcp://mcp-ui-demo-server/ui/usage-chart"
                }
            }
        };
    }
    if (request.params.name === "show_system_status") {
        return {
            content: [{ type: "text", text: "Fetching system status..." }],
            _meta: {
                ui: {
                    resourceUri: "mcp://mcp-ui-demo-server/ui/system-status"
                }
            }
        };
    }
    throw new Error("Tool not found");
});

server.setRequestHandler(ListResourcesRequestSchema, async () => {
    return {
        resources: [
            { uri: "mcp://mcp-ui-demo-server/ui/usage-chart", name: "Token Usage Chart" },
            { uri: "mcp://mcp-ui-demo-server/ui/system-status", name: "System Status" }
        ]
    };
});

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    if (request.params.uri === "mcp://mcp-ui-demo-server/ui/usage-chart") {
        return {
            contents: [{
                uri: request.params.uri,
                mimeType: "application/json",
                text: JSON.stringify({
                    type: "chart",
                    data: {
                        labels: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
                        datasets: [
                            { label: "Input Tokens", data: [120, 190, 300, 500, 200, 300, 450] },
                            { label: "Output Tokens", data: [400, 300, 600, 800, 400, 500, 700] }
                        ]
                    }
                })
            }]
        };
    }
    if (request.params.uri === "mcp://mcp-ui-demo-server/ui/system-status") {
        return {
            contents: [{
                uri: request.params.uri,
                mimeType: "application/json",
                text: JSON.stringify({
                    type: "status-grid",
                    items: [
                        { name: "MCP Gateway", status: "online", latency: "42ms" },
                        { name: "LLM Proxy", status: "online", latency: "150ms" },
                        { name: "Prisma DB", status: "online", latency: "5ms" }
                    ]
                })
            }]
        };
    }
    throw new Error("Resource not found");
});

const transport = new StdioServerTransport();
server.connect(transport);
