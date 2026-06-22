import {
  TOOL_CREATE_TOOL_INVOCATION_POLICY_FULL_NAME,
  TOOL_DELETE_TRUSTED_DATA_POLICY_FULL_NAME,
  TOOL_GET_TOOL_INVOCATION_POLICIES_FULL_NAME,
} from "@archestra/shared";
import { ToolInvocationPolicyModel } from "@/models";
import { describe, expect, test } from "@/test";

const CONTEXT = { teamIds: [] as string[] };

/**
 * The deprecated governance-mutating platform tools (policy create/update/delete)
 * do NOT bypass tool-invocation policies: a seeded unconditional require_approval
 * policy gates every call, surviving permissive mode — the same protection
 * archestra__api writes get. Their read counterparts still bypass.
 */
describe("checkApprovalRequired for governance-mutating policy tools", () => {
  test("an unconditional approval policy gates a policy-write tool", async ({
    makeTool,
    makeToolPolicy,
  }) => {
    const tool = await makeTool({
      name: TOOL_CREATE_TOOL_INVOCATION_POLICY_FULL_NAME,
    });
    await makeToolPolicy(tool.id, {
      conditions: [],
      action: "require_approval",
    });

    expect(
      await ToolInvocationPolicyModel.checkApprovalRequired(
        TOOL_CREATE_TOOL_INVOCATION_POLICY_FULL_NAME,
        {},
        CONTEXT,
        "restrictive",
      ),
    ).toBe(true);
  });

  test("the gate survives permissive mode", async ({
    makeTool,
    makeToolPolicy,
  }) => {
    const tool = await makeTool({
      name: TOOL_DELETE_TRUSTED_DATA_POLICY_FULL_NAME,
    });
    await makeToolPolicy(tool.id, {
      conditions: [],
      action: "require_approval",
    });

    expect(
      await ToolInvocationPolicyModel.checkApprovalRequired(
        TOOL_DELETE_TRUSTED_DATA_POLICY_FULL_NAME,
        {},
        CONTEXT,
        "permissive",
      ),
    ).toBe(true);
  });

  test("policy read tools still bypass approval", async ({
    makeTool,
    makeToolPolicy,
  }) => {
    const tool = await makeTool({
      name: TOOL_GET_TOOL_INVOCATION_POLICIES_FULL_NAME,
    });
    await makeToolPolicy(tool.id, {
      conditions: [],
      action: "require_approval",
    });

    // get_tool_invocation_policies is not governance-mutating: it bypasses, so a
    // matching require_approval policy is never consulted.
    expect(
      await ToolInvocationPolicyModel.checkApprovalRequired(
        TOOL_GET_TOOL_INVOCATION_POLICIES_FULL_NAME,
        {},
        CONTEXT,
        "restrictive",
      ),
    ).toBe(false);
  });
});
