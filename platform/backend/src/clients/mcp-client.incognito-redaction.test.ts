/**
 * Contract under test — incognito content redaction of persisted MCP tool
 * calls (executeToolCallForOwner with suppressContentLogging):
 * - the mcp_tool_calls row keeps the audit surface (tool name, method,
 *   server name, owner) but stores { __redacted: "incognito" } in place of
 *   both the arguments and the result — on the success path AND on an
 *   error-result path (unknown tool)
 * - the caller still receives the real tool result (redaction is at rest)
 * - without the flag, arguments and result persist normally
 *
 * The only mocked seam is the MCP SDK transport boundary (Client /
 * StreamableHTTPClientTransport / K8s runtime) — persistence runs real
 * against PGlite, exactly like mcp-client.test.ts.
 */
import { sql } from "drizzle-orm";
import { vi } from "vitest";
import config from "@/config";
import {
  _resetContentKeys,
  // biome-ignore lint/style/noRestrictedImports: dual-licensed code under test
} from "@/content-encryption/index.ee";
import db from "@/database";
import {
  AgentModel,
  AgentToolModel,
  InternalMcpCatalogModel,
  McpHttpSessionModel,
  McpServerModel,
  ToolModel,
} from "@/models";
import { secretManager } from "@/secrets-manager";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { agentOwner } from "@/types";
import mcpClient from "./mcp-client";

// Mock the MCP SDK client boundary (same seam as mcp-client.test.ts).
const mockCallTool = vi.fn();
const mockConnect = vi.fn();
const mockClose = vi.fn();
const mockListTools = vi.fn();
const mockListResources = vi.fn();
const mockSetRequestHandler = vi.fn();
const mockSetNotificationHandler = vi.fn();

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  // biome-ignore lint/suspicious/noExplicitAny: test..
  Client: vi.fn(function (this: any) {
    this.connect = mockConnect;
    this.callTool = mockCallTool;
    this.close = mockClose;
    this.listTools = mockListTools;
    this.listResources = mockListResources;
    this.setRequestHandler = mockSetRequestHandler;
    this.setNotificationHandler = mockSetNotificationHandler;
  }),
}));

vi.mock(
  "@modelcontextprotocol/sdk/client/streamableHttp.js",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@modelcontextprotocol/sdk/client/streamableHttp.js")
      >();
    return {
      ...actual,
      StreamableHTTPClientTransport: vi.fn(),
    };
  },
);

vi.mock("@/k8s/mcp-server-runtime", () => ({
  McpServerRuntimeManager: {
    usesStreamableHttp: vi.fn(),
    getHttpEndpointUrl: vi.fn(),
    getRunningPodHttpEndpoint: vi.fn(),
    getOrLoadDeployment: vi.fn(),
  },
}));

const TOOL_NAME = "github-mcp-server__list_repos";

