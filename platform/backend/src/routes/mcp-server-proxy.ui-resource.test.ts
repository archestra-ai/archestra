import { ADMIN_ROLE_NAME } from "@archestra/shared";
import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { vi } from "vitest";
import mcpClient from "@/clients/mcp-client";
import { afterEach, describe, expect, test } from "@/test";
import { ApiError } from "@/types";
import mcpServerProxyRoutes from "./mcp-server-proxy";

/**
 * Verifies the tech contracts an external MCP host (e.g. Claude Desktop) needs
 * for an installed external server to work AS AN MCP APP through the
 * server-scoped proxy (`POST /api/mcp/server/:mcpServerId`), which is the
 * "behaviour in main": the host must be able to (1) see a tool carrying an
 * `_meta.ui.resourceUri` (`ui://`) UI pointer in tools/list, (2) read that
 * `ui://` resource via resources/read, and (3) call the tool. This exercises the
 * REAL `createServerScopedServer` (the sibling mcp-server-proxy.test.ts stubs
 * it) and mocks only the upstream MCP boundary (`mcpClient`).
 */

async function buildApp(
  userId: string,
  organizationId: string,
): Promise<FastifyInstance> {
  const app = Fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.decorateRequest("user");
  app.decorateRequest("organizationId");
  app.addHook("preHandler", (request, _reply, done) => {
    // biome-ignore lint/suspicious/noExplicitAny: test hook sets auth context
    (request as any).user = { id: userId, email: "t@t.com", name: "T" };
    // biome-ignore lint/suspicious/noExplicitAny: test hook sets auth context
    (request as any).organizationId = organizationId;
    done();
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ApiError) {
      return reply
        .status(error.statusCode)
        .send({ error: { message: error.message, type: error.type } });
    }
    const err = error as Error & { statusCode?: number };
    return reply
      .status(err.statusCode ?? 500)
      .send({ error: { message: err.message } });
  });
  await app.register(mcpServerProxyRoutes);
  return app;
}

const JSON_RPC_HEADERS = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
};
const rpc = (method: string, params?: unknown) => ({
  jsonrpc: "2.0",
  id: 1,
  method,
  ...(params !== undefined ? { params } : {}),
});

// A UI-providing tool as a real external MCP-Apps server would expose it.
const UI_RESOURCE_URI = "ui://clock-server/clock.html";

