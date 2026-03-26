/**
 * mcp-app-proxy.test.ts
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";

// ── Mocks (MUST be before imports that use them) ───────────────────────────

vi.mock("../clients/mcp-client", () => ({
  mcpClient: {
    readResource: vi.fn(),
    findToolByName: vi.fn(),
    callTool: vi.fn(),
  },
}));

vi.mock("../features/agents/agent-access", () => ({
  verifyAgentAccess: vi.fn(),
}));

// ── Imports AFTER mocks ────────────────────────────────────────────────────

import mcpAppProxyRoutes from "./mcp-app-proxy";
import { mcpClient } from "../clients/mcp-client";
import { verifyAgentAccess } from "../features/agents/agent-access";

// ── Constants ──────────────────────────────────────────────────────────────

const MOCK_AGENT_ID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";

const MOCK_USER = {
  id: "user-id",
  name: "Test User",
  email: "test@example.com",
  emailVerified: true,
  image: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  role: null,
  banned: false,
  banReason: null,
  banExpires: null,
  twoFactorEnabled: false,
  organizationId: "org-id",
};

// Cast once (fixes ALL TS errors about missing methods)
const mockedMcpClient = mcpClient as unknown as {
  readResource: ReturnType<typeof vi.fn>;
  findToolByName: ReturnType<typeof vi.fn>;
  callTool: ReturnType<typeof vi.fn>;
};

// ── App builder ────────────────────────────────────────────────────────────

async function buildApp() {
  const app = Fastify();

  app.addHook("preHandler", async (req) => {
    (req as typeof req & { user: typeof MOCK_USER }).user = MOCK_USER;
  });

  await app.register(mcpAppProxyRoutes);
  return app;
}

// ── /resource ─────────────────────────────────────────────────────────────

describe("POST /api/mcp-app/resource", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (verifyAgentAccess as any).mockResolvedValue(true);
  });

  it("rejects non-ui:// URIs", async () => {
    const app = await buildApp();

    const res = await app.inject({
      method: "POST",
      url: "/api/mcp-app/resource",
      payload: { uri: "https://evil.com", agentId: MOCK_AGENT_ID },
    });

    expect(res.statusCode).toBe(400);
  });

  it("rejects invalid agentId", async () => {
    const app = await buildApp();

    const res = await app.inject({
      method: "POST",
      url: "/api/mcp-app/resource",
      payload: { uri: "ui://test", agentId: "bad-id" },
    });

    expect(res.statusCode).toBe(400);
  });

  it("returns 403 if no access", async () => {
    (verifyAgentAccess as any).mockResolvedValue(false);

    const app = await buildApp();

    const res = await app.inject({
      method: "POST",
      url: "/api/mcp-app/resource",
      payload: { uri: "ui://test", agentId: MOCK_AGENT_ID },
    });

    expect(res.statusCode).toBe(403);
  });

  it("returns HTML when found", async () => {
    mockedMcpClient.readResource.mockResolvedValue({
      contents: [{ text: "<html>Hello</html>", mimeType: "text/html" }],
    });

    const app = await buildApp();

    const res = await app.inject({
      method: "POST",
      url: "/api/mcp-app/resource",
      payload: { uri: "ui://test", agentId: MOCK_AGENT_ID },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().html).toContain("<html>");
  });

  it("returns 404 if no HTML", async () => {
    mockedMcpClient.readResource.mockResolvedValue({
      contents: [{ text: null }],
    });

    const app = await buildApp();

    const res = await app.inject({
      method: "POST",
      url: "/api/mcp-app/resource",
      payload: { uri: "ui://test", agentId: MOCK_AGENT_ID },
    });

    expect(res.statusCode).toBe(404);
  });

  it("returns 500 on error", async () => {
    mockedMcpClient.readResource.mockRejectedValue(new Error("timeout"));

    const app = await buildApp();

    const res = await app.inject({
      method: "POST",
      url: "/api/mcp-app/resource",
      payload: { uri: "ui://test", agentId: MOCK_AGENT_ID },
    });

    expect(res.statusCode).toBe(500);
  });
});

// ── /tool-call ────────────────────────────────────────────────────────────

describe("POST /api/mcp-app/tool-call", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (verifyAgentAccess as any).mockResolvedValue(true);
  });

  it("blocks model-only tools", async () => {
    mockedMcpClient.findToolByName.mockResolvedValue({
      name: "tool",
      _meta: { ui: { visibility: ["model"] } },
    });

    const app = await buildApp();

    const res = await app.inject({
      method: "POST",
      url: "/api/mcp-app/tool-call",
      payload: {
        agentId: MOCK_AGENT_ID,
        toolName: "tool",
        args: {},
      },
    });

    expect(res.statusCode).toBe(403);
  });

  it("allows app tools", async () => {
    mockedMcpClient.findToolByName.mockResolvedValue({
      name: "tool",
      _meta: { ui: { visibility: ["model", "app"] } },
    });

    mockedMcpClient.callTool.mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
    });

    const app = await buildApp();

    const res = await app.inject({
      method: "POST",
      url: "/api/mcp-app/tool-call",
      payload: {
        agentId: MOCK_AGENT_ID,
        toolName: "tool",
        args: {},
      },
    });

    expect(res.statusCode).toBe(200);
  });

  it("returns 404 for unknown tool", async () => {
    mockedMcpClient.findToolByName.mockResolvedValue(null);

    const app = await buildApp();

    const res = await app.inject({
      method: "POST",
      url: "/api/mcp-app/tool-call",
      payload: {
        agentId: MOCK_AGENT_ID,
        toolName: "unknown",
        args: {},
      },
    });

    expect(res.statusCode).toBe(404);
  });
});