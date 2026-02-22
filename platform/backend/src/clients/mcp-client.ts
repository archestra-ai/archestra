import type {
CallToolRequestSchema,
Client,
ListResourcesRequestSchema,
ListToolsRequestSchema,
Resource,
Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { AGENT_TOOL_PREFIX } from "@shared";
import { z } from "zod";
import logger from "@/logging";
import type { Tool as ArchestraTool } from "@/models/tool";
import type { McpAppResource, McpAppToolDefinition } from "@/types/mcp-app";

/**
* Authentication context for MCP connections
*/
export interface TokenAuthContext {
token: string;
type: "bearer" | "basic" | "api_key";
location?: "header" | "query";
keyName?: string;
}

/**
* MCP client wrapper for connecting to MCP servers
*/
export class McpClient {
private client: Client;
private serverName: string;
private authContext?: TokenAuthContext;

constructor(client: Client, serverName: string, authContext?: TokenAuthContext) {
this.client = client;
this.serverName = serverName;
this.authContext = authContext;
}

/**
* List all tools from the MCP server
*/
async listTools(): Promise<Tool[]> {
try {
const request = {
method: "tools/list",
params: {},
} satisfies ListToolsRequestSchema;

const response = await this.client.request(request);
return (response.result?.tools as Tool[]) || [];
} catch (error) {
logger.error(
{ error, serverName: this.serverName },
"Failed to list tools from MCP server",
);
return [];
}
}

/**
* List all resources from the MCP server
*/
async listResources(): Promise<Resource[]> {
try {
const request = {
method: "resources/list",
params: {},
} satisfies ListResourcesRequestSchema;

const response = await this.client.request(request);
return (response.result?.resources as Resource[]) || [];
} catch (error) {
logger.error(
{ error, serverName: this.serverName },
"Failed to list resources from MCP server",
);
return [];
}
}

/**
* Get app resources from the MCP server
*/
async getAppResources(): Promise<McpAppResource[]> {
try {
const resources = await this.listResources();
return resources
.filter((resource): resource is Resource & { mimeType: string } => {
return (
resource.mimeType?.startsWith("application/x.mcp-app") ||
resource.mimeType?.startsWith("text/html") ||
resource.uri.includes("app") ||
resource.name?.toLowerCase().includes("app")
);
})
.map((resource) => ({
uri: resource.uri,
name: resource.name || resource.uri.split("/").pop() || "app",
description: resource.description,
mimeType: resource.mimeType,
appMetadata: resource.metadata as { title?: string; description?: string; width?: number; height?: number; resizable?: boolean; embeddable?: boolean },
}));
} catch (error) {
logger.error(
{ error, serverName: this.serverName },
"Failed to get app resources from MCP server",
);
return [];
}
}

/**
* Execute a tool on the MCP server
*/
async callTool(toolName: string, args: Record<string, unknown>): Promise<unknown> {
try {
const request = {
method: "tools/call",
params: {
name: toolName,
arguments: args,
},
} satisfies CallToolRequestSchema;

const response = await this.client.request(request);
return response.result;
} catch (error) {
logger.error(
{ error, serverName: this.serverName, toolName, args },
"Failed to call tool on MCP server",
);
throw error;
}
}

/**
* Execute an app tool (initialize app communication)
*/
async executeApp(appUri: string, context?: Record<string, unknown>): Promise<unknown> {
try {
// For app tools, we typically initialize with context
// The actual app UI will be rendered in an iframe
return {
type: "app_init",
uri: appUri,
context,
timestamp: new Date().toISOString(),
};
} catch (error) {
logger.error(
{ error, serverName: this.serverName, appUri, context },
"Failed to execute app on MCP server",
);
throw error;
}
}

/**
* Convert MCP tools to Archestra tools
*/
async getTools(): Promise<ArchestraTool[]> {
const mcpTools = await this.listTools();
const appResources = await this.getAppResources();

const tools: ArchestraTool[] = [];

// Convert regular MCP tools
for (const mcpTool of mcpTools) {
tools.push({
id: `${this.serverName}.${mcpTool.name}`,
name: mcpTool.name,
description: mcpTool.description || `Tool from ${this.serverName}`,
inputSchema: mcpTool.inputSchema,
source: "mcp",
sourceId: this.serverName,
metadata: {
mcpServer: this.serverName,
isApp: false,
},
});
}

// Convert app resources to app tools
for (const appResource of appResources) {
const toolName = `app_${appResource.name.replace(/[^a-zA-Z0-9_]/g, "_")}`;
const toolDefinition: McpAppToolDefinition = {
name: toolName,
description: appResource.description || `App: ${appResource.name}`,
inputSchema: {
type: "object",
properties: {
context: {
type: "object",
description: "Initial context for the app",
additionalProperties: true,
},
},
},
appMetadata: {
uri: appResource.uri,
title: appResource.appMetadata?.title || appResource.name,
description: appResource.appMetadata?.description || appResource.description,
width: appResource.appMetadata?.width || 800,
height: appResource.appMetadata?.height || 600,
resizable: appResource.appMetadata?.resizable ?? true,
embeddable: appResource.appMetadata?.embeddable ?? true,
},
};

tools.push({
id: `${this.serverName}.${toolName}`,
name: toolName,
description: toolDefinition.description,
inputSchema: toolDefinition.inputSchema,
source: "mcp",
sourceId: this.serverName,
metadata: {
mcpServer: this.serverName,
isApp: true,
appMetadata: toolDefinition.appMetadata,
},
});
}

return tools;
}

/**
* Get the server name
*/
getServerName(): string {
return this.serverName;
}

/**
* Get the authentication context
*/
getAuthContext(): TokenAuthContext | undefined {
return this.authContext;
}

/**
* Close the MCP client connection
*/
async close(): Promise<void> {
try {
await this.client.close();
} catch (error) {
logger.warn(
{ error, serverName: this.serverName },
"Error closing MCP client",
);
}
}
}