describe("external UI server served as an MCP App (POST /api/mcp/server/:id)", () => {
  let app: FastifyInstance;
  afterEach(async () => {
    vi.restoreAllMocks();
    if (app) await app.close();
  });

  test("tools/list exposes the tool's _meta.ui.resourceUri (the host's UI pointer)", async ({
    makeUser,
    makeOrganization,
    makeMember,
    makeInternalMcpCatalog,
    makeMcpServer,
    makeTool,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: ADMIN_ROLE_NAME });
    const catalog = await makeInternalMcpCatalog({
      organizationId: org.id,
      serverType: "remote",
      serverUrl: "https://example.com/mcp",
      scope: "org",
    });
    const server = await makeMcpServer({ catalogId: catalog.id, scope: "org" });
    await makeTool({
      catalogId: catalog.id,
      name: "show_clock",
      meta: { _meta: { ui: { resourceUri: UI_RESOURCE_URI } } },
    });
    app = await buildApp(user.id, org.id);

    const res = await app.inject({
      method: "POST",
      url: `/api/mcp/server/${server.id}`,
      headers: JSON_RPC_HEADERS,
      payload: rpc("tools/list"),
    });

    expect(res.statusCode).toBe(200);
    const tools = res.json().result.tools as Array<{
      name: string;
      inputSchema?: { type?: string };
      _meta?: { ui?: { resourceUri?: string } };
    }>;
    // The host calls by the upstream's raw (unslugified) tool name.
    const uiTool = tools.find((t) => t.name === "show_clock");
    expect(uiTool).toBeDefined();
    // The UI pointer the host reads to discover the renderable resource.
    expect(uiTool?._meta?.ui?.resourceUri).toBe(UI_RESOURCE_URI);
    // A host needs a usable JSON-Schema inputSchema for every listed tool.
    expect(uiTool?.inputSchema?.type).toBe("object");
  });

  test("resources/read of the ui:// resource is served from the upstream server", async ({
    makeUser,
    makeOrganization,
    makeMember,
    makeInternalMcpCatalog,
    makeMcpServer,
    makeTool,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: ADMIN_ROLE_NAME });
    const catalog = await makeInternalMcpCatalog({
      organizationId: org.id,
      serverType: "remote",
      serverUrl: "https://example.com/mcp",
      scope: "org",
    });
    const server = await makeMcpServer({ catalogId: catalog.id, scope: "org" });
    await makeTool({
      catalogId: catalog.id,
      name: "show_clock",
      meta: { _meta: { ui: { resourceUri: UI_RESOURCE_URI } } },
    });

    const readSpy = vi
      .spyOn(mcpClient, "readResourceForServer")
      .mockResolvedValue({
        contents: [
          {
            uri: UI_RESOURCE_URI,
            mimeType: "text/html",
            text: "<h1>clock</h1>",
            _meta: {
              ui: { csp: { connect_src: ["https://api.example.com"] } },
            },
          },
        ],
      } as Awaited<ReturnType<typeof mcpClient.readResourceForServer>>);

    app = await buildApp(user.id, org.id);

    const res = await app.inject({
      method: "POST",
      url: `/api/mcp/server/${server.id}`,
      headers: JSON_RPC_HEADERS,
      payload: rpc("resources/read", { uri: UI_RESOURCE_URI }),
    });

    expect(res.statusCode).toBe(200);
    const content = res.json().result.contents[0] as {
      uri: string;
      mimeType?: string;
      text?: string;
      _meta?: { ui?: { csp?: unknown } };
    };
    expect(content.uri).toBe(UI_RESOURCE_URI);
    expect(content.text).toContain("clock");
    // The host keys on the resource mimeType, and applies the author-declared
    // CSP to sandbox the iframe — both must reach the host unchanged from the
    // upstream server (this path passes the upstream resource through verbatim).
    expect(content.mimeType).toBe("text/html");
    expect(content._meta?.ui?.csp).toEqual({
      connect_src: ["https://api.example.com"],
    });
    // The read is delegated to THIS installed server, bound from the route.
    expect(readSpy).toHaveBeenCalledWith({
      mcpServerId: server.id,
      uri: UI_RESOURCE_URI,
    });
  });

  test("tools/call is delegated to the installed server's own runtime", async ({
    makeUser,
    makeOrganization,
    makeMember,
    makeInternalMcpCatalog,
    makeMcpServer,
    makeTool,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: ADMIN_ROLE_NAME });
    const catalog = await makeInternalMcpCatalog({
      organizationId: org.id,
      serverType: "remote",
      serverUrl: "https://example.com/mcp",
      scope: "org",
    });
    const server = await makeMcpServer({ catalogId: catalog.id, scope: "org" });
    await makeTool({
      catalogId: catalog.id,
      name: "show_clock",
      meta: { _meta: { ui: { resourceUri: UI_RESOURCE_URI } } },
    });

    const callSpy = vi.spyOn(mcpClient, "callToolForServer").mockResolvedValue({
      content: [{ type: "text", text: "12:00" }],
    } as Awaited<ReturnType<typeof mcpClient.callToolForServer>>);

    app = await buildApp(user.id, org.id);

    const res = await app.inject({
      method: "POST",
      url: `/api/mcp/server/${server.id}`,
      headers: JSON_RPC_HEADERS,
      payload: rpc("tools/call", { name: "show_clock", arguments: {} }),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().result.content[0].text).toBe("12:00");
    expect(callSpy).toHaveBeenCalledWith({
      mcpServerId: server.id,
      name: "show_clock",
      arguments: {},
    });
  });

  test("initialize advertises the MCP Apps extension capability to the host", async ({
    makeUser,
    makeOrganization,
    makeMember,
    makeInternalMcpCatalog,
    makeMcpServer,
    makeTool,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: ADMIN_ROLE_NAME });
    const catalog = await makeInternalMcpCatalog({
      organizationId: org.id,
      serverType: "remote",
      serverUrl: "https://example.com/mcp",
      scope: "org",
    });
    const server = await makeMcpServer({ catalogId: catalog.id, scope: "org" });
    await makeTool({
      catalogId: catalog.id,
      name: "show_clock",
      meta: { _meta: { ui: { resourceUri: UI_RESOURCE_URI } } },
    });
    app = await buildApp(user.id, org.id);

    const res = await app.inject({
      method: "POST",
      url: `/api/mcp/server/${server.id}`,
      headers: JSON_RPC_HEADERS,
      payload: rpc("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "host", version: "1.0.0" },
      }),
    });

    expect(res.statusCode).toBe(200);
    const result = res.json().result as {
      protocolVersion?: string;
      capabilities?: { extensions?: Record<string, unknown> };
    };
    // The host negotiates MCP-App support from the extensions capability — it is
    // present despite the SDK not modelling `extensions` (verified to survive
    // the initialize round-trip).
    expect(result.capabilities?.extensions).toHaveProperty(
      "io.modelcontextprotocol/ui",
    );
    expect(typeof result.protocolVersion).toBe("string");
    expect(result.protocolVersion?.length).toBeGreaterThan(0);
  });
});
