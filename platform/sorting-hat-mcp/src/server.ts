import crypto from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { pathToFileURL } from "node:url";
import {
  McpServer,
  ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  authorizeTravel,
  castPatronus,
  createQuidditchEvents,
  MCP_APP_MIME_TYPE,
  type PatronusResult,
  renderFlooHtml,
  renderPatronusHtml,
  renderQuidditchHtml,
  renderSortingHatHtml,
  type SortResult,
  sortTool,
} from "./domain.js";

const DEFAULT_PORT = 3469;
const DEFAULT_BASE_URL = `http://localhost:${DEFAULT_PORT}`;
const RESOURCE_TEMPLATE = "sorting-hat://app/{id}";

type ServerConfig = {
  port: number;
  baseUrl: string;
};

type AppResource = {
  html: string;
};

type ResourceContent = {
  uri: string;
  mimeType: typeof MCP_APP_MIME_TYPE;
  text: string;
  _meta: {
    ui: {
      csp: {
        connectDomains: string[];
        resourceDomains: string[];
      };
      permissions: Record<string, boolean>;
    };
  };
};

export function createApp(config: Partial<ServerConfig> = {}): Server {
  const resolvedConfig = getServerConfig(config);
  const resources = new Map<string, AppResource>();

  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", resolvedConfig.baseUrl);
      if (req.method === "GET" && url.pathname === "/health") {
        sendJson(res, 200, { status: "ok" });
        return;
      }

      if (
        req.method === "GET" &&
        url.pathname.startsWith("/events/quidditch/")
      ) {
        const toolCallId = decodeURIComponent(
          url.pathname.slice("/events/quidditch/".length),
        );
        streamQuidditchEvents(req, res, toolCallId);
        return;
      }

      if (url.pathname === "/mcp" && req.method === "POST") {
        await handleMcpRequest({
          request: req,
          response: res,
          resources,
          baseUrl: resolvedConfig.baseUrl,
          body: await readJsonBody(req),
        });
        return;
      }

      if (
        url.pathname === "/mcp" &&
        (req.method === "GET" || req.method === "DELETE")
      ) {
        sendJson(res, 405, { error: "Method not allowed" });
        return;
      }

      sendJson(res, 404, { error: "Not found" });
    } catch (error) {
      sendJson(res, 500, {
        error: error instanceof Error ? error.message : "Internal server error",
      });
    }
  });
}

export async function startServer(
  config: Partial<ServerConfig> = {},
): Promise<void> {
  const resolvedConfig = getServerConfig(config);
  const app = createApp(resolvedConfig);

  await new Promise<void>((resolve, reject) => {
    app.listen(resolvedConfig.port, "0.0.0.0", () => {
      console.info(
        `sorting-hat-mcp listening on ${resolvedConfig.baseUrl}/mcp`,
      );
      resolve();
    });
    app.once("error", reject);
  });
}

function createMcpServer(params: {
  resources: Map<string, AppResource>;
  request: IncomingMessage;
  baseUrl: string;
}): McpServer {
  const server = new McpServer({
    name: "sorting-hat-mcp",
    version: "0.1.0",
  });

  registerResourceHandler(server, params.resources);
  registerTools(server, params);
  return server;
}

function registerResourceHandler(
  server: McpServer,
  resources: Map<string, AppResource>,
): void {
  server.resource(
    "sorting-hat-app",
    new ResourceTemplate(RESOURCE_TEMPLATE, { list: undefined }),
    (uri, variables) => {
      const id = String(variables.id);
      const resource = resources.get(id);
      if (!resource) {
        throw new Error(`Unknown Sorting Hat MCP App resource: ${id}`);
      }

      return {
        contents: [createResourceContent(uri.href, resource.html)],
      };
    },
  );
}

