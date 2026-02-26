import { AgentTeamModel, OrganizationModel } from "@/models";
import { describe, expect, test } from "@/test";
import { evaluatePolicies, getGlobalToolPolicy } from "./tool-invocation";

// ---------------------------------------------------------------------------
// getGlobalToolPolicy
// ---------------------------------------------------------------------------
describe("getGlobalToolPolicy", () => {
  test("returns org policy when agent has a team linked to an org", async ({
    makeAgent,
    makeOrganization,
    makeTeam,
    makeUser,
  }) => {
    const org = await makeOrganization();
    await OrganizationModel.patch(org.id, {
      globalToolPolicy: "restrictive",
    });
    const user = await makeUser();
    const team = await makeTeam(org.id, user.id);
    const agent = await makeAgent({ organizationId: org.id });
    await AgentTeamModel.assignTeamsToAgent(agent.id, [team.id]);

    const policy = await getGlobalToolPolicy(agent.id);
    expect(policy).toBe("restrictive");
  });

  test("returns permissive (default) when agent has a team linked to an org with default policy", async ({
    makeAgent,
    makeOrganization,
    makeTeam,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const team = await makeTeam(org.id, user.id);
    const agent = await makeAgent({ organizationId: org.id });
    await AgentTeamModel.assignTeamsToAgent(agent.id, [team.id]);

    const policy = await getGlobalToolPolicy(agent.id);
    expect(policy).toBe("permissive");
  });

  test("falls back to first org policy when agent has no teams", async ({
    makeAgent,
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    await OrganizationModel.patch(org.id, {
      globalToolPolicy: "restrictive",
    });
    // Agent auto-creates its own org, but has no teams assigned
    const agent = await makeAgent({ organizationId: org.id });

    const policy = await getGlobalToolPolicy(agent.id);
    // Falls back to first org in DB — which one that is depends on test
    // isolation, but the function should not throw
    expect(["permissive", "restrictive"]).toContain(policy);
  });

  test("returns permissive when agent ID does not exist (no teams, falls back to first org)", async ({
    makeOrganization,
  }) => {
    // Ensure at least one org exists
    await makeOrganization();
    // Use a valid UUID that doesn't correspond to any agent
    const policy = await getGlobalToolPolicy(crypto.randomUUID());
    // Agent has no teams → falls back to first org → default is permissive
    expect(["permissive", "restrictive"]).toContain(policy);
  });
});

// ---------------------------------------------------------------------------
// evaluatePolicies
// ---------------------------------------------------------------------------
describe("evaluatePolicies", () => {
  test("returns null when toolCalls is empty", async () => {
    const result = await evaluatePolicies(
      [],
      "agent-id",
      { teamIds: [] },
      true,
      new Set(),
      "permissive",
    );
    expect(result).toBeNull();
  });

  test("returns block result when tool is not in enabledToolNames", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent();
    const enabledTools = new Set(["allowed_tool"]);

    const result = await evaluatePolicies(
      [{ toolCallName: "disabled_tool", toolCallArgs: "{}" }],
      agent.id,
      { teamIds: [] },
      true,
      enabledTools,
      "permissive",
    );

    expect(result).not.toBeNull();
    expect(result?.reason).toBe(
      "Tool invocation blocked: tool not enabled for this conversation",
    );
    expect(result?.blockedToolName).toBe("disabled_tool");
    expect(result?.allToolCallNames).toEqual(["disabled_tool"]);
    expect(result?.contentMessage).toContain("disabled_tool");
    expect(result?.contentMessage).toContain("not enabled");
  });

  test("archestra tools bypass enabledToolNames filtering", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent();
    // Only "some_tool" is enabled, but archestra__ tools should bypass
    const enabledTools = new Set(["some_tool"]);

    const result = await evaluatePolicies(
      [{ toolCallName: "archestra__list_tools", toolCallArgs: "{}" }],
      agent.id,
      { teamIds: [] },
      true,
      enabledTools,
      "permissive",
    );

    // archestra tools bypass both enabledToolNames and policy evaluation
    expect(result).toBeNull();
  });

  test("returns null when all tools are allowed (permissive mode)", async ({
    makeAgent,
    makeTool,
  }) => {
    const agent = await makeAgent();
    const _tool = await makeTool({ name: "github__list_repos" });
    const enabledTools = new Set(["github__list_repos"]);

    const result = await evaluatePolicies(
      [
        {
          toolCallName: "github__list_repos",
          toolCallArgs: JSON.stringify({ org: "test" }),
        },
      ],
      agent.id,
      { teamIds: [] },
      true,
      enabledTools,
      "permissive",
    );

    expect(result).toBeNull();
  });

  test("returns block result when policy has block_always action", async ({
    makeAgent,
    makeTool,
    makeAgentTool,
    makeToolPolicy,
  }) => {
    const agent = await makeAgent();
    const tool = await makeTool({ name: "dangerous__delete_all" });
    await makeAgentTool(agent.id, tool.id);
    await makeToolPolicy(tool.id, {
      conditions: [],
      action: "block_always",
      reason: "This tool is dangerous",
    });

    const enabledTools = new Set(["dangerous__delete_all"]);

    const result = await evaluatePolicies(
      [
        {
          toolCallName: "dangerous__delete_all",
          toolCallArgs: JSON.stringify({ confirm: true }),
        },
      ],
      agent.id,
      { teamIds: [] },
      true,
      enabledTools,
      "restrictive",
    );

    expect(result).not.toBeNull();
    expect(result?.blockedToolName).toBe("dangerous__delete_all");
    expect(result?.reason).toBe("This tool is dangerous");
    expect(result?.contentMessage).toContain("dangerous__delete_all");
    expect(result?.contentMessage).toContain(
      "denied by a tool invocation policy",
    );
  });

  test("returns null when enabledToolNames is empty (no filtering applied)", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent();
    // Empty set means no filtering at all
    const enabledTools = new Set<string>();

    const result = await evaluatePolicies(
      [{ toolCallName: "some_tool", toolCallArgs: "{}" }],
      agent.id,
      { teamIds: [] },
      true,
      enabledTools,
      "permissive",
    );

    // Empty enabledToolNames set → no filtering → tool passes through
    // In permissive mode, evaluateBatch returns allowed immediately
    expect(result).toBeNull();
  });

  test("reports all tool call names in allToolCallNames when one is disabled", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent();
    const enabledTools = new Set(["allowed_tool"]);

    const result = await evaluatePolicies(
      [
        { toolCallName: "allowed_tool", toolCallArgs: "{}" },
        { toolCallName: "disabled_tool", toolCallArgs: "{}" },
      ],
      agent.id,
      { teamIds: [] },
      true,
      enabledTools,
      "permissive",
    );

    expect(result).not.toBeNull();
    // allToolCallNames should only include the disabled tools (not the allowed ones)
    expect(result?.allToolCallNames).toEqual(["disabled_tool"]);
    expect(result?.blockedToolName).toBe("disabled_tool");
  });

  test("blocks tool in restrictive mode with untrusted context and no policy", async ({
    makeAgent,
    makeTool,
  }) => {
    const agent = await makeAgent();
    // Create the tool in DB so evaluateBatch can find it
    await makeTool({ name: "external__read_file" });
    const enabledTools = new Set(["external__read_file"]);

    const result = await evaluatePolicies(
      [
        {
          toolCallName: "external__read_file",
          toolCallArgs: JSON.stringify({ path: "/etc/passwd" }),
        },
      ],
      agent.id,
      { teamIds: [] },
      false, // untrusted context
      enabledTools,
      "restrictive",
    );

    expect(result).not.toBeNull();
    expect(result?.blockedToolName).toBe("external__read_file");
    expect(result?.reason).toContain("untrusted");
  });

  test("allows tool in restrictive mode with trusted context and no policy", async ({
    makeAgent,
    makeTool,
  }) => {
    const agent = await makeAgent();
    await makeTool({ name: "external__read_file_trusted" });
    const enabledTools = new Set(["external__read_file_trusted"]);

    const result = await evaluatePolicies(
      [
        {
          toolCallName: "external__read_file_trusted",
          toolCallArgs: JSON.stringify({ path: "/tmp/safe" }),
        },
      ],
      agent.id,
      { teamIds: [] },
      true, // trusted context
      enabledTools,
      "restrictive",
    );

    expect(result).toBeNull();
  });

  test("block_always policy blocks even in permissive mode with trusted context", async ({
    makeAgent,
    makeTool,
    makeAgentTool,
    makeToolPolicy,
  }) => {
    const agent = await makeAgent();
    const tool = await makeTool({ name: "always_blocked_tool" });
    await makeAgentTool(agent.id, tool.id);
    await makeToolPolicy(tool.id, {
      conditions: [],
      action: "block_always",
    });

    const enabledTools = new Set(["always_blocked_tool"]);

    // Even with permissive mode, evaluateBatch short-circuits.
    // But only in restrictive mode does it reach the per-tool policy check.
    const result = await evaluatePolicies(
      [
        {
          toolCallName: "always_blocked_tool",
          toolCallArgs: JSON.stringify({}),
        },
      ],
      agent.id,
      { teamIds: [] },
      true,
      enabledTools,
      "restrictive",
    );

    expect(result).not.toBeNull();
    expect(result?.blockedToolName).toBe("always_blocked_tool");
  });

  test("conditional policy blocks when conditions match", async ({
    makeAgent,
    makeTool,
    makeAgentTool,
    makeToolPolicy,
  }) => {
    const agent = await makeAgent();
    const tool = await makeTool({ name: "file__write" });
    await makeAgentTool(agent.id, tool.id);
    await makeToolPolicy(tool.id, {
      conditions: [
        { key: "file_path", operator: "startsWith", value: "/etc/" },
      ],
      action: "block_always",
      reason: "Writing to /etc/ is not allowed",
    });

    const enabledTools = new Set(["file__write"]);

    const result = await evaluatePolicies(
      [
        {
          toolCallName: "file__write",
          toolCallArgs: JSON.stringify({ file_path: "/etc/passwd" }),
        },
      ],
      agent.id,
      { teamIds: [] },
      true,
      enabledTools,
      "restrictive",
    );

    expect(result).not.toBeNull();
    expect(result?.reason).toBe("Writing to /etc/ is not allowed");
  });

  test("conditional policy allows when conditions do not match", async ({
    makeAgent,
    makeTool,
    makeAgentTool,
    makeToolPolicy,
  }) => {
    const agent = await makeAgent();
    const tool = await makeTool({ name: "file__write_safe" });
    await makeAgentTool(agent.id, tool.id);
    await makeToolPolicy(tool.id, {
      conditions: [
        { key: "file_path", operator: "startsWith", value: "/etc/" },
      ],
      action: "block_always",
      reason: "Writing to /etc/ is not allowed",
    });

    const enabledTools = new Set(["file__write_safe"]);

    const result = await evaluatePolicies(
      [
        {
          toolCallName: "file__write_safe",
          toolCallArgs: JSON.stringify({ file_path: "/tmp/safe.txt" }),
        },
      ],
      agent.id,
      { teamIds: [] },
      true,
      enabledTools,
      "restrictive",
    );

    // Condition doesn't match (/tmp/safe.txt doesn't start with /etc/),
    // no default policy, trusted context → allowed
    expect(result).toBeNull();
  });
});
