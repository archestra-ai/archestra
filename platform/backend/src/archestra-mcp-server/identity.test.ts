// biome-ignore-all lint/suspicious/noExplicitAny: test
import {
  ARCHESTRA_MCP_SERVER_NAME,
  MCP_SERVER_TOOL_NAME_SEPARATOR,
} from "@shared";
import { beforeEach, describe, expect, test } from "@/test";
import type { Agent } from "@/types";
import { type ArchestraContext, executeArchestraTool } from ".";
import { tools } from "./identity";

describe("identity tools", () => {
  test("should have whoami tool with correct properties", () => {
    const whoami = tools.find((t) => t.name.endsWith("whoami"));
    expect(whoami).toBeDefined();
    expect(whoami?.title).toBe("Who Am I");
  });
});

describe("identity tool execution", () => {
  let testAgent: Agent;
  let mockContext: ArchestraContext;

  beforeEach(async ({ makeAgent }) => {
    testAgent = await makeAgent({ name: "Test Agent" });
    mockContext = {
      agent: { id: testAgent.id, name: testAgent.name },
    };
  });

  test("whoami returns agent name and ID", async () => {
    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}whoami`,
      undefined,
      mockContext,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toHaveLength(1);
    expect((result.content[0] as any).text).toContain("Agent Name:");
    expect((result.content[0] as any).text).toContain("Test Agent");
    expect((result.content[0] as any).text).toContain(testAgent.id);
  });
});
