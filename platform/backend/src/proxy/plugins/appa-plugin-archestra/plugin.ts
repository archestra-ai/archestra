import { buildNoticeArguments, type RemedyExecution } from "@/openappa/notice";
import {
  cancelCalls,
  endTurn,
  evaluateHostedToolCalls,
  evaluateToolCalls,
  notePrompt,
  type OpenAppaSession,
  processProxyResults,
} from "@/openappa/service";
import type {
  LlmProxyBeforeModelContext,
  LlmProxyContextTrust,
  LlmProxyHostedToolCallsContext,
  LlmProxyHostedToolCallsOutcome,
  LlmProxyModelResponseContext,
  LlmProxyPlugin,
  LlmProxyRequestContext,
  LlmProxyToolCallsContext,
  LlmProxyToolCallsOutcome,
  LlmProxyToolResultsContext,
  LlmProxyToolResultsOutcome,
} from "@/proxy/plugins/registry";
import {
  APPA_PLUGIN_TRUSTED_CONTEXT,
  type AppaClientAdapter,
  type AppaTrustedContext,
} from "./types";

type AppaPluginBinding = {
  session: OpenAppaSession;
  canonicalizeToolName: (name: string) => string;
  adapter: AppaClientAdapter | undefined;
  request: AppaTrustedContext["request"];
  /** True when the model's response contained tool calls awaiting client execution. */
  turnOpen: boolean;
  /** True on internal loopback Chat requests. */
  chat: boolean;
};

export class AppaPluginArchestra implements LlmProxyPlugin {
  readonly id = "archestra.appa";
  readonly finalizesToolCalls = true;
  private readonly bindings = new WeakMap<object, AppaPluginBinding>();

  constructor(private readonly clientAdapters: readonly AppaClientAdapter[]) {}

  async onSessionInit(context: LlmProxyRequestContext): Promise<void> {
    this.bindings.delete(context.resources);
    const trustedContext = getTrustedContext(context.resources);
    if (!trustedContext) return;
    // Copy trusted context before adapter inspection to isolate plugin state.
    const binding: AppaPluginBinding = {
      session: { ...trustedContext.session },
      canonicalizeToolName: trustedContext.canonicalizeToolName,
      adapter: undefined,
      request: trustedContext.request,
      turnOpen: false,
      chat: trustedContext.chatSource !== undefined,
    };
    const adapter = this.clientAdapters.find((candidate) =>
      candidate.matches({
        headers: context.headers,
        requestBody: context.requestBody,
        trustedContext: cloneTrustedContext(trustedContext),
      }),
    );
    binding.adapter = adapter;
    this.bindings.set(context.resources, binding);
  }

  async onToolResults(
    context: LlmProxyToolResultsContext,
  ): Promise<LlmProxyToolResultsOutcome | undefined> {
    const binding = this.bindings.get(context.resources);
    if (!binding) return;
    // Requests with results submit them to runtime even if current request declares no tools.
    if (!binding.request.tools && context.toolResults.length === 0) return;
    const result = await processProxyResults({
      session: binding.session,
      results: [...context.toolResults],
      controlToolName:
        binding.request.tools?.controlToolName ??
        binding.request.historicalControlToolName,
      trustedChat: binding.chat,
    });
    return {
      // Use runtime-approved output for tool results.
      toolResultUpdates: Object.fromEntries(
        Object.entries(result.toolResultUpdates).map(([id, result]) => [
          id,
          result.content,
        ]),
      ),
      contextTrust: {
        contextIsTrusted: result.contextIsTrusted,
        dualLlmAnalyses: result.dualLlmAnalyses,
        unsafeContextBoundary: result.unsafeContextBoundary,
      } satisfies LlmProxyContextTrust,
    };
  }

  async onBeforeModel(context: LlmProxyBeforeModelContext): Promise<void> {
    const binding = this.bindings.get(context.resources);
    // Only requests declaring tools open an OpenAPPA turn.
    if (!binding?.request.tools || !binding.request.promptOperationId) return;
    await notePrompt(binding.session, binding.request.promptOperationId);
  }

  async onPrepareToolCalls(
    context: LlmProxyToolCallsContext,
  ): Promise<LlmProxyToolCallsOutcome | undefined> {
    const control = this.bindings.get(context.resources)?.request.tools
      ?.controlToolName;
    if (!control) return;
    let changed = false;
    const toolCalls = context.toolCalls.map((call) => {
      if (call.name !== control) return call;
      const stamped = stampControlExecution(call);
      changed ||= stamped !== call;
      return stamped;
    });
    if (changed) return { decision: "allow", toolCalls };
  }

  governsHostedToolCalls(context: LlmProxyRequestContext): boolean {
    return this.bindings.get(context.resources)?.request.tools !== undefined;
  }

  async onHostedToolCalls(
    context: LlmProxyHostedToolCallsContext,
  ): Promise<LlmProxyHostedToolCallsOutcome | undefined> {
    const binding = this.bindings.get(context.resources);
    const tools = binding?.request.tools;
    if (!binding || !tools) return;
    const calls = [...context.hostedToolCalls];
    const decisions = await evaluateHostedToolCalls(binding.session, calls, {
      canonicalize: (name) => this.canonicalize(binding, name),
      controlToolName: tools.controlToolName,
    });
    const held = calls.flatMap((call, index) => {
      const decision = decisions[index];
      return decision.kind === "hold"
        ? [{ call, feedback: decision.feedback }]
        : [];
    });
    if (held.length === 0) return { decision: "release" };
    // The client must run the notices, so the turn stays open.
    binding.turnOpen = true;
    return {
      decision: "hold",
      notices: held.map(({ call, feedback }) => ({
        id: call.id,
        name: tools.noticeToolName,
        arguments: JSON.stringify(
          buildNoticeArguments({
            id: call.id,
            tool: call.name,
            arguments: call.arguments,
            result: feedback,
          }),
        ),
      })),
      blocked: held.map(({ call, feedback }) => ({
        id: call.id,
        name: call.name,
        reason: feedback,
      })),
    };
  }

