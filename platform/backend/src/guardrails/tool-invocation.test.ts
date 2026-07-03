import {
  getArchestraToolFullName,
  TOOL_INVOCATION_DISABLED_FOR_CONVERSATION_REASON,
  TOOL_LIST_AGENTS_SHORT_NAME,
  TOOL_QUERY_KNOWLEDGE_SOURCES_SHORT_NAME,
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
