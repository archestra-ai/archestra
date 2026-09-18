import { TOOL_ASK_USER_SHORT_NAME } from "@archestra/shared";
import { archestraMcpBranding } from "@/archestra-mcp-server/branding";
import config from "@/config";
import { buildNoticeArguments, type RemedyExecution } from "@/openappa/notice";
import type { OfferJws } from "@/openappa/offer-claims";
import {
  offerIdFromJws,
  signOfferClaims,
  unsignedOfferClaims,
} from "@/openappa/offer-claims";
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
import { normalizeToolCallsForPolicy } from "@/routes/proxy/llm-proxy-helpers";
import { ApiError } from "@/types";
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
      canonicalize: (name) => this.canonicalize(binding, name),
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
    const binding = this.bindings.get(context.resources);
    const control = binding?.request.tools?.controlToolName;
    if (!control) return;
    const askUser = archestraMcpBranding.getToolName(TOOL_ASK_USER_SHORT_NAME);
    let changed = false;
    const toolCalls = context.toolCalls.map((call) => {
      if (call.name === control) {
        const stamped = stampControlExecution(
          call,
          binding?.request.offerClaims,
        );
        changed ||= stamped !== call;
        return stamped;
      }
      if (call.name === askUser) {
        const stamped = stampAskUserOffers(call, binding?.request.offerClaims);
        changed ||= stamped !== call;
        return stamped;
      }
      return call;
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
      // The registry pins `blocked` to the wire batch: the entry names the
      // call as given. The identity the runtime ruled on — the dispatch's
      // target — is what the notice and the refusal describe.
      const identity = this.policyIdentity(binding, call);
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
            blockedToolName: identity.name,
            blockedToolId: call.id,
            toolInput: toolInputOf(identity.arguments),
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
            tool: identity.name,
            arguments: identity.arguments,
            result: decision.feedback,
            custom: identity.custom,
            namespace: identity.namespace,
            offers: signedOffersForDenial(binding.session, {
              offerIds: decision.offers ?? [],
              tool: identity.name,
              spelling: identity.name,
            }),
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
    // Codex declares an MCP server's tools inside that server's namespace,
    // under their bare names: they are the gateway's tools, not local ones.
    const inMcpNamespace = binding.request.namespaces
      .get(name)
      ?.startsWith(CODEX_MCP_NAMESPACE_PREFIX);
    return binding.adapter?.classifyToolName(name) === "local" &&
      !inMcpNamespace
      ? binding.canonicalizeToolName(
          binding.adapter.normalizeLocalToolName(name),
        )
      : binding.canonicalizeToolName(name);
  }

  /**
   * The identity a call is ruled on. A `run_tool` dispatch is evaluated as the
   * tool it targets — target name and `tool_args` — so the denial the model
   * reads, and the call history restores, name that tool exactly as if the
   * client had called it directly. The unwrap is the same one evaluation used,
   * so the notice can never describe a different call than the one ruled on.
   */
  private policyIdentity(
    binding: AppaPluginBinding,
    call: LlmProxyToolCallsContext["toolCalls"][number],
  ): {
    name: string;
    arguments: string | Record<string, unknown>;
    custom: boolean;
    namespace?: string;
  } {
    const [normalized] = normalizeToolCallsForPolicy(
      [{ name: call.name, arguments: call.arguments }],
      (name) => this.canonicalize(binding, name),
    );
    if (normalized.isRunToolDispatchTarget) {
      // The target has no declaration of its own on this wire: it is neither a
      // free-form custom tool nor namespaced, whatever the wrapper's
      // declaration says.
      return {
        name: normalized.toolCallName,
        arguments: normalized.toolCallArgs,
        custom: false,
      };
    }
    return {
      name: call.name,
      arguments: call.arguments,
      custom: binding.request.customTools.has(call.name),
      namespace: call.namespace ?? binding.request.namespaces.get(call.name),
    };
  }
}

/** Codex names the namespace of an MCP server's tools `mcp__<server>`. */
const CODEX_MCP_NAMESPACE_PREFIX = "mcp__";

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

function signedOffersForDenial(
  session: OpenAppaSession,
  params: { offerIds: string[]; tool: string; spelling: string },
): OfferJws[] {
  const secret = config.openappa.offerSigningSecret;
  if (params.offerIds.length === 0) return [];
  if (secret.length === 0) {
    throw new ApiError(
      503,
      "OpenAPPA offer signing is not configured (ARCHESTRA_OPENAPPA_OFFER_SIGNING_SECRET)",
    );
  }
  return params.offerIds.map((offerId) =>
    signOfferClaims(
      unsignedOfferClaims({
        organizationId: session.organization_id,
        sessionId: session.session_id,
        parentId: session.parent_id,
        callerId: session.caller_id,
        offerId,
        tool: params.tool,
        spelling: params.spelling,
      }),
      secret,
    ),
  );
}

function claimsForOffer(
  offerId: string,
  envelopes: readonly OfferJws[] | undefined,
): OfferJws | undefined {
  return envelopes?.find((envelope) => offerIdFromJws(envelope) === offerId);
}

/** Attaches execution metadata frame to remedy calls for receipt validation. */
function stampControlExecution(
  call: LlmProxyToolCallsContext["toolCalls"][number],
  offerClaims: readonly OfferJws[] | undefined,
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
  const argumentRecord = argumentsValue as Record<string, unknown>;
  // The proxy is the sole writer of the JWS members. A model echoing a
  // previous remedy call would otherwise resend a stale, still-valid
  // signature the proxy never minted for this turn.
  const {
    protected: _clientProtected,
    payload: _clientPayload,
    signature: _clientSignature,
    ...clientArguments
  } = argumentRecord;
  const execution = {
    v: 1,
    kind: "appa_remedy",
    call_id: call.id,
    tool_name: call.name,
    original_arguments: originalArguments,
  } satisfies RemedyExecution;
  const offerId =
    typeof argumentRecord.offer_id === "string"
      ? argumentRecord.offer_id
      : undefined;
  const owner = offerId ? claimsForOffer(offerId, offerClaims) : undefined;
  return {
    ...call,
    arguments: JSON.stringify({
      ...clientArguments,
      execution,
      // The matched offer's flattened JWS routing fields (protected,
      // payload, signature) land as top-level keys beside the remedy args.
      ...(owner ?? {}),
    }),
  };
}

/**
 * Attaches the session's live offer envelopes to an ask_user call, so the
 * tool can carry a verified remedy continuation in its result — the same
 * stateless signed-payload pattern the remedy control call uses. The proxy is
 * the sole writer of this key; a client-echoed copy is stripped first.
 */
function stampAskUserOffers(
  call: LlmProxyToolCallsContext["toolCalls"][number],
  offerClaims: readonly OfferJws[] | undefined,
): LlmProxyToolCallsContext["toolCalls"][number] {
  if (!offerClaims || offerClaims.length === 0) return call;
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
  const { remedy_offers: _clientOffers, ...clientArguments } =
    argumentsValue as Record<string, unknown>;
  return {
    ...call,
    arguments: JSON.stringify({
      ...clientArguments,
      remedy_offers: offerClaims,
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
