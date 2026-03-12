// biome-ignore-all lint/suspicious/noExplicitAny: test
import {
  ARCHESTRA_MCP_SERVER_NAME,
  MCP_SERVER_TOOL_NAME_SEPARATOR,
} from "@shared";
import { beforeEach, describe, expect, test } from "@/test";
import type { Agent } from "@/types";
import { type ArchestraContext, executeArchestraTool } from ".";
import { tools } from "./agents";

describe("agent tools", () => {
  test("should have create_agent tool", () => {
    const tool = tools.find((t) => t.name.endsWith("create_agent"));
    expect(tool).toBeDefined();
    expect(tool?.title).toBe("Create Agent");
  });

  test("should have create_llm_proxy tool", () => {
    const tool = tools.find((t) => t.name.endsWith("create_llm_proxy"));
    expect(tool).toBeDefined();
    expect(tool?.title).toBe("Create LLM Proxy");
  });

  test("should have create_mcp_gateway tool", () => {
    const tool = tools.find((t) => t.name.endsWith("create_mcp_gateway"));
    expect(tool).toBeDefined();
    expect(tool?.title).toBe("Create MCP Gateway");
  });

  test("should have get_agent tool", () => {
    const tool = tools.find((t) => t.name.endsWith("get_agent"));
    expect(tool).toBeDefined();
    expect(tool?.title).toBe("Get Agent");
  });

  test("should have list_agents tool", () => {
    const tool = tools.find((t) => t.name.endsWith("list_agents"));
    expect(tool).toBeDefined();
    expect(tool?.title).toBe("List Agents");
  });

  test("should have edit_agent tool", () => {
    const tool = tools.find((t) => t.name.endsWith("edit_agent"));
    expect(tool).toBeDefined();
    expect(tool?.title).toBe("Edit Agent");
  });
});

describe("agent tool execution", () => {
  let testAgent: Agent;
  let mockContext: ArchestraContext;

  beforeEach(async ({ makeAgent }) => {
    testAgent = await makeAgent({ name: "Test Agent" });
    mockContext = {
      agent: { id: testAgent.id, name: testAgent.name },
    };
  });

  test("create_agent requires name", async () => {
    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}create_agent`,
      { name: "" },
      mockContext,
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain("name is required");
  });

  test("create_agent creates an agent successfully", async () => {
    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}create_agent`,
      { name: "New Test Agent" },
      mockContext,
    );
    expect(result.isError).toBe(false);
    expect((result.content[0] as any).text).toContain(
      "Successfully created agent",
    );
    expect((result.content[0] as any).text).toContain("New Test Agent");
  });

  test("create_llm_proxy creates a proxy successfully", async () => {
    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}create_llm_proxy`,
      { name: "Test LLM Proxy" },
      mockContext,
    );
    expect(result.isError).toBe(false);
    expect((result.content[0] as any).text).toContain(
      "Successfully created llm proxy",
    );
  });

  test("create_mcp_gateway creates a gateway successfully", async () => {
    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}create_mcp_gateway`,
      { name: "Test MCP Gateway" },
      mockContext,
    );
    expect(result.isError).toBe(false);
    expect((result.content[0] as any).text).toContain(
      "Successfully created mcp gateway",
    );
  });

  test("get_agent requires id or name", async () => {
    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}get_agent`,
      {},
      mockContext,
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain(
      "either id or name parameter is required",
    );
  });

  test("list_agents returns results", async () => {
    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}list_agents`,
      {},
      mockContext,
    );
    expect(result.isError).toBe(false);
    const parsed = JSON.parse((result.content[0] as any).text);
    expect(parsed).toHaveProperty("total");
    expect(parsed).toHaveProperty("agents");
  });
});