describe("McpClient incognito tool-call redaction", () => {
  let agentId: string;

  beforeEach(async () => {
    // Force server-side content encryption at rest OFF so the raw
    // mcp_tool_calls rows show the incognito redaction marker directly —
    // local .env files may set ARCHESTRA_CONTENT_ENCRYPTION_SECRET, which
    // would wrap the (already redacted) values in server-key envelopes.
    // The config mutation is auto-restored after every test.
    config.contentEncryption.secret = undefined;
    _resetContentKeys();

    await mcpClient.disconnectAll();

    const agent = await AgentModel.create({
      name: "Incognito Test Agent",
      scope: "org",
      teams: [],
    });
    agentId = agent.id;

    const secret = await secretManager().createSecret(
      { access_token: "test-token-123" },
      "testmcptoken",
    );
    const catalogItem = await InternalMcpCatalogModel.create({
      name: "github-mcp-server",
      serverType: "remote",
      serverUrl: "https://api.githubcopilot.com/mcp/",
    });
    const mcpServer = await McpServerModel.create({
      name: "github-mcp-server",
      secretId: secret.id,
      catalogId: catalogItem.id,
      serverType: "remote",
    });

    const tool = await ToolModel.createToolIfNotExists({
      name: TOOL_NAME,
      description: "List repos",
      parameters: {},
      catalogId: catalogItem.id,
    });
    await AgentToolModel.create(agentId, tool.id, {
      mcpServerId: mcpServer.id,
    });

    vi.clearAllMocks();
    // Keep background HTTP-session persistence out of the picture.
    vi.spyOn(
      McpHttpSessionModel,
      "findRecordByConnectionKey",
    ).mockResolvedValue(null);
    vi.spyOn(McpHttpSessionModel, "upsert").mockResolvedValue(undefined);
    vi.spyOn(McpHttpSessionModel, "deleteByConnectionKey").mockResolvedValue(
      undefined,
    );
    vi.spyOn(McpHttpSessionModel, "deleteStaleSession").mockResolvedValue(
      undefined,
    );
    vi.spyOn(McpHttpSessionModel, "deleteExpired").mockResolvedValue(0);

    mockListTools.mockResolvedValue({ tools: [] });
    mockListResources.mockResolvedValue({ resources: [] });
    mockCallTool.mockResolvedValue({
      content: [{ type: "text", text: "the secret tool result" }],
      isError: false,
    });
  });

  afterEach(() => {
    // The shared teardown restores the pristine config after this hook;
    // clear the derived-key cache so later consumers re-derive from it.
    _resetContentKeys();
  });

  /** All persisted mcp_tool_calls rows, oldest first. */
  async function persistedToolCalls() {
    const result = await db.execute<{
      mcp_server_name: string;
      method: string;
      tool_call: { id: string; name: string; arguments: unknown } | null;
      tool_result: unknown;
      row_text: string;
    }>(
      sql`SELECT mcp_server_name, method, tool_call, tool_result,
                 (tool_call::text || tool_result::text) AS row_text
          FROM mcp_tool_calls ORDER BY created_at`,
    );
    return result.rows;
  }

  test("suppressContentLogging persists a redacted row but keeps the audit metadata and the live result", async () => {
    const result = await mcpClient.executeToolCallForOwner(
      {
        id: "call_incognito_success",
        name: TOOL_NAME,
        arguments: { owner: "octocat", query: "the secret arguments" },
      },
      agentOwner(agentId),
      undefined,
      { suppressContentLogging: true },
    );

    // The caller (the incognito chat turn) still gets the real result —
    // redaction applies to the persisted log only.
    expect(result.isError).toBe(false);
    expect(result.content).toEqual([
      { type: "text", text: "the secret tool result" },
    ]);

    const rows = await persistedToolCalls();
    expect(rows).toHaveLength(1);
    const row = rows[0];
    // Audit surface survives...
    expect(row.mcp_server_name).toBe("github-mcp-server");
    expect(row.method).toBe("tools/call");
    expect(row.tool_call?.id).toBe("call_incognito_success");
    expect(row.tool_call?.name).toBe(TOOL_NAME);
    // ...content does not.
    expect(row.tool_call?.arguments).toEqual({ __redacted: "incognito" });
    expect(row.tool_result).toEqual({ __redacted: "incognito" });
    expect(row.row_text).not.toContain("the secret arguments");
    expect(row.row_text).not.toContain("the secret tool result");
  });

  test("suppressContentLogging also redacts the error-result row for an unknown tool", async () => {
    const result = await mcpClient.executeToolCallForOwner(
      {
        id: "call_incognito_unknown",
        name: "github-mcp-server__no_such_tool",
        arguments: { query: "the secret arguments" },
      },
      agentOwner(agentId),
      undefined,
      { suppressContentLogging: true },
    );
    expect(result.isError).toBe(true);

    const rows = await persistedToolCalls();
    expect(rows).toHaveLength(1);
    expect(rows[0].tool_call?.arguments).toEqual({ __redacted: "incognito" });
    expect(rows[0].tool_result).toEqual({ __redacted: "incognito" });
    expect(rows[0].row_text).not.toContain("the secret arguments");
  });

  test("without the flag, arguments and result persist in full", async () => {
    await mcpClient.executeToolCallForOwner(
      {
        id: "call_plain",
        name: TOOL_NAME,
        arguments: { owner: "octocat", query: "plainly logged arguments" },
      },
      agentOwner(agentId),
    );

    const rows = await persistedToolCalls();
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.tool_call?.arguments).toEqual({
      owner: "octocat",
      query: "plainly logged arguments",
    });
    expect(row.row_text).toContain("the secret tool result");
    expect(row.row_text).not.toContain("__redacted");
  });
});
