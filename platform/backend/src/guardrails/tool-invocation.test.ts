import {
  getArchestraToolFullName,
  TOOL_INVOCATION_DISABLED_FOR_CONVERSATION_REASON,
  TOOL_INVOCATION_NOT_DIRECTLY_CALLABLE_REASON,
  TOOL_LIST_AGENTS_SHORT_NAME,
  TOOL_QUERY_KNOWLEDGE_SOURCES_SHORT_NAME,
  TOOL_RUN_TOOL_SHORT_NAME,
  TOOL_SEARCH_TOOLS_SHORT_NAME,
  TOOL_WHOAMI_SHORT_NAME,
} from "@archestra/shared";
import { archestraMcpBranding } from "@/archestra-mcp-server";
import { ToolModel } from "@/models";
import { describe, expect, test } from "@/test";
import {
  evaluatePolicies,
  evaluateSingleMcpToolInvocationPolicy,
} from "./tool-invocation";

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
    );
    expect(result).toBeNull();
  });

  test("hands an undeclared tool call back rather than ending the turn", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent();
    // The caller declared `allowed_tool` and nothing else, so it will not run
    // `disabled_tool` whatever the proxy says. Refusing here would drop the
    // call and end the turn, stranding an unattended agent loop; handing it
    // back lets the caller reject it and the model carry on.
    const enabledTools = new Set(["allowed_tool"]);

    const result = await evaluatePolicies(
      [{ toolCallName: "disabled_tool", toolCallArgs: "{}" }],
      agent.id,
      { teamIds: [] },
      true,
      enabledTools,
    );

    expect(result).toBeNull();
  });

  // Regression from a real dead-ended run. An external client decorates the
  // gateway's tools with its own alias (`mcp__<alias>__<advertised name>`), so
  // the declared list carries no recognizable dispatch pair and this takes the
  // no-dispatch-pair path. The model, having lost its shell to an unrelated
  // failure, reached for a client built-in this request never declared.
  // Refusing dropped the call and ended the turn, and with no human present to
  // type again, the run stopped there for hours.
  test("hands back a client built-in the request never declared", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent();
    const declared = new Set([
      "mcp__archestra__acme_gateway__run_tool",
      "mcp__archestra__acme_gateway__search_tools",
      "Bash",
      "Skill",
    ]);

    const result = await evaluatePolicies(
      [
        {
          toolCallName: "Grep",
          toolCallArgs: JSON.stringify({ pattern: "x" }),
        },
      ],
      agent.id,
      { teamIds: [] },
      true,
      declared,
    );

    expect(result).toBeNull();
  });

  test("still refuses an unassigned tool on the gateway surface", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent();
    // On the gateway the enabled set is the agent's *assigned* tools, not a
    // caller declaration, so a missing name is a real authorization miss and
    // the gateway is the party that would otherwise execute it.
    const result = await evaluatePolicies(
      [{ toolCallName: "disabled_tool", toolCallArgs: "{}" }],
      agent.id,
      { teamIds: [] },
      true,
      new Set(["allowed_tool"]),
      { surface: "mcp-gateway" },
    );

    expect(result).not.toBeNull();
    expect(result?.reason).toBe(
      TOOL_INVOCATION_DISABLED_FOR_CONVERSATION_REASON,
    );
    expect(result?.blockedToolName).toBe("disabled_tool");
    expect(result?.allToolCallNames).toEqual(["disabled_tool"]);
    expect(result?.contentMessage).toContain("disabled_tool");
    expect(result?.contentMessage).toContain("not enabled");
    // non-first-person and steered at the discovery path (see PR #5395)
    expect(result?.contentMessage).not.toContain("I attempted");
    expect(result?.contentMessage).toContain(
      archestraMcpBranding.getToolName(TOOL_SEARCH_TOOLS_SHORT_NAME),
    );
  });

  test("white-labeled built-in tools bypass enabledToolNames filtering", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent();
    archestraMcpBranding.syncFromOrganization({
      appName: "Acme Copilot",
      iconLogo: null,
    });
    const brandedListAgents = getArchestraToolFullName(
      TOOL_LIST_AGENTS_SHORT_NAME,
      {
        appName: "Acme Copilot",
        fullWhiteLabeling: true,
      },
    );
    // Only "some_tool" is enabled, but archestra__ tools should bypass
    const enabledTools = new Set(["some_tool"]);

    const result = await evaluatePolicies(
      [{ toolCallName: brandedListAgents, toolCallArgs: "{}" }],
      agent.id,
      { teamIds: [] },
      true,
      enabledTools,
    );

    // archestra tools bypass both enabledToolNames and policy evaluation
    expect(result).toBeNull();
  });

  test("returns null when all tools are allowed", async ({
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
    );

    expect(result).toBeNull();
  });

  // Reported from production more than once: a `search_and_run_only` agent
  // emits a third-party tool's raw name instead of wrapping it, the steer
  // replaces the whole turn, and the run ends — including on scheduled agents
  // with nobody there to read it. The steer is correct and still unusable: it
  // asks the model to retry through run_tool in a turn that has just been
  // ended. `planDispatchModeToolCallRewrites` has already repaired what it
  // safely can upstream, so what reaches here is exactly the batch that could
  // not be auto-corrected — hand it back and let the caller's own unknown-tool
  // error keep the loop alive.
  test("hands back a direct call even when the dispatch pair is advertised", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent();
    const enabledTools = new Set([
      archestraMcpBranding.getToolName(TOOL_SEARCH_TOOLS_SHORT_NAME),
      archestraMcpBranding.getToolName(TOOL_RUN_TOOL_SHORT_NAME),
    ]);

    const result = await evaluatePolicies(
      [{ toolCallName: "github__list_issues", toolCallArgs: "{}" }],
      agent.id,
      { teamIds: [] },
      true,
      enabledTools,
    );

    expect(result).toBeNull();
  });

  // Asserted on the gateway surface: the LLM proxy no longer refuses these at
  // all (it hands them back so the run can continue), so the gateway is where
  // choosing correctly between the two steers still matters.
  test("steers to run_tool instead of 'not enabled' when the tool list advertises the dispatch pair", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent();
    // A `search_and_run_only` / Auto-mode request: the list carries only the
    // dispatch pair, so third-party tools are reachable but never directly
    // callable. The model calling one by name must be taught the convention,
    // not told to stop.
    const searchToolsName = archestraMcpBranding.getToolName(
      TOOL_SEARCH_TOOLS_SHORT_NAME,
    );
    const runToolName = archestraMcpBranding.getToolName(
      TOOL_RUN_TOOL_SHORT_NAME,
    );
    const enabledTools = new Set([searchToolsName, runToolName]);

    const result = await evaluatePolicies(
      [{ toolCallName: "github__list_issues", toolCallArgs: "{}" }],
      agent.id,
      { teamIds: [] },
      true,
      enabledTools,
      { surface: "mcp-gateway" },
    );

    expect(result).not.toBeNull();
    expect(result?.reason).toBe(TOOL_INVOCATION_NOT_DIRECTLY_CALLABLE_REASON);
    expect(result?.blockedToolName).toBe("github__list_issues");
    // The name is handed back so the retry is a single step, not a re-search.
    expect(result?.contentMessage).toContain("github__list_issues");
    expect(result?.contentMessage).toContain(runToolName);
    expect(result?.contentMessage).toContain(searchToolsName);
    // The two halves of the old dead end must be gone: the wrong diagnosis and
    // the instruction that leaves the model with nowhere to go.
    expect(result?.contentMessage).not.toContain("not enabled");
    expect(result?.contentMessage).not.toContain("Do not call them again");
  });

  test("keeps the 'not enabled for this conversation' steer when the list has no dispatch pair", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent();
    // `full` exposure hides the meta tools, so a tool missing from the list
    // really was disabled for the conversation — run_tool is not the answer.
    // Asserted on the gateway surface, the one that still refuses.
    const enabledTools = new Set(["github__list_repos"]);

    const result = await evaluatePolicies(
      [{ toolCallName: "github__delete_repo", toolCallArgs: "{}" }],
      agent.id,
      { teamIds: [] },
      true,
      enabledTools,
      { surface: "mcp-gateway" },
    );

    expect(result?.reason).toBe(
      TOOL_INVOCATION_DISABLED_FOR_CONVERSATION_REASON,
    );
    expect(result?.contentMessage).toContain("not enabled");
  });

  test("half a dispatch pair is not a dispatch surface", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent();
    // search_tools alone cannot run anything, so steering at run_tool would
    // name a tool the model cannot call.
    const enabledTools = new Set([
      archestraMcpBranding.getToolName(TOOL_SEARCH_TOOLS_SHORT_NAME),
    ]);

    const result = await evaluatePolicies(
      [{ toolCallName: "github__list_issues", toolCallArgs: "{}" }],
      agent.id,
      { teamIds: [] },
      true,
      enabledTools,
      { surface: "mcp-gateway" },
    );

    expect(result?.reason).toBe(
      TOOL_INVOCATION_DISABLED_FOR_CONVERSATION_REASON,
    );
  });

  test("the run_tool steer echoes white-labeled dispatch tool names", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent();
    archestraMcpBranding.syncFromOrganization({
      appName: "Acme Copilot",
      iconLogo: null,
    });
    const brandingIdentity = {
      appName: "Acme Copilot",
      fullWhiteLabeling: true,
    };
    const brandedSearchTools = getArchestraToolFullName(
      TOOL_SEARCH_TOOLS_SHORT_NAME,
      brandingIdentity,
    );
    const brandedRunTool = getArchestraToolFullName(
      TOOL_RUN_TOOL_SHORT_NAME,
      brandingIdentity,
    );

    const result = await evaluatePolicies(
      [{ toolCallName: "github__list_issues", toolCallArgs: "{}" }],
      agent.id,
      { teamIds: [] },
      true,
      new Set([brandedSearchTools, brandedRunTool]),
      { surface: "mcp-gateway" },
    );

    // Naming the canonical `archestra__*` form would point the model at a tool
    // it cannot see, defeating the recovery loop.
    expect(result?.contentMessage).toContain(brandedRunTool);
    expect(result?.contentMessage).not.toContain("archestra__run_tool");
  });

  test("a run_tool dispatch target is blocked by its sensitive-context policy even when only the wrapper was enabled", async ({
    makeAgent,
    makeTool,
    makeAgentTool,
    makeToolPolicy,
  }) => {
    const agent = await makeAgent();
    const tool = await makeTool({ name: "github__create_or_update_file" });
    await makeAgentTool(agent.id, tool.id);
    await makeToolPolicy(tool.id, {
      conditions: [],
      action: "block_when_context_is_untrusted",
      reason: "No writes from a sensitive context",
    });

    // An external MCP client's request only enables the gateway's dispatch
    // wrapper; the target reached through it must still be policy-evaluated
    // rather than refused as disabled or skipped as unknown (T-996).
    const enabledTools = new Set(["archestra__run_tool"]);

    const result = await evaluatePolicies(
      [
        {
          toolCallName: "github__create_or_update_file",
          toolCallArgs: JSON.stringify({ path: "README.md" }),
          isRunToolDispatchTarget: true,
        },
      ],
      agent.id,
      { teamIds: [] },
      false,
      enabledTools,
    );

    expect(result).not.toBeNull();
    expect(result?.blockedToolName).toBe("github__create_or_update_file");
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
    );

    expect(result).not.toBeNull();
    expect(result?.blockedToolName).toBe("dangerous__delete_all");
    // Custom admin reasons are framed with the policy that fired.
    expect(result?.reason).toBe(
      '"Block always" tool call policy violated: This tool is dangerous',
    );
    expect(result?.contentMessage).toContain("dangerous__delete_all");
    expect(result?.contentMessage).toContain("blocked unsafe tool call");
  });

  test("block message names the enforcing surface, the rule, and tells the model not to retry", async ({
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
      new Set(["dangerous__delete_all"]),
      { surface: "llm-proxy", sessionId: "session-123" },
    );

    // Order matters for readability: the block first, then the tool call and
    // the rule that fired, and only last what Archestra is — with the session
    // id so the user can hand it to an admin.
    expect(result?.contentMessage).toContain(
      'Archestra LLM Proxy blocked unsafe tool call: dangerous__delete_all with arguments: {"confirm":true}.',
    );
    expect(result?.contentMessage).toContain(
      '"Block always" tool call policy violated: This tool is dangerous.',
    );
    expect(result?.contentMessage).toContain(
      "Archestra LLM Proxy monitors agentic traffic and blocks unsafe tool calls according to the configured guardrails.",
    );
    expect(result?.contentMessage).toContain("Your session id: session-123.");
    // The tagged refusal variant keeps the machine-parseable metadata block.
    expect(result?.refusalMessage).toContain(
      "<archestra-tool-name>dangerous__delete_all</archestra-tool-name>",
    );
  });

  test("gateway-surface blocks attribute the MCP Gateway", async ({
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
    });

    const result = await evaluateSingleMcpToolInvocationPolicy({
      agentId: agent.id,
      toolName: "dangerous__delete_all",
      toolInput: { confirm: true },
      organizationId: agent.organizationId,
      contextIsTrusted: true,
    });

    expect(result?.contentMessage).toContain(
      "Archestra MCP Gateway blocked unsafe tool call: dangerous__delete_all",
    );
    // The gateway describes its own role — a single entry to the MCP servers —
    // rather than the LLM proxy's "monitors agentic traffic".
    expect(result?.contentMessage).toContain(
      "Archestra MCP Gateway provides a single entry to the MCP servers",
    );
    expect(result?.contentMessage).not.toContain("monitors agentic traffic");
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
    );

    // Empty enabledToolNames set → no filtering → tool passes through
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
      { surface: "mcp-gateway" },
    );

    expect(result).not.toBeNull();
    // allToolCallNames should only include the disabled tools (not the allowed ones)
    expect(result?.allToolCallNames).toEqual(["disabled_tool"]);
    expect(result?.blockedToolName).toBe("disabled_tool");
  });

  test("blocks tool with untrusted context and no policy", async ({
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
    );

    expect(result).not.toBeNull();
    expect(result?.blockedToolName).toBe("external__read_file");
    expect(result?.reason).toContain("sensitive");
  });

  test("allows tool with trusted context and no policy", async ({
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
    );

    expect(result).toBeNull();
  });

  test("block_always policy blocks with trusted context", async ({
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

    // The engine always enforces, so the per-tool block_always policy fires.
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
    );

    expect(result).not.toBeNull();
    expect(result?.reason).toBe(
      '"Block always" tool call policy violated: Writing to /etc/ is not allowed',
    );
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
    );

    // Condition doesn't match (/tmp/safe.txt doesn't start with /etc/),
    // no default policy, trusted context → allowed
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// evaluateSingleMcpToolInvocationPolicy (MCP Gateway / run_tool execution path)
// ---------------------------------------------------------------------------
describe("evaluateSingleMcpToolInvocationPolicy", () => {
  test("enforces invocation policies for query_knowledge_sources on the gateway path", async ({
    makeAgent,
    makeToolPolicy,
    seedAndAssignArchestraTools,
  }) => {
    const agent = await makeAgent();
    await seedAndAssignArchestraTools(agent.id);

    const kbToolName = archestraMcpBranding.getToolName(
      TOOL_QUERY_KNOWLEDGE_SOURCES_SHORT_NAME,
    );
    const kbTool = await ToolModel.findByName(kbToolName);
    if (!kbTool) throw new Error(`Tool ${kbToolName} not found`);
    await makeToolPolicy(kbTool.id, {
      conditions: [],
      action: "block_always",
      reason: "KB access forbidden",
    });

    const policyBlock = await evaluateSingleMcpToolInvocationPolicy({
      agentId: agent.id,
      toolName: kbToolName,
      toolInput: { query: "secrets" },
      organizationId: agent.organizationId,
      contextIsTrusted: true,
    });

    expect(policyBlock).not.toBeNull();
    expect(policyBlock?.reason).toContain("KB access forbidden");
  });

  test("allows query_knowledge_sources with seeded defaults even in untrusted context", async ({
    makeAgent,
    seedAndAssignArchestraTools,
  }) => {
    const agent = await makeAgent();
    // Seeds the default allow_when_context_is_untrusted invocation policy —
    // without it, an untrusted context would block the call.
    await seedAndAssignArchestraTools(agent.id);

    const kbToolName = archestraMcpBranding.getToolName(
      TOOL_QUERY_KNOWLEDGE_SOURCES_SHORT_NAME,
    );

    const policyBlock = await evaluateSingleMcpToolInvocationPolicy({
      agentId: agent.id,
      toolName: kbToolName,
      toolInput: { query: "docs" },
      organizationId: agent.organizationId,
      contextIsTrusted: false,
    });

    expect(policyBlock).toBeNull();
  });

  test("other built-in tools still bypass policy evaluation on the gateway path", async ({
    makeAgent,
    seedAndAssignArchestraTools,
  }) => {
    const agent = await makeAgent();
    await seedAndAssignArchestraTools(agent.id);

    const whoamiToolName = archestraMcpBranding.getToolName(
      TOOL_WHOAMI_SHORT_NAME,
    );

    const policyBlock = await evaluateSingleMcpToolInvocationPolicy({
      agentId: agent.id,
      toolName: whoamiToolName,
      toolInput: {},
      organizationId: agent.organizationId,
      contextIsTrusted: false,
    });

    expect(policyBlock).toBeNull();
  });
});