  async onToolCalls(
    context: LlmProxyToolCallsContext,
  ): Promise<LlmProxyToolCallsOutcome | undefined> {
    const binding = this.bindings.get(context.resources);
    if (!binding) return;
    const calls = [...context.toolCalls];
    const decisions = await evaluateToolCalls(binding.session, calls, {
      canonicalize: (name) => this.canonicalize(binding, name),
      ...(binding.request.tools
        ? { controlToolName: binding.request.tools.controlToolName }
        : {}),
    });

    const notice = binding.request.tools?.noticeToolName;
    const blocked: { id: string; name: string; reason: string }[] = [];
    const released: typeof calls = [];
    for (const [index, call] of calls.entries()) {
      const decision = decisions[index];
      if (decision.kind === "control") {
        released.push(call);
        continue;
      }
      if (decision.kind === "allow") {
        released.push(call);
        continue;
      }
      if (!notice) {
        // Refuse call and cancel admitted calls if client declares no notice tool.
        await cancelCalls(
          binding.session,
          calls.flatMap((each, at) =>
            decisions[at].kind === "allow" ? [each.id] : [],
          ),
        );
        const contentMessage = `${decision.feedback}\n\n[appa] This client declared no tools, so the ruling cannot be delivered as a remedy notice and the call is refused. A client whose tools are not on the wire cannot be governed. Declare the tools on the wire; for Codex, set code_mode_host = false.`;
        return {
          decision: "refuse",
          refusal: {
            refusalMessage: contentMessage,
            contentMessage,
            reason: "openappa_no_notice_tool",
            blockedToolName: call.name,
            blockedToolId: call.id,
            toolInput: toolInputOf(call.arguments),
            allToolCallNames: calls.map((each) => each.name),
          },
        };
      }
      blocked.push({ id: call.id, name: call.name, reason: decision.feedback });
      released.push({
        id: call.id,
        name: notice,
        arguments: JSON.stringify(
          buildNoticeArguments({
            id: call.id,
            tool: call.name,
            arguments: call.arguments,
            result: decision.feedback,
            custom: binding.request.customTools.has(call.name),
            namespace:
              call.namespace ?? binding.request.namespaces.get(call.name),
          }),
        ),
      });
    }

    // Keep turn open while tool calls are awaiting client execution.
    binding.turnOpen = true;
    if (blocked.length === 0) return;
    return { decision: "allow", toolCalls: released, blocked };
  }

  async onModelResponse(
    context: LlmProxyModelResponseContext,
  ): Promise<undefined> {
    const binding = this.bindings.get(context.resources);
    if (!binding?.request.tools || binding.turnOpen) return;
    if (!binding.request.turnEndOperationId) return;
    await endTurn(binding.session, binding.request.turnEndOperationId);
    return undefined;
  }

  async onCleanup(context: LlmProxyRequestContext): Promise<void> {
    this.bindings.delete(context.resources);
  }

  // === Internal helpers ===

  private canonicalize(binding: AppaPluginBinding, name: string): string {
    return binding.adapter?.classifyToolName(name) === "local"
      ? binding.canonicalizeToolName(
          binding.adapter.normalizeLocalToolName(name),
        )
      : binding.canonicalizeToolName(name);
  }
}

function getTrustedContext(
  resources: ReadonlyMap<PropertyKey, unknown>,
): AppaTrustedContext | undefined {
  const trustedContext = resources.get(APPA_PLUGIN_TRUSTED_CONTEXT);
  return typeof trustedContext === "object" &&
    trustedContext !== null &&
    "session" in trustedContext &&
    "profileId" in trustedContext &&
    "canonicalizeToolName" in trustedContext &&
    "request" in trustedContext
    ? (trustedContext as AppaTrustedContext)
    : undefined;
}

function cloneTrustedContext(context: AppaTrustedContext): AppaTrustedContext {
  return {
    ...context,
    session: { ...context.session },
  };
}

/** Attaches execution metadata frame to remedy calls for receipt validation. */
function stampControlExecution(
  call: LlmProxyToolCallsContext["toolCalls"][number],
): LlmProxyToolCallsContext["toolCalls"][number] {
  const originalArguments =
    typeof call.arguments === "string"
      ? call.arguments
      : JSON.stringify(call.arguments);
  let argumentsValue: unknown;
  try {
    argumentsValue = JSON.parse(originalArguments);
  } catch {
    return call;
  }
  if (
    !argumentsValue ||
    typeof argumentsValue !== "object" ||
    Array.isArray(argumentsValue)
  )
    return call;
  const execution = {
    v: 1,
    kind: "appa_remedy",
    call_id: call.id,
    tool_name: call.name,
    original_arguments: originalArguments,
  } satisfies RemedyExecution;
  return {
    ...call,
    arguments: JSON.stringify({
      ...argumentsValue,
      execution,
    }),
  };
}

/** Parses tool input into an object for guardrail refusal reporting. */
function toolInputOf(
  args: string | Record<string, unknown>,
): Record<string, unknown> {
  if (typeof args !== "string") return args;
  try {
    const parsed: unknown = JSON.parse(args);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      return parsed as Record<string, unknown>;
  } catch {
    // Not JSON: reported as the text it is.
  }
  return { arguments: args };
}
