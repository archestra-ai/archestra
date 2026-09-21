import {
  TOOL_POST_THREAD_FILE_FULL_NAME,
  TOOL_POST_THREAD_FILE_SHORT_NAME,
  TOOL_RUN_TOOL_FULL_NAME,
} from "@archestra/shared";
import { beforeEach, describe, expect, test } from "@/test";
import { type ArchestraContext, executeArchestraTool } from ".";

const senderArgs = {
  file_id: "chatops_file_3c8a9ad4-96ba-477d-b98a-212347144938",
  sha256: "a".repeat(64),
};

const entryPoints = [
  {
    name: "direct",
    toolName: TOOL_POST_THREAD_FILE_FULL_NAME,
    args: senderArgs,
  },
  {
    name: "run_tool with the full name",
    toolName: TOOL_RUN_TOOL_FULL_NAME,
    args: {
      tool_name: TOOL_POST_THREAD_FILE_FULL_NAME,
      tool_args: senderArgs,
    },
  },
  {
    name: "run_tool with the short name",
    toolName: TOOL_RUN_TOOL_FULL_NAME,
    args: {
      tool_name: TOOL_POST_THREAD_FILE_SHORT_NAME,
      tool_args: senderArgs,
    },
  },
];

describe("post_thread_file dispatch authorization", () => {
  let context: ArchestraContext;

  beforeEach(async ({ makeOrganization, makeUser, makeMember, makeAgent }) => {
    const organization = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, organization.id, { role: "admin" });
    const agent = await makeAgent({ organizationId: organization.id });
    context = {
      agent: { id: agent.id, name: agent.name },
      agentId: agent.id,
      organizationId: organization.id,
      userId: user.id,
      isolationKey: crypto.randomUUID(),
      chatOpsBindingId: crypto.randomUUID(),
      chatOpsThreadId: "1000.001",
      chatOpsMessageId: "1000.002",
    };
  });

  for (const entryPoint of entryPoints) {
    test(`${entryPoint.name} refuses an unassigned sender before source lookup`, async () => {
      const result = await executeArchestraTool(
        entryPoint.toolName,
        entryPoint.args,
        context,
      );

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        archestraError: { code: "tool_not_assigned" },
      });
    });

    test(`${entryPoint.name} requires agent:read even when the tool is assigned`, async ({
      makeCustomRole,
      makeUser,
      makeMember,
      seedAndAssignArchestraTools,
    }) => {
      const organizationId = context.organizationId as string;
      const restricted = await makeUser();
      const role = await makeCustomRole(organizationId, {
        permission: { file: ["manage"] },
      });
      await makeMember(restricted.id, organizationId, { role: role.role });
      await seedAndAssignArchestraTools(context.agent.id);

      const result = await executeArchestraTool(
        entryPoint.toolName,
        entryPoint.args,
        { ...context, userId: restricted.id },
      );

      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain("requires agent:read");
    });
  }
});