function registerTools(
  server: McpServer,
  params: {
    resources: Map<string, AppResource>;
    request: IncomingMessage;
    baseUrl: string;
  },
): void {
  server.tool(
    "sorting_hat.sort",
    "Sort an MCP tool into a risk house and return an MCP App view.",
    {
      tool_name: z.string().min(1),
      tool_description: z.string().optional(),
    },
    async (args) => {
      const result = sortTool({
        toolName: args.tool_name,
        toolDescription: args.tool_description,
        pleaseNotSlytherin: hasPleaseNotSlytherinHeader(params.request),
      });
      const html = renderSortingHatHtml(result);
      return createToolResult({
        text: JSON.stringify(result, null, 2),
        structuredContent: result,
        resourceUri: storeResource(params.resources, html),
        html,
      });
    },
  );

  server.tool(
    "patronus.cast",
    "Cast a deterministic Patronus for an Archestra user.",
    {
      user_id: z.string().min(1),
      charm: z.literal("expecto_patronum"),
    },
    async (args) => {
      const result = castPatronus({
        userId: args.user_id,
        charm: args.charm,
      });
      const html = renderPatronusHtml(result);
      return createToolResult({
        text: JSON.stringify(result, null, 2),
        structuredContent: result,
        resourceUri: storeResource(params.resources, html),
        html,
      });
    },
  );

  server.tool(
    "floo.travel",
    "Authorize and route a tool payload between MCP servers.",
    {
      from_server: z.string().min(1),
      to_server: z.string().min(1),
      payload: z.unknown(),
      user_id: z.string().min(1),
      tool_name: z.string().min(1),
      tool_description: z.string().optional(),
    },
    async (args) => {
      const sortResult = sortTool({
        toolName: args.tool_name,
        toolDescription: args.tool_description,
        pleaseNotSlytherin: hasPleaseNotSlytherinHeader(params.request),
      });
      const patronus = castPatronus({
        userId: args.user_id,
        charm: "expecto_patronum",
      });
      const result = authorizeTravel({
        sortResult,
        patronus,
        fromServer: args.from_server,
        toServer: args.to_server,
        payload: args.payload,
      });
      const html = renderFlooHtml(result);
      return createToolResult({
        text: JSON.stringify(result, null, 2),
        structuredContent: result,
        resourceUri: storeResource(params.resources, html),
        html,
        isError: !result.authorized,
      });
    },
  );

  server.tool(
    "quidditch.stream",
    "Create a 60 fps progress event stream for a tool call.",
    {
      tool_call_id: z.string().min(1),
    },
    async (args) => {
      const events = createQuidditchEvents(args.tool_call_id, 60);
      const result = {
        toolCallId: args.tool_call_id,
        streamUrl: `${params.baseUrl}/events/quidditch/${encodeURIComponent(
          args.tool_call_id,
        )}`,
        framesPerSecond: 60,
        previewEvents: events.slice(0, 5),
      };
      const html = renderQuidditchHtml(args.tool_call_id);
      return createToolResult({
        text: JSON.stringify(result, null, 2),
        structuredContent: result,
        resourceUri: storeResource(params.resources, html),
        html,
      });
    },
  );
}

function createToolResult(params: {
  text: string;
  structuredContent: SortResult | PatronusResult | Record<string, unknown>;
  resourceUri: string;
  html: string;
  isError?: boolean;
}): CallToolResult {
  return {
    isError: params.isError ?? false,
    content: [
      { type: "text", text: params.text },
      {
        type: "resource",
        resource: createResourceContent(params.resourceUri, params.html),
      },
    ],
    structuredContent: params.structuredContent,
    _meta: {
      ui: {
        resourceUri: params.resourceUri,
      },
    },
  };
}

function storeResource(
  resources: Map<string, AppResource>,
  html: string,
): string {
  const id = crypto.randomUUID();
  resources.set(id, { html });
  return `sorting-hat://app/${id}`;
}

function createResourceContent(uri: string, html: string): ResourceContent {
  return {
    uri,
    mimeType: MCP_APP_MIME_TYPE,
    text: html,
    _meta: {
      ui: {
        csp: {
          connectDomains: [],
          resourceDomains: [],
        },
        permissions: {},
      },
    },
  };
}

async function handleMcpRequest(params: {
  request: IncomingMessage;
  response: ServerResponse;
  resources: Map<string, AppResource>;
  baseUrl: string;
  body?: unknown;
}): Promise<void> {
  const server = createMcpServer({
    resources: params.resources,
    request: params.request,
    baseUrl: params.baseUrl,
  });
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(params.request, params.response, params.body);
  } finally {
    await server.close();
  }
}

function streamQuidditchEvents(
  req: IncomingMessage,
  res: ServerResponse,
  toolCallId: string,
): void {
  const events = createQuidditchEvents(toolCallId, 120);
  let index = 0;

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });

  const timer = setInterval(() => {
    const event = events[index];
    if (!event) {
      clearInterval(timer);
      res.write("event: done\ndata: {}\n\n");
      res.end();
      return;
    }
    res.write(`event: progress\ndata: ${JSON.stringify(event)}\n\n`);
    index += 1;
  }, 1000 / 60);

  req.on("close", () => clearInterval(timer));
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > 1_000_000) {
      throw new Error("Request body too large");
    }
    chunks.push(buffer);
  }

  if (chunks.length === 0) {
    return undefined;
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(
  res: ServerResponse,
  statusCode: number,
  body: Record<string, unknown>,
): void {
  if (res.headersSent) {
    return;
  }
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function hasPleaseNotSlytherinHeader(req: IncomingMessage): boolean {
  const value = req.headers.please_not_slytherin;
  const headerValue = Array.isArray(value) ? value[0] : value;
  return headerValue?.toLowerCase() === "true";
}

function getServerConfig(config: Partial<ServerConfig>): ServerConfig {
  const port = config.port ?? Number(process.env.PORT || DEFAULT_PORT);
  const baseUrl = config.baseUrl ?? process.env.BASE_URL ?? DEFAULT_BASE_URL;
  return { port, baseUrl };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await startServer();
}
