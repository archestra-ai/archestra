import {
  getArchestraToolFullName,
  TOOL_RUN_TOOL_SHORT_NAME,
} from "@archestra/shared";
import { ToolInvocationPolicyModel } from "@/models";
import { describe, expect, test } from "@/test";
import type { CommonMessage } from "@/types";
import {
  evaluateIfContextIsTrusted,
  sensitiveContextOriginFromBoundary,
} from "./trusted-data";

const RUN_TOOL_FULL_NAME = getArchestraToolFullName(TOOL_RUN_TOOL_SHORT_NAME);

// End-to-end regression test for T-978: with progressive tool loading
// (toolExposureMode "search_and_run_only") every third-party tool call is a
// `run_tool` dispatch, so the tool-call name the trusted-data evaluation sees
// is the built-in wrapper, not the tool that actually produced the result.
// The wrapper must not inherit the built-ins' policy bypass — the dispatch
// target's own trusted-data policies decide, exactly as they do when the same
// tool is called directly with tools exposed. The individual behaviors
// (untrusted-by-default results, untrusted-context blocking, policy
// overrides) are pinned in trusted-data.test.ts, trusted-data-policy.test.ts
// and tool-invocation-policy.test.ts — this file only pins the dispatch
// unwrapping chain.
describe("guardrails: run_tool dispatch -> target tool's trusted data policies apply", () => {
  test("a dispatch result flips the context via the target's default policy and blocks a subsequent restricted invocation", async ({
    makeAgent,
    makeTool,
    makeAgentTool,
  }) => {
    const agent = await makeAgent();

    // The dispatch target: default policies from tool creation apply
    // (trusted-data mark_as_untrusted, invocation block_when_context_is_untrusted).
    const shellTool = await makeTool({
      agentId: agent.id,
      name: "run_shell_command",
    });
    await makeAgentTool(agent.id, shellTool.id);

    const guardedTool = await makeTool({
      agentId: agent.id,
      name: "exfiltrate_data",
    });
    await makeAgentTool(agent.id, guardedTool.id);

    // The history a progressive-load session produces: the only tool call is
    // the run_tool wrapper; the real tool rides in its arguments.
    const commonMessages: CommonMessage[] = [
      { role: "user", content: "List my repo files" },
      {
        role: "tool",
        toolCalls: [
          {
            id: "call_run_tool_1",
            name: RUN_TOOL_FULL_NAME,
            arguments: {
              tool_name: "run_shell_command",
              tool_args: { command: "ls" },
            },
            content: { output: "…" },
            isError: false,
          },
        ],
      },
    ];

    const trustEval = await evaluateIfContextIsTrusted({
      messages: commonMessages,
      agentId: agent.id,
      organizationId: agent.organizationId,
      considerContextUntrusted: false,
      policyContext: { teamIds: [] },
    });

    expect(trustEval.contextIsTrusted).toBe(false);
    // The boundary names the tool that produced the data (for the divider and
    // the refusal), anchored to the run_tool call that carried it.
    expect(trustEval.unsafeContextBoundary).toMatchObject({
      kind: "tool_result",
      toolCallId: "call_run_tool_1",
      toolName: "run_shell_command",
    });

    const invocationEval = await ToolInvocationPolicyModel.evaluateBatch(
      agent.id,
      [{ toolCallName: "exfiltrate_data", toolInput: {} }],
      {
        teamIds: [],
        sensitiveContextOrigin: sensitiveContextOriginFromBoundary(
          trustEval.unsafeContextBoundary,
        ),
      },
      trustEval.contextIsTrusted,
    );

    expect(invocationEval.isAllowed).toBe(false);
    expect(invocationEval.reason).toBe(
      '"Block in sensitive context" tool call policy violated: this session contains sensitive data, introduced by an earlier "run_shell_command" tool result',
    );
  });

  test("a dispatch whose target cannot be recovered fails closed to untrusted", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent();

    // No `arguments` captured (e.g. a source format that lost the pairing):
    // the evaluator cannot know which tool produced the data, so the wrapper
    // must not inherit the built-ins' auto-trust.
    const commonMessages: CommonMessage[] = [
      { role: "user", content: "Run it" },
      {
        role: "tool",
        toolCalls: [
          {
            id: "call_run_tool_3",
            name: RUN_TOOL_FULL_NAME,
            content: { output: "…" },
            isError: false,
          },
        ],
      },
    ];

    const trustEval = await evaluateIfContextIsTrusted({
      messages: commonMessages,
      agentId: agent.id,
      organizationId: agent.organizationId,
      considerContextUntrusted: false,
      policyContext: { teamIds: [] },
    });

    expect(trustEval.contextIsTrusted).toBe(false);
    expect(trustEval.unsafeContextBoundary).toMatchObject({
      kind: "tool_result",
      toolCallId: "call_run_tool_3",
      toolName: RUN_TOOL_FULL_NAME,
    });
  });

  test("a dispatch to a name with no tool row keeps the context trusted (run_tool refuses such dispatches)", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent();

    // The realistic history shape: platform refusal prose only — the
    // tool_state envelope in _meta does NOT survive the model-message round
    // trip, so the exemption must come from the unknown-target rule itself.
    // A typo'd dispatch never reached any upstream tool; poisoning the
    // session over it blocks the user's next legitimate call.
    const commonMessages: CommonMessage[] = [
      { role: "user", content: "Call the ghost tool" },
      {
        role: "tool",
        toolCalls: [
          {
            id: "call_run_tool_6",
            name: RUN_TOOL_FULL_NAME,
            arguments: { tool_name: "deepwiki__list_all_pages", tool_args: {} },
            content:
              'Error: No tool named "deepwiki__list_all_pages" is available to this agent.',
            isError: true,
          },
        ],
      },
    ];

    const trustEval = await evaluateIfContextIsTrusted({
      messages: commonMessages,
      agentId: agent.id,
      organizationId: agent.organizationId,
      considerContextUntrusted: false,
      policyContext: { teamIds: [] },
    });

    expect(trustEval.contextIsTrusted).toBe(true);
    expect(trustEval.unsafeContextBoundary).toBeUndefined();
  });

  test("a dispatch to an unknown delegation-surface name stays untrusted", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent();

    // Agent/skill delegation tools execute without a matching tools-table
    // row, so "no row" does not prove a refusal for them — their results are
    // real child-agent output and must keep the fail-closed default.
    const commonMessages: CommonMessage[] = [
      { role: "user", content: "Delegate this" },
      {
        role: "tool",
        toolCalls: [
          {
            id: "call_run_tool_7",
            name: RUN_TOOL_FULL_NAME,
            arguments: { tool_name: "agent-12345", tool_args: {} },
            content: { answer: "…" },
            isError: false,
          },
        ],
      },
    ];

    const trustEval = await evaluateIfContextIsTrusted({
      messages: commonMessages,
      agentId: agent.id,
      organizationId: agent.organizationId,
      considerContextUntrusted: false,
      policyContext: { teamIds: [] },
    });

    expect(trustEval.contextIsTrusted).toBe(false);
    expect(trustEval.unsafeContextBoundary).toMatchObject({
      kind: "tool_result",
      toolCallId: "call_run_tool_7",
      toolName: "agent-12345",
    });
  });

  test("a platform-authored dispatch refusal (tool_state envelope) keeps the context trusted", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent();

    // run_tool refused the dispatch before any upstream tool ran (e.g. a
    // hallucinated tool name). The refusal carries the platform's tool_state
    // envelope, so it must not poison the session — even though the named
    // target resolves to no known tool.
    const message = 'Tool "ghost__do_thing" is not available.';
    const commonMessages: CommonMessage[] = [
      { role: "user", content: "Run the ghost tool" },
      {
        role: "tool",
        toolCalls: [
          {
            id: "call_run_tool_4",
            name: RUN_TOOL_FULL_NAME,
            arguments: { tool_name: "ghost__do_thing", tool_args: {} },
            content: message,
            isError: true,
            _meta: {
              archestraError: {
                type: "tool_state",
                code: "unknown_tool",
                message,
                toolName: "ghost__do_thing",
              },
            },
          },
        ],
      },
    ];

    const trustEval = await evaluateIfContextIsTrusted({
      messages: commonMessages,
      agentId: agent.id,
      organizationId: agent.organizationId,
      considerContextUntrusted: false,
      policyContext: { teamIds: [] },
    });

    expect(trustEval.contextIsTrusted).toBe(true);
    expect(trustEval.unsafeContextBoundary).toBeUndefined();
  });

  test("a dispatch to a policy-bypassed built-in keeps the context trusted", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent();

    // Built-ins reached through run_tool (bare short name form) keep their
    // auto-trust — the unwrap must not blanket-untrust every dispatch.
    const commonMessages: CommonMessage[] = [
      { role: "user", content: "What skills exist?" },
      {
        role: "tool",
        toolCalls: [
          {
            id: "call_run_tool_5",
            name: RUN_TOOL_FULL_NAME,
            arguments: { tool_name: "list_skills", tool_args: {} },
            content: { skills: [] },
            isError: false,
          },
        ],
      },
    ];

    const trustEval = await evaluateIfContextIsTrusted({
      messages: commonMessages,
      agentId: agent.id,
      organizationId: agent.organizationId,
      considerContextUntrusted: false,
      policyContext: { teamIds: [] },
    });

    expect(trustEval.contextIsTrusted).toBe(true);
    expect(trustEval.unsafeContextBoundary).toBeUndefined();
  });

  test("a dispatch result matching the target's mark_as_trusted policy keeps the context trusted", async ({
    makeAgent,
    makeTool,
    makeAgentTool,
    makeTrustedDataPolicy,
  }) => {
    const agent = await makeAgent();

    const safeTool = await makeTool({
      agentId: agent.id,
      name: "list_endpoints",
    });
    await makeAgentTool(agent.id, safeTool.id);
    // A specific policy trusting this exact result shape; evaluated before the
    // default mark_as_untrusted policy tool creation added.
    await makeTrustedDataPolicy(safeTool.id, {
      conditions: [{ key: "status", operator: "equal", value: "ok" }],
      action: "mark_as_trusted",
    });

    const commonMessages: CommonMessage[] = [
      { role: "user", content: "What endpoints exist?" },
      {
        role: "tool",
        toolCalls: [
          {
            id: "call_run_tool_2",
            name: RUN_TOOL_FULL_NAME,
            arguments: { tool_name: "list_endpoints", tool_args: {} },
            content: { status: "ok" },
            isError: false,
          },
        ],
      },
    ];

    const trustEval = await evaluateIfContextIsTrusted({
      messages: commonMessages,
      agentId: agent.id,
      organizationId: agent.organizationId,
      considerContextUntrusted: false,
      policyContext: { teamIds: [] },
    });

    expect(trustEval.contextIsTrusted).toBe(true);
    expect(trustEval.unsafeContextBoundary).toBeUndefined();
  });
});
