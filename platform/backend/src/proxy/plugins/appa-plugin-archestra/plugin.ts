import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  PROXY_STAMPED_TOOL_ARGUMENTS,
  TimeInMs,
  TOOL_ASK_USER_SHORT_NAME,
  TOOL_EXECUTE_REMEDY_PLAN_SHORT_NAME,
} from "@archestra/shared";
import { archestraMcpBranding } from "@/archestra-mcp-server/branding";
import { type AllowedCacheKey, CacheKey, cacheManager } from "@/cache-manager";
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
  type AskUserArguments,
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
  /** A verified user-question result needs trusted workflow continuation. */
  requiresQuestionContinuation: boolean;
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
      requiresQuestionContinuation: false,
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
    assertUniqueNativeQuestionResultIds({
      binding,
      results: context.toolResults,
    });
    const verifiedNativeQuestionResults = await claimNativeQuestionResults({
      binding,
      results: context.toolResults,
    });
    const result = await processProxyResults({
      session: binding.session,
      results: [...context.toolResults],
      canonicalize: (name) => this.canonicalize(binding, name),
      isUserQuestion: (answer) =>
        isUserQuestionResult({
          binding,
          answer,
          verifiedNativeQuestionResults,
        }),
      controlToolName:
        binding.request.tools?.controlToolName ??
        binding.request.historicalControlToolName,
      trustedChat: binding.chat,
    });
    const toolResultUpdates = Object.fromEntries(
      Object.entries(result.toolResultUpdates).map(([id, result]) => [
        id,
        result.content,
      ]),
    );
    if (
      binding.adapter &&
      !binding.chat &&
      context.toolResults.some(
        (answer) =>
          !Object.hasOwn(toolResultUpdates, answer.id) &&
          isUserQuestionResult({
            binding,
            answer,
            verifiedNativeQuestionResults,
          }),
      )
    ) {
      binding.requiresQuestionContinuation = true;
    }
    return {
      // Use runtime-approved output for tool results.
      toolResultUpdates,
      contextTrust: {
        contextIsTrusted: result.contextIsTrusted,
        dualLlmAnalyses: result.dualLlmAnalyses,
        unsafeContextBoundary: result.unsafeContextBoundary,
      } satisfies LlmProxyContextTrust,
    };
  }

  async onBeforeModel(context: LlmProxyBeforeModelContext): Promise<void> {
    const binding = this.bindings.get(context.resources);
    if (binding?.requiresQuestionContinuation) {
      appendQuestionContinuation({
        request: context.request,
        interactionType: context.interactionType,
      });
    }
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
    let changed = false;
    const claimedOfferIds = new Set<string>();
    const issuedNativeQuestions: Array<{ id: string; name: string }> = [];
    const toolCalls = context.toolCalls.map((call) => {
      if (call.name === control) {
        const stamped = stampControlExecution(
          call,
          binding?.request.offerClaims,
        );
        changed ||= stamped !== call;
        return stamped;
      }
      // Before any policy sees it: the call the policies rule on is the one
      // the client will run.
      let prepared = binding ? this.asNativeQuestion(binding, call) : call;
      if (prepared !== call) {
        changed = true;
      }
      const issuedQuestionName = binding
        ? nativeQuestionName(binding, prepared.name)
        : undefined;
      if (binding && issuedQuestionName) {
        const alreadyIssued = verifyNativeQuestionId({
          session: binding.session,
          name: issuedQuestionName,
          id: prepared.id,
        });
        if (!alreadyIssued) {
          const issuedId = issueNativeQuestionId({
            session: binding.session,
            name: issuedQuestionName,
            currentId: prepared.id,
          });
          prepared = { ...prepared, id: issuedId };
          issuedNativeQuestions.push({
            id: issuedId,
            name: issuedQuestionName,
          });
          changed = true;
        }
      }
      if (prepared !== call) return prepared;
      if (
        binding.request.platformToolNames?.has(call.name) === true &&
        archestraMcpBranding.getToolShortName(
          this.canonicalize(binding, call.name),
        ) === TOOL_ASK_USER_SHORT_NAME
      ) {
        const stamped = stampAskUserOffers(
          call,
          binding?.request.askUserOfferClaims,
          claimedOfferIds,
        );
        changed ||= stamped !== call;
        return stamped;
      }
      return call;
    });
    await Promise.all(
      issuedNativeQuestions.map((question) =>
        cacheManager.set(
          nativeQuestionCacheKey({
            session: binding.session,
            id: question.id,
          }),
          { name: question.name },
          TimeInMs.Minute * 10,
        ),
      ),
    );
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
      isUserQuestion: (name) => isUserQuestionCall(binding, name),
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

  /**
   * Converts an ask_user call to the client's native question tool when the
   * client cannot show MCP choice forms. Preserves the original tool call ID.
   * Leaves the call unchanged for clients without native question tools.
   */
  private asNativeQuestion(
    binding: AppaPluginBinding,
    call: LlmProxyToolCallsContext["toolCalls"][number],
  ): LlmProxyToolCallsContext["toolCalls"][number] {
    const native = binding.adapter?.nativeQuestion;
    if (
      !native?.fromAskUser ||
      binding.request.spellings.get(native.toolName) !== native.toolName ||
      archestraMcpBranding.getToolShortName(
        this.canonicalize(binding, call.name),
      ) !== TOOL_ASK_USER_SHORT_NAME
    ) {
      return call;
    }
    const args = parseAskUserArguments(call.arguments);
    if (!args) return call;
    return {
      id: call.id,
      name: native.toolName,
      arguments: JSON.stringify(native.fromAskUser(args)),
    };
  }

  private canonicalize(binding: AppaPluginBinding, name: string): string {
    const canonical = binding.canonicalizeToolName(name);
    // A gateway tool whatever the client's local naming says: a name the
    // canonicalizer rewrote is a client's decoration of one (OpenCode's
    // `<label>_<tool>`), and Codex declares an MCP server's tools inside the
    // server's namespace under their bare names.
    const gateway =
      canonical !== name ||
      binding.request.namespaces
        .get(name)
        ?.startsWith(CODEX_MCP_NAMESPACE_PREFIX);
    return !gateway && binding.adapter?.classifyToolName(name) === "local"
      ? binding.canonicalizeToolName(
          binding.adapter.normalizeLocalToolName(name),
        )
      : canonical;
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

function parseAskUserArguments(
  raw: string | Record<string, unknown>,
): AskUserArguments | undefined {
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return undefined;
    }
  }
  const args = value as Partial<AskUserArguments> | null;
  if (
    typeof args?.question !== "string" ||
    !Array.isArray(args.options) ||
    !args.options.every((option) => typeof option?.label === "string")
  ) {
    return undefined;
  }
  return args as AskUserArguments;
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
  // The proxy alone writes the receipt and JWS members. This prevents
  // replaying stale signatures from previous remedy calls.
  const clientArguments = withoutStampedArguments({
    tool: TOOL_EXECUTE_REMEDY_PLAN_SHORT_NAME,
    args: argumentRecord,
  });
  const execution = {
    v: 1,
    kind: "appa_remedy",
    call_id: call.id,
    tool_name: call.name,
    original_arguments:
      Object.keys(clientArguments).length === Object.keys(argumentRecord).length
        ? originalArguments
        : JSON.stringify(clientArguments),
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
 * Attaches signed offer envelopes from this turn's notices to an ask_user call.
 * This lets the tool include a verified remedy continuation in its result.
 * The proxy is the sole writer of this field; client-supplied copies are stripped first.
 */
function stampAskUserOffers(
  call: LlmProxyToolCallsContext["toolCalls"][number],
  offerClaims: readonly OfferJws[] | undefined,
  claimedOfferIds: Set<string>,
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
  const clientArguments = withoutStampedArguments({
    tool: TOOL_ASK_USER_SHORT_NAME,
    args: argumentRecord,
  });
  const requestedOfferIdValues = Array.isArray(clientArguments.remedy_offer_ids)
    ? clientArguments.remedy_offer_ids
    : [];
  const requestedOfferIds = requestedOfferIdValues.filter(
    (id): id is string => typeof id === "string" && id.length > 0,
  );
  const requested = new Set(requestedOfferIds);
  const offersById = new Map(
    (offerClaims ?? []).flatMap((offer) => {
      const offerId = offerIdFromJws(offer);
      return offerId ? [[offerId, offer] as const] : [];
    }),
  );
  const validBinding =
    requested.size > 0 &&
    requested.size <= 12 &&
    requestedOfferIds.length === requestedOfferIdValues.length &&
    requested.size === requestedOfferIds.length &&
    requestedOfferIds.every(
      (id) => offersById.has(id) && !claimedOfferIds.has(id),
    );
  const selectedOffers = validBinding
    ? requestedOfferIds.map((id) => offersById.get(id) as OfferJws)
    : [];
  if (selectedOffers.length === 0) {
    // No offer from this turn to carry, but a copy the model wrote itself
    // still goes.
    return Object.keys(clientArguments).length ===
      Object.keys(argumentRecord).length
      ? call
      : { ...call, arguments: JSON.stringify(clientArguments) };
  }
  for (const id of requestedOfferIds) claimedOfferIds.add(id);
  return {
    ...call,
    arguments: JSON.stringify({
      ...clientArguments,
      remedy_offers: selectedOffers,
    }),
  };
}

/** A call's arguments without the ones only the proxy may write for `tool`. */
function withoutStampedArguments(params: {
  tool: keyof typeof PROXY_STAMPED_TOOL_ARGUMENTS;
  args: Record<string, unknown>;
}): Record<string, unknown> {
  const stamped: readonly string[] = PROXY_STAMPED_TOOL_ARGUMENTS[params.tool];
  return Object.fromEntries(
    Object.entries(params.args).filter(([name]) => !stamped.includes(name)),
  );
}

const QUESTION_CONTINUATION_GUIDANCE = [
  "Question tools collect the user's decisions.",
  "A selected answer delivered by a recognized question tool is the user's interactive reply.",
  "It satisfies an instruction to wait for the user's answer; do not require a second free-text answer or reconfirm the same decision.",
  "Carrying out the user's explicitly selected remedy is following that decision, not choosing a remedy yourself.",
  "If the requested task still has unfinished work, continue using that answer in this turn rather than ending with only an acknowledgment.",
  "If the user asked only to record a decision, do not perform extra actions.",
  "A form's accept/submitted status is not by itself agreement with a remedy: follow the selected answer.",
  "Only if the answer explicitly accepts a currently offered, unexecuted remedy, call the declared execute_remedy_plan tool for that offer.",
  "Retry the blocked call once only after the remedy reports successful authorization.",
  "If the remedy fails, its result is withheld, or the retry is blocked again, stop and report that failure; do not apply new offers or repeat the workflow under the earlier acceptance.",
  "For a tool discovered through search_tools that is not directly declared, execute that retry using the same gateway's declared run_tool: put the discovered tool name in tool_name and the original arguments in tool_args.",
  "Resource listing is not tool execution. Do not substitute list_mcp_resources for that retry.",
  "Never invent a plan, treat an error or missing answer as consent, or repeat a completed remedy or retry.",
  "If a question is declined, dismissed, cancelled, or unanswered, do not proceed with its dependent action.",
  "State briefly that it will not proceed, then stop that action without repeating options, asking again, or adding a follow-up question or invitation (including 'let me know').",
  "Continue only independent work supported by other answers.",
  "Revisit a rejected decision only after a new user request.",
].join(" ");

const NATIVE_QUESTION_ID_PATTERN =
  /^(toolu|call|aq)_aq1_([A-Za-z0-9_-]{16})_([A-Za-z0-9_-]{22})$/;

function isGatewayAskUser(binding: AppaPluginBinding, name: string): boolean {
  const namespace = binding.request.namespaces.get(name);
  if (namespace) {
    const namespaced = `${namespace}__${name}`;
    const canonical = binding.canonicalizeToolName(namespaced);
    return (
      canonical !== namespaced &&
      archestraMcpBranding.getToolShortName(canonical) ===
        TOOL_ASK_USER_SHORT_NAME
    );
  }
  return (
    archestraMcpBranding.getToolShortName(
      binding.canonicalizeToolName(name),
    ) === TOOL_ASK_USER_SHORT_NAME
  );
}

function isUserQuestionCall(binding: AppaPluginBinding, name: string): boolean {
  return (
    binding.request.platformToolNames?.has(name) === true ||
    nativeQuestionName(binding, name) !== undefined ||
    isGatewayAskUser(binding, name)
  );
}

function isUserQuestionResult(params: {
  binding: AppaPluginBinding;
  answer: { id: string; name: string };
  verifiedNativeQuestionResults: ReadonlySet<object>;
}): boolean {
  if (
    params.binding.request.platformToolNames?.has(params.answer.name) === true
  )
    return true;
  if (isGatewayAskUser(params.binding, params.answer.name)) return true;
  const name = nativeQuestionName(params.binding, params.answer.name);
  return (
    name !== undefined &&
    params.verifiedNativeQuestionResults.has(params.answer)
  );
}

async function claimNativeQuestionResults(params: {
  binding: AppaPluginBinding;
  results: ReadonlyArray<{ id: string; name: string }>;
}): Promise<Set<object>> {
  const candidates = params.results.flatMap((result) => {
    const name = nativeQuestionName(params.binding, result.name);
    if (
      !name ||
      !verifyNativeQuestionId({
        session: params.binding.session,
        name,
        id: result.id,
      })
    ) {
      return [];
    }
    return [
      {
        result,
        name,
        key: nativeQuestionCacheKey({
          session: params.binding.session,
          id: result.id,
        }),
      },
    ];
  });
  const verified = new Set<object>();
  if (candidates.length === 0) return verified;
  const claimed = new Map(
    (
      await cacheManager.getAndDeleteMany<{ name?: unknown }>(
        candidates.map((candidate) => candidate.key),
      )
    ).map((entry) => [entry.key, entry.value]),
  );
  for (const candidate of candidates) {
    if (claimed.get(candidate.key)?.name === candidate.name) {
      verified.add(candidate.result);
    }
  }
  return verified;
}

function assertUniqueNativeQuestionResultIds(params: {
  binding: AppaPluginBinding;
  results: ReadonlyArray<{ id: string; name: string }>;
}): void {
  const signedIds = new Set<string>();
  for (const result of params.results) {
    const name = nativeQuestionName(params.binding, result.name);
    if (
      name &&
      verifyNativeQuestionId({
        session: params.binding.session,
        name,
        id: result.id,
      })
    ) {
      signedIds.add(result.id);
    }
  }
  const seen = new Set<string>();
  for (const result of params.results) {
    if (seen.has(result.id) && signedIds.has(result.id)) {
      throw new ApiError(
        400,
        "Duplicate native question result IDs are not allowed",
      );
    }
    seen.add(result.id);
  }
}

function nativeQuestionName(
  binding: AppaPluginBinding,
  name: string,
): string | undefined {
  const native = binding.adapter?.nativeQuestion;
  if (!native || !binding.adapter) return undefined;
  const namespace = binding.request.namespaces.get(name);
  const gateway =
    namespace?.startsWith(CODEX_MCP_NAMESPACE_PREFIX) ||
    binding.adapter.classifyToolName(name) === "gateway" ||
    binding.canonicalizeToolName(name) !== name;
  if (gateway) return undefined;
  const normalized = binding.adapter.normalizeLocalToolName(name);
  return normalized === native.toolName ? normalized : undefined;
}

function issueNativeQuestionId(params: {
  session: OpenAppaSession;
  name: string;
  currentId: string;
}): string {
  if (!config.openappa.offerSigningSecret) {
    throw new ApiError(
      503,
      "OpenAPPA native question signing is not configured (ARCHESTRA_OPENAPPA_OFFER_SIGNING_SECRET)",
    );
  }
  const nonce = randomBytes(12).toString("base64url");
  const prefix = params.currentId.startsWith("toolu_")
    ? "toolu"
    : params.currentId.startsWith("call_")
      ? "call"
      : "aq";
  return `${prefix}_aq1_${nonce}_${nativeQuestionTag({
    session: params.session,
    name: params.name,
    nonce,
  }).toString("base64url")}`;
}

function verifyNativeQuestionId(params: {
  session: OpenAppaSession;
  name: string;
  id: string;
}): boolean {
  if (!config.openappa.offerSigningSecret) return false;
  const match = NATIVE_QUESTION_ID_PATTERN.exec(params.id);
  if (!match) return false;
  const [, , nonce, signature] = match;
  const actual = Buffer.from(signature, "base64url");
  if (actual.toString("base64url") !== signature) return false;
  const expected = nativeQuestionTag({
    session: params.session,
    name: params.name,
    nonce,
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function nativeQuestionCacheKey(params: {
  session: OpenAppaSession;
  id: string;
}): AllowedCacheKey {
  return `${CacheKey.OpenAppaNativeQuestion}-${encodeURIComponent(
    params.session.organization_id,
  )}:${encodeURIComponent(params.session.caller_id ?? "")}:${encodeURIComponent(
    params.session.session_id,
  )}:${encodeURIComponent(params.session.parent_id ?? "")}:${encodeURIComponent(
    params.id,
  )}`;
}

function nativeQuestionTag(params: {
  session: OpenAppaSession;
  name: string;
  nonce: string;
}): Buffer {
  return createHmac("sha256", config.openappa.offerSigningSecret)
    .update("archestra-native-question-v1\0")
    .update(
      JSON.stringify([
        params.session.organization_id,
        params.session.caller_id ?? "",
        params.session.session_id,
        params.session.parent_id ?? "",
        params.name,
        params.nonce,
      ]),
    )
    .digest()
    .subarray(0, 16);
}

function appendQuestionContinuation(params: {
  request: unknown;
  interactionType: string;
}): void {
  if (!isRecord(params.request)) return;
  if (params.interactionType === "openai:responses") {
    if (typeof params.request.instructions === "string") {
      appendInstruction(params.request, "instructions");
      return;
    }
    const input = params.request.input;
    if (!Array.isArray(input)) return;
    if (
      !input.some(
        (item) =>
          isRecord(item) &&
          item.role === "developer" &&
          Array.isArray(item.content) &&
          item.content.some(
            (block) =>
              isRecord(block) &&
              block.type === "input_text" &&
              block.text === QUESTION_CONTINUATION_GUIDANCE,
          ),
      )
    ) {
      input.push({
        type: "message",
        role: "developer",
        content: [{ type: "input_text", text: QUESTION_CONTINUATION_GUIDANCE }],
      });
    }
    return;
  }
  if (params.interactionType === "openai:chatCompletions") {
    const messages = params.request.messages;
    if (!Array.isArray(messages)) return;
    if (
      messages.some(
        (message) =>
          isRecord(message) &&
          message.role === "developer" &&
          message.content === QUESTION_CONTINUATION_GUIDANCE,
      )
    ) {
      return;
    }
    messages.push({
      role: "developer",
      content: QUESTION_CONTINUATION_GUIDANCE,
    });
    return;
  }
  if (params.interactionType === "anthropic:messages") {
    if (Array.isArray(params.request.system)) {
      if (
        !params.request.system.some(
          (block) =>
            isRecord(block) &&
            block.type === "text" &&
            block.text === QUESTION_CONTINUATION_GUIDANCE,
        )
      ) {
        params.request.system.push({
          type: "text",
          text: QUESTION_CONTINUATION_GUIDANCE,
        });
      }
      return;
    }
    appendInstruction(params.request, "system");
  }
}

function appendInstruction(
  request: Record<string, unknown>,
  key: "instructions" | "system",
): void {
  const instructions = request[key];
  if (
    typeof instructions === "string" &&
    instructions.includes(QUESTION_CONTINUATION_GUIDANCE)
  ) {
    return;
  }
  request[key] =
    typeof instructions === "string" && instructions.length > 0
      ? `${instructions}\n\n${QUESTION_CONTINUATION_GUIDANCE}`
      : QUESTION_CONTINUATION_GUIDANCE;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
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
