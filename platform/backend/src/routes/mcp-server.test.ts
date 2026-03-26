import { vi } from "vitest";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

const {
  inspectServerMock,
  MockMcpServerConnectionTimeoutError,
  MockMcpServerNotReadyError,
} = vi.hoisted(() => ({
  inspectServerMock: vi.fn(),
  MockMcpServerNotReadyError: class MockMcpServerNotReadyError extends Error {},
  MockMcpServerConnectionTimeoutError: class MockMcpServerConnectionTimeoutError extends Error {},
}));

vi.mock("@/clients/mcp-client", () => ({
  McpServerNotReadyError: MockMcpServerNotReadyError,
  McpServerConnectionTimeoutError: MockMcpServerConnectionTimeoutError,
  default: {
    inspectServer: inspectServerMock,
  },
}));

describe("mcp server inspect route", () => {
  let app: FastifyInstanceWithZod;
  let user: User;

  beforeEach(async ({ makeUser }) => {
    user = await makeUser();

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { user: User }).user = user;
    });

    const { default: mcpServerRoutes } = await import("./mcp-server");
    await app.register(mcpServerRoutes);
  });

  afterEach(async () => {
    inspectServerMock.mockReset();
    await app.close();
  });

  test("returns 409 when the MCP server is not running yet", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    const catalog = await makeInternalMcpCatalog({ serverType: "local" });
    const mcpServer = await makeMcpServer({
      ownerId: user.id,
      catalogId: catalog.id,
    });

    inspectServerMock.mockRejectedValueOnce(
      new MockMcpServerNotReadyError(
        "MCP server is not running yet. Start or restart it, then try inspecting it again.",
      ),
    );

    const response = await app.inject({
      method: "POST",
      url: `/api/mcp_server/${mcpServer.id}/inspect`,
      payload: { method: "tools/list" },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: {
        message:
          "MCP server is not running yet. Start or restart it, then try inspecting it again.",
        type: "api_conflict_error",
      },
    });
  });

  test("returns 409 when the MCP server times out during inspection", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    const catalog = await makeInternalMcpCatalog({ serverType: "local" });
    const mcpServer = await makeMcpServer({
      ownerId: user.id,
      catalogId: catalog.id,
    });

    inspectServerMock.mockRejectedValueOnce(
      new MockMcpServerConnectionTimeoutError(
        "MCP server did not become reachable within 30 seconds. Verify its configuration and runtime logs, then try again.",
      ),
    );

    const response = await app.inject({
      method: "POST",
      url: `/api/mcp_server/${mcpServer.id}/inspect`,
      payload: { method: "tools/list" },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: {
        message:
          "MCP server did not become reachable within 30 seconds. Verify its configuration and runtime logs, then try again.",
        type: "api_conflict_error",
      },
    });
  });

  test("keeps unexpected inspect failures as 502 responses", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    const catalog = await makeInternalMcpCatalog({ serverType: "local" });
    const mcpServer = await makeMcpServer({
      ownerId: user.id,
      catalogId: catalog.id,
    });

    inspectServerMock.mockRejectedValueOnce(new Error("Unexpected failure"));

    const response = await app.inject({
      method: "POST",
      url: `/api/mcp_server/${mcpServer.id}/inspect`,
      payload: { method: "tools/list" },
    });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({
      error: {
        message: "Failed to inspect MCP server: Unexpected failure",
        type: "unknown_api_error",
      },
    });
  });
});
