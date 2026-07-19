// biome-ignore-all lint/suspicious/noExplicitAny: test
import {
  ARCHESTRA_MCP_SERVER_NAME,
  MCP_SERVER_TOOL_NAME_SEPARATOR,
} from "@archestra/shared";
import { HookFileModel } from "@/models";
import { beforeEach, describe, expect, test } from "@/test";
import type { Agent } from "@/types";
import { type ArchestraContext, executeArchestraTool } from ".";

const toolName = (shortName: string) =>
  `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${shortName}`;

describe("hook tool execution", () => {
  let testAgent: Agent;
  let organizationId: string;
  let mockContext: ArchestraContext;

  beforeEach(async ({ makeAgent, makeUser, makeOrganization, makeMember }) => {
    const org = await makeOrganization();
    organizationId = org.id;
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: "admin" });
    testAgent = await makeAgent({
      name: "Test Agent",
      organizationId: org.id,
    });
    mockContext = {
      agent: { id: testAgent.id, name: testAgent.name },
      userId: user.id,
      organizationId: org.id,
    };
  });

  const createHook = (overrides: Record<string, unknown> = {}) =>
    executeArchestraTool(
      toolName("create_hook"),
      {
        agent_id: testAgent.id,
        event: "pre_tool_use",
        file_name: "check.py",
        content: "import sys\nsys.exit(0)\n",
        ...overrides,
      },
      mockContext,
    );

  // === create_hook ===

  test("create_hook persists the hook and returns it", async () => {
    const result = await createHook({ requirements: ["requests"] });
    expect(result.isError).toBe(false);
    const hook = (result.structuredContent as any).hook;
    expect(hook).toMatchObject({
      agentId: testAgent.id,
      event: "pre_tool_use",
      fileName: "check.py",
      requirements: ["requests"],
      enabled: true,
    });

    const persisted = await HookFileModel.listByAgent(
      testAgent.id,
      organizationId,
    );
    expect(persisted).toHaveLength(1);
    expect(persisted[0].fileName).toBe("check.py");
  });

  test("create_hook rejects an invalid file name", async () => {
    const result = await createHook({ file_name: "not-a-script.txt" });
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain("file_name");
  });

  test("create_hook surfaces the (agent, event, fileName) uniqueness conflict", async () => {
    await createHook();
    const result = await createHook();
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain("already exists");
  });

  test("create_hook treats a cross-org agent as not found", async ({
    makeAgent,
    makeOrganization,
  }) => {
    const otherOrg = await makeOrganization();
    const otherAgent = await makeAgent({
      name: "Other Org Agent",
      organizationId: otherOrg.id,
    });
    const result = await createHook({ agent_id: otherAgent.id });
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain("not found");
  });

  // === list_hooks ===

  test("list_hooks returns the agent's hooks", async () => {
    const empty = await executeArchestraTool(
      toolName("list_hooks"),
      { agent_id: testAgent.id },
      mockContext,
    );
    expect(empty.isError).toBe(false);
    expect((empty.structuredContent as any).hooks).toEqual([]);

    await createHook();
    const result = await executeArchestraTool(
      toolName("list_hooks"),
      { agent_id: testAgent.id },
      mockContext,
    );
    expect(result.isError).toBe(false);
    const hooks = (result.structuredContent as any).hooks;
    expect(hooks).toHaveLength(1);
    expect(hooks[0]).toMatchObject({
      event: "pre_tool_use",
      fileName: "check.py",
    });
  });

  // === update_hook ===

  test("update_hook updates fields and returns the new state", async () => {
    const created = await createHook();
    const hookId = (created.structuredContent as any).hook.id;

    const result = await executeArchestraTool(
      toolName("update_hook"),
      { id: hookId, enabled: false, content: "exit 0" },
      mockContext,
    );
    expect(result.isError).toBe(false);
    expect((result.structuredContent as any).hook).toMatchObject({
      id: hookId,
      enabled: false,
      content: "exit 0",
    });
  });

  test("update_hook requires at least one field besides the id", async () => {
    const created = await createHook();
    const hookId = (created.structuredContent as any).hook.id;

    const result = await executeArchestraTool(
      toolName("update_hook"),
      { id: hookId },
      mockContext,
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain("at least one field");
  });

  test("update_hook returns not found for an unknown id", async () => {
    const result = await executeArchestraTool(
      toolName("update_hook"),
      { id: "00000000-0000-4000-8000-000000000042", enabled: false },
      mockContext,
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain("not found");
  });

  // === delete_hook ===

  test("delete_hook removes the hook", async () => {
    const created = await createHook();
    const hookId = (created.structuredContent as any).hook.id;

    const result = await executeArchestraTool(
      toolName("delete_hook"),
      { id: hookId },
      mockContext,
    );
    expect(result.isError).toBe(false);
    expect(result.structuredContent as any).toMatchObject({
      success: true,
      id: hookId,
    });

    const remaining = await HookFileModel.listByAgent(
      testAgent.id,
      organizationId,
    );
    expect(remaining).toHaveLength(0);
  });

  test("delete_hook returns not found for an unknown id", async () => {
    const result = await executeArchestraTool(
      toolName("delete_hook"),
      { id: "00000000-0000-4000-8000-000000000042" },
      mockContext,
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain("not found");
  });

  // === RBAC ===

  test("create_hook is denied for a user without agent update permission", async ({
    makeUser,
  }) => {
    // Not a member of the org, so they hold no agent permissions in it.
    const outsider = await makeUser();

    const outsiderResult = await executeArchestraTool(
      toolName("create_hook"),
      {
        agent_id: testAgent.id,
        event: "session_start",
        file_name: "notify.sh",
        content: "exit 0",
      },
      { ...mockContext, userId: outsider.id },
    );
    expect(outsiderResult.isError).toBe(true);
    expect((outsiderResult.content[0] as any).text).toContain("permission");
  });
});
