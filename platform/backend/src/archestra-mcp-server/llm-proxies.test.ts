// biome-ignore-all lint/suspicious/noExplicitAny: test
import {
  ARCHESTRA_MCP_SERVER_NAME,
  MCP_SERVER_TOOL_NAME_SEPARATOR,
} from "@archestra/shared";
import { AgentModel } from "@/models";
import { beforeEach, describe, expect, test } from "@/test";
import type { Agent } from "@/types";
import { type ArchestraContext, executeArchestraTool } from ".";

describe("llm proxy tool execution", () => {
  let testAgent: Agent;
  let mockContext: ArchestraContext;

  beforeEach(async ({ makeAgent, makeUser, makeOrganization, makeMember }) => {
    const organization = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, organization.id, { role: "admin" });
    testAgent = await makeAgent({
      name: "Test Agent",
      organizationId: organization.id,
    });
    mockContext = {
      agent: { id: testAgent.id, name: testAgent.name },
      userId: user.id,
      organizationId: organization.id,
    };
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

  test("create_llm_proxy attributes the calling user as author", async () => {
    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}create_llm_proxy`,
      { name: "Attributed LLM Proxy" },
      mockContext,
    );

    expect(result.isError).toBe(false);

    const created = await AgentModel.findById(
      extractCreatedId(result),
      mockContext.userId,
      true,
    );
    expect(created?.scope).toBe("org");
    expect(created?.authorId).toBe(mockContext.userId);
  });

  test("edit_llm_proxy updates an llm proxy successfully", async ({
    makeAgent,
  }) => {
    const organizationId = mockContext.organizationId;
    if (!organizationId) {
      throw new Error("Expected organizationId in test context");
    }

    const llmProxy = await makeAgent({
      name: "Original LLM Proxy",
      agentType: "llm_proxy",
      organizationId,
    });

    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}edit_llm_proxy`,
      {
        id: llmProxy.id,
        name: "Updated LLM Proxy",
        labels: [{ key: "team", value: "platform" }],
      },
      mockContext,
    );

    expect(result.isError).toBe(false);
    expect((result.content[0] as any).text).toContain(
      "Successfully updated llm proxy",
    );

    const updated = await AgentModel.findById(
      llmProxy.id,
      mockContext.userId,
      true,
    );
    expect(updated?.name).toBe("Updated LLM Proxy");
    expect(updated?.labels).toContainEqual(
      expect.objectContaining({ key: "team", value: "platform" }),
    );
  });
});

function extractCreatedId(
  result: Awaited<ReturnType<typeof executeArchestraTool>>,
) {
  const createdId = ((result.content[0] as any).text as string)
    .split("\n")
    .find((line) => line.startsWith("ID: "))
    ?.replace("ID: ", "");

  if (!createdId) {
    throw new Error("Expected created resource id in tool output");
  }

  return createdId;
}
