import { TOOL_API_FULL_NAME, TOOL_WHOAMI_FULL_NAME } from "@archestra/shared";
import { ToolInvocationPolicyModel } from "@/models";
import { describe, expect, test } from "@/test";

const CONTEXT = { teamIds: [] as string[] };

/**
 * archestra__api is the one built-in tool that does NOT bypass tool-invocation
 * policies — its writes are approval-gated, and admins can relax that per route.
 */
describe("checkApprovalRequired for archestra__api", () => {
  test("default policy gates non-GET, leaves GET open", async ({
    makeTool,
    makeToolPolicy,
  }) => {
    const tool = await makeTool({ name: TOOL_API_FULL_NAME });
    await makeToolPolicy(tool.id, {
      conditions: [{ key: "method", operator: "notEqual", value: "GET" }],
      action: "require_approval",
    });

    const approvalFor = (method: string) =>
      ToolInvocationPolicyModel.checkApprovalRequired(
        TOOL_API_FULL_NAME,
        { method, path: "/api/agents" },
        CONTEXT,
        "restrictive",
      );

    expect(await approvalFor("POST")).toBe(true);
    expect(await approvalFor("DELETE")).toBe(true);
    expect(await approvalFor("GET")).toBe(false);
  });

  test("an allow override suppresses the default approval, regardless of insertion order", async ({
    makeTool,
    makeToolPolicy,
  }) => {
    const tool = await makeTool({ name: TOOL_API_FULL_NAME });
    // the broad default gate is inserted first...
    await makeToolPolicy(tool.id, {
      conditions: [{ key: "method", operator: "notEqual", value: "GET" }],
      action: "require_approval",
    });
    // ...and the narrower relaxation second; it must still win.
    await makeToolPolicy(tool.id, {
      conditions: [{ key: "path", operator: "contains", value: "/search" }],
      action: "allow_when_context_is_untrusted",
    });

    // read-shaped POST matched by the relaxation: no approval.
    expect(
      await ToolInvocationPolicyModel.checkApprovalRequired(
        TOOL_API_FULL_NAME,
        { method: "POST", path: "/api/registry/search" },
        CONTEXT,
        "restrictive",
      ),
    ).toBe(false);

    // an ordinary write is still gated.
    expect(
      await ToolInvocationPolicyModel.checkApprovalRequired(
        TOOL_API_FULL_NAME,
        { method: "POST", path: "/api/agents" },
        CONTEXT,
        "restrictive",
      ),
    ).toBe(true);
  });

  test("default permissive org still gates non-GET, leaves GET open", async ({
    makeTool,
    makeToolPolicy,
  }) => {
    const tool = await makeTool({ name: TOOL_API_FULL_NAME });
    await makeToolPolicy(tool.id, {
      conditions: [{ key: "method", operator: "notEqual", value: "GET" }],
      action: "require_approval",
    });

    // permissive is the default org policy; the seeded gate must survive it.
    const approvalFor = (method: string) =>
      ToolInvocationPolicyModel.checkApprovalRequired(
        TOOL_API_FULL_NAME,
        { method, path: "/api/agents" },
        CONTEXT,
        "permissive",
      );

    expect(await approvalFor("POST")).toBe(true);
    expect(await approvalFor("GET")).toBe(false);
  });

  test("permissive mode keeps bypassing approval for ordinary archestra tools", async ({
    makeTool,
    makeToolPolicy,
  }) => {
    const tool = await makeTool({ name: TOOL_WHOAMI_FULL_NAME });
    await makeToolPolicy(tool.id, {
      conditions: [{ key: "method", operator: "notEqual", value: "GET" }],
      action: "require_approval",
    });

    // only archestra__api is carved out of the permissive short-circuit.
    expect(
      await ToolInvocationPolicyModel.checkApprovalRequired(
        TOOL_WHOAMI_FULL_NAME,
        { method: "POST" },
        CONTEXT,
        "permissive",
      ),
    ).toBe(false);
  });

  test("other archestra tools bypass policies entirely", async ({
    makeTool,
    makeToolPolicy,
  }) => {
    const tool = await makeTool({ name: TOOL_WHOAMI_FULL_NAME });
    await makeToolPolicy(tool.id, {
      conditions: [{ key: "method", operator: "notEqual", value: "GET" }],
      action: "require_approval",
    });

    // whoami is bypassed: a matching require_approval policy is never consulted.
    expect(
      await ToolInvocationPolicyModel.checkApprovalRequired(
        TOOL_WHOAMI_FULL_NAME,
        { method: "POST" },
        CONTEXT,
        "restrictive",
      ),
    ).toBe(false);
  });
});
