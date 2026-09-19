import { MCP_SERVER_TOOL_NAME_SEPARATOR } from "@archestra/shared";
import config from "@/config";
import { recordResponseAnchors } from "@/openappa/context-anchors";
import { buildNoticeArguments, type RemedyExecution } from "@/openappa/notice";
import type { OfferJws } from "@/openappa/offer-claims";
import {
  offerIdFromJws,
  offerSessionFromJws,
  signOfferClaims,
  unsignedOfferClaims,
} from "@/openappa/offer-claims";
import { underscoreLabeledPlatformToolName } from "@/openappa/request";
import {
  cancelCalls,
  endTurn,
  evaluateHostedToolCalls,
  evaluateToolCalls,
  notePrompt,
  type OpenAppaSession,
  processProxyResults,
} from "@/openappa/service";
import { stampToolCallId } from "@/openappa/trajectory-stamp";
import { appaWireFamily } from "@/openappa/wire";
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
      const binding = this.bindings.get(context.resources);
      const stamped = stampControlExecution(
        call,
        binding &&
          sessionOfferClaims(
            binding.request.offerClaims,
            binding.session.session_id,
          ),
      );
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
        ...noticeNamespace(binding.request),
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
    const control = binding.request.tools?.controlToolName;
    const decisions = await evaluateToolCalls(
      binding.session,
      calls.map((call) => ({
        ...call,
        name: namespacedToolName(call.name, call.namespace),
      })),
      {
        canonicalize: (name) => this.canonicalize(binding, name),
        ...(control
          ? {
              controlToolName: namespacedToolName(
                control,
                binding.request.namespaces.get(control),
              ),
            }
          : {}),
      },
    );

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
        ...noticeNamespace(binding.request),
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
              ...(identity.dispatch ? { dispatch: identity.dispatch } : {}),
            }),
            session: clientSessionId(binding.session.session_id),
          }),
        ),
      });
    }

    // Keep turn open while tool calls are awaiting client execution.
    binding.turnOpen = true;
    const stamp = trajectoryStamper(binding, context.interactionType);
    if (blocked.length === 0 && !stamp) return;
    return {
      decision: "allow",
      toolCalls: stamp ? released.map(stamp) : released,
      ...(blocked.length > 0 ? { blocked } : {}),
    };
  }

  async onModelResponse(
    context: LlmProxyModelResponseContext,
  ): Promise<undefined> {
    const binding = this.bindings.get(context.resources);
    if (!binding) return;
    const family = appaWireFamily(context.interactionType);
    if (family && tracesLineage(binding)) {
      await recordResponseAnchors({
        session: binding.session,
        family,
        response: context.response,
      });
    }
    if (!binding.request.tools || binding.turnOpen) return;
    if (!binding.request.turnEndOperationId) return;
    await endTurn(binding.session, binding.request.turnEndOperationId);
    return undefined;
  }

  async onCleanup(context: LlmProxyRequestContext): Promise<void> {
    this.bindings.delete(context.resources);
  }

  // === Internal helpers ===

  private canonicalize(binding: AppaPluginBinding, name: string): string {
    const platformTool = underscoreLabeledPlatformToolName(
      name,
      binding.canonicalizeToolName,
    );
    if (platformTool) return platformTool;
    return binding.adapter?.classifyToolName(name) === "local"
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
    /** The client's dispatch tool, when the call reached its target through it. */
    dispatch?: string;
  } {
    const [normalized] = normalizeToolCallsForPolicy(
      [
        {
          name: namespacedToolName(call.name, call.namespace),
          arguments: call.arguments,
        },
      ],
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
        dispatch: call.name,
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
  params: {
    offerIds: string[];
    tool: string;
    spelling: string;
    dispatch?: string;
  },
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
        ...(params.dispatch ? { dispatch: params.dispatch } : {}),
      }),
      secret,
    ),
  );
}

/**
 * The offers in the history that this session surfaced. A fork replays its
 * parent's notices, offers included; spending one would change the parent's
 * labels from inside the fork, so a fork's control calls carry none of them.
 */
function sessionOfferClaims(
  envelopes: readonly OfferJws[] | undefined,
  sessionId: string,
): OfferJws[] | undefined {
  return envelopes?.filter(
    (envelope) => offerSessionFromJws(envelope) === sessionId,
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

/**
 * Codex declares an MCP server's tools as members of an `mcp__<server>`
 * namespace and calls a member by its bare name. Joined with the namespace the
 * call itself names, they spell what Claude Code sends for the same tool, so
 * the gateway canonicalizer anchors it on the organization's real gateway
 * label and a same-named member of any other server keeps a foreign name.
 */
function namespacedToolName(
  name: string,
  namespace: string | undefined,
): string {
  return namespace?.startsWith(`mcp${MCP_SERVER_TOOL_NAME_SEPARATOR}`)
    ? `${namespace}${MCP_SERVER_TOOL_NAME_SEPARATOR}${name}`
    : name;
}

/** The namespace the client declared its notice tool in, which Codex needs to dispatch the notice. */
function noticeNamespace(request: {
  tools?: { noticeToolName: string };
  namespaces: ReadonlyMap<string, string>;
}): { namespace?: string } {
  const notice = request.tools?.noticeToolName;
  const namespace = notice ? request.namespaces.get(notice) : undefined;
  return namespace ? { namespace } : {};
}

/**
 * Gives every call the client receives a trajectory stamp for its id, so the
 * context this turn adds names its session wherever the client takes it (see
 * `openappa/trajectory-stamp.ts`). Only on a wire family whose history the
 * proxy restores, and only for a session scoped to its caller: Chat names its
 * conversation itself, and a stamp signed for no caller would bind nobody.
 */
function trajectoryStamper(
  binding: AppaPluginBinding,
  interactionType: string,
):
  | ((
      call: LlmProxyToolCallsContext["toolCalls"][number],
    ) => LlmProxyToolCallsContext["toolCalls"][number])
  | undefined {
  const { session } = binding;
  const callerId = session.caller_id;
  const secret = config.openappa.offerSigningSecret;
  if (
    !callerId ||
    secret.length === 0 ||
    !appaWireFamily(interactionType) ||
    !tracesLineage(binding)
  )
    return undefined;
  const sessionId = clientSessionId(session.session_id);
  return (call) => ({
    ...call,
    wireId: stampToolCallId({
      callId: call.id,
      sessionId,
      organizationId: session.organization_id,
      callerId,
      secret,
    }),
  });
}

/**
 * Whether this session's context is traced when it moves to another session:
 * a session scoped to its caller. Chat names its conversation itself.
 */
function tracesLineage(binding: AppaPluginBinding): boolean {
  const callerId = binding.session.caller_id;
  return (
    !binding.chat &&
    callerId !== undefined &&
    binding.session.session_id.startsWith(`${callerId}|`)
  );
}

function clientSessionId(scopedSessionId: string): string {
  const separator = scopedSessionId.indexOf("|");
  return separator >= 0
    ? scopedSessionId.slice(separator + 1)
    : scopedSessionId;
}
