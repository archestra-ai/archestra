// biome-ignore-all lint/suspicious/noExplicitAny: test
import {
  ARCHESTRA_MCP_SERVER_NAME,
  MCP_SERVER_TOOL_NAME_SEPARATOR,
} from "@shared";
import { beforeEach, describe, expect, test } from "@/test";
import type { Agent } from "@/types";
import { type ArchestraContext, executeArchestraTool } from ".";
import { tools } from "./mcp-servers";

describe("mcp server tools", () => {
  test("should have search_private_mcp_registry tool", () => {
    const tool = tools.find((t) =>
      t.name.endsWith("search_private_mcp_registry"),
    );
    expect(tool).toBeDefined();
    expect(tool?.title).toBe("Search Private MCP Registry");
  });

  test("should have get_mcp_servers tool", () => {
    const tool = tools.find((t) => t.name.endsWith("get_mcp_servers"));
    expect(tool).toBeDefined();
    expect(tool?.title).toBe("Get MCP Servers");
  });

  test("should have get_mcp_server_tools tool", () => {
    const tool = tools.find((t) => t.name.endsWith("get_mcp_server_tools"));
    expect(tool).toBeDefined();
    expect(tool?.title).toBe("Get MCP Server Tools");
  });

  test("should have edit_mcp tool", () => {
    const tool = tools.find((t) => t.name.endsWith("edit_mcp"));
    expect(tool).toBeDefined();
    expect(tool?.title).toBe("Edit MCP Server");
  });

  test("should have create_mcp_server_installation_request tool", () => {
    const tool = tools.find((t) =>
      t.name.endsWith("create_mcp_server_installation_request"),
    );
    expect(tool).toBeDefined();
    expect(tool?.title).toBe("Create MCP Server Installation Request");
  });
});

describe("mcp server tool execution", () => {
  let testAgent: Agent;
  let mockContext: ArchestraContext;

  beforeEach(async ({ makeAgent }) => {
    testAgent = await makeAgent({ name: "Test Agent" });
    mockContext = {
      agent: { id: testAgent.id, name: testAgent.name },
    };
  });

  test("get_mcp_server_tools returns error when mcpServerId is missing", async () => {
    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}get_mcp_server_tools`,
      {},
      mockContext,
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain(
      "mcpServerId parameter is required",
    );
  });

  test("get_mcp_servers returns catalog items", async () => {
    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}get_mcp_servers`,
      {},
      mockContext,
    );
    expect(result.isError).toBe(false);
    const parsed = JSON.parse((result.content[0] as any).text);
    expect(Array.isArray(parsed)).toBe(true);
  });

  test("search_private_mcp_registry with no results", async () => {
    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}search_private_mcp_registry`,
      { query: "nonexistent_mcp_server_xyz_999" },
      mockContext,
    );
    expect(result.isError).toBe(false);
    expect((result.content[0] as any).text).toContain("No MCP servers found");
  });

  test("edit_mcp returns error when id is missing", async () => {
    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}edit_mcp`,
      {},
      mockContext,
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain(
      "MCP server catalog id is required",
    );
  });

  test("edit_mcp returns error when user/org context is missing", async () => {
    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}edit_mcp`,
      { id: "some-id" },
      mockContext,
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain(
      "user/organization context not available",
    );
  });

  test("create_mcp_server_installation_request returns success message", async () => {
    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}create_mcp_server_installation_request`,
      {},
      mockContext,
    );
    expect(result.isError).toBe(false);
    expect((result.content[0] as any).text).toContain(
      "dialog for adding or requesting",
    );
  });
});
