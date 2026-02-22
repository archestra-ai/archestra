/**
* MCP App resource types and interfaces
*/

export interface McpAppResource {
uri: string;
name: string;
description?: string;
mimeType: string;
appMetadata?: {
title?: string;
description?: string;
width?: number;
height?: number;
resizable?: boolean;
embeddable?: boolean;
};
}

export interface McpAppMessage {
type: string;
data?: unknown;
requestId?: string;
}

export interface McpAppInitMessage extends McpAppMessage {
type: "init";
data: {
uri: string;
context?: Record<string, unknown>;
};
}

export interface McpAppResultMessage extends McpAppMessage {
type: "result";
data: unknown;
}

export interface McpAppErrorMessage extends McpAppMessage {
type: "error";
data: {
message: string;
code?: string;
};
}

export interface McpAppToolDefinition {
name: string;
description: string;
inputSchema: {
type: "object";
properties: Record<string, unknown>;
required?: string[];
};
appMetadata?: {
uri: string;
title?: string;
description?: string;
width?: number;
height?: number;
resizable?: boolean;
embeddable?: boolean;
};
}
