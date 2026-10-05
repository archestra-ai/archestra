import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import {
  buildElicitationMandateInstruction,
  PROXY_STAMPED_TOOL_ARGUMENTS,
  TimeInMs,
  TOOL_ASK_USER_SHORT_NAME,
  TOOL_EXECUTE_REMEDY_PLAN_SHORT_NAME,
  TOOL_LIST_PEER_MESSAGES_SHORT_NAME,
  TOOL_READ_PEER_MESSAGE_SHORT_NAME,
} from "@archestra/shared";
import { archestraMcpBranding } from "@/archestra-mcp-server/branding";
import { type AllowedCacheKey, CacheKey, cacheManager } from "@/cache-manager";
import config from "@/config";
import logger from "@/logging";
import OpenAppaSessionModel from "@/models/openappa-session";
import OpenAppaSpawnCorrelationModel, {
  type AllowedSpawnAlias,
} from "@/models/openappa-spawn-correlation";
import { childSessionId, clientSessionId } from "@/openappa/actor";
import {
  type AppaChildReturnCompletion,
  childReturnMarkersConfigured,
  mintChildReturnMarker,
} from "@/openappa/child-return";
import { mintChildTrajectoryReceipt } from "@/openappa/child-trajectory-receipt";
import { recordOpenAppaClientFailure } from "@/openappa/client-failure-report";
import {
  delegationEnabled,
  isDelegatedPrompt,
  mintDelegationMarker,
} from "@/openappa/delegation";
import {
  getHitlAskUserArguments,
  getHitlReview,
  recordHitlRuling,
  stageLoadedHitlReview,
} from "@/openappa/hitl-review";
import { buildNoticeArguments, type RemedyExecution } from "@/openappa/notice";
import type { OfferJws } from "@/openappa/offer-claims";
import {
  offerIdFromJws,
  offerSessionFromJws,
  signOfferClaims,
  unsignedOfferClaims,
} from "@/openappa/offer-claims";
import {
  containsPeerProof,
  PEER_PROOF_ARGUMENT,
  signPeerProof,
  stripPeerProofs,
} from "@/openappa/peer-claims";
import { underscoreLabeledPlatformToolName } from "@/openappa/request";
import type { AppaRewriteReplay } from "@/openappa/rewrite-replay";
import {
  type AppaChildReturnRecord,
  admitPeerMessage,
  approveSpawnReturn,
  cancelCalls,
  endChild,
  endTurn,
  enterCapturedGuardrailsActivation,
  evaluateHostedToolCalls,
  evaluateToolCalls,
  loadChildAddresses,
  loadChildReturns,
  loadOfferReview,
  notePrompt,
  type OpenAppaSession,
  processProxyResults,
  sendPeerMessage,
  sharedPolicy,
  withCapturedGuardrailsActivation,
} from "@/openappa/service";
import {
  stampToolCallId,
  withoutTrajectoryStamp,
} from "@/openappa/trajectory-stamp";
import {
  findUnenforcedCalls,
  observeUnenforcedSession,
  recordUnenforcedCalls,
  startedUnenforced,
  type UnenforcedCalls,
} from "@/openappa/unenforced";
import { appaWireFamily } from "@/openappa/wire";
import { rememberYellSession } from "@/openappa/yell-session";
import type {
  LlmProxyBeforeModelContext,
  LlmProxyBufferedModelResponseContext,
  LlmProxyBufferedModelResponseOutcome,
  LlmProxyContextTrust,
  LlmProxyHostedToolCallsContext,
  LlmProxyHostedToolCallsOutcome,
  LlmProxyModelResponseContext,
  LlmProxyPlugin,
  LlmProxyRequestContext,
  LlmProxyToolCallAnnotation,
  LlmProxyToolCallsContext,
  LlmProxyToolCallsOutcome,
  LlmProxyToolResultsContext,
  LlmProxyToolResultsOutcome,
} from "@/proxy/plugins/registry";
import { normalizeToolCallsForPolicy } from "@/routes/proxy/llm-proxy-helpers";
import { collectDeclaredToolNames } from "@/routes/proxy/utils/declared-tool-names";
import type { EncryptedChatAuditDisposition } from "@/routes/proxy/utils/encrypted-chat-session";
import type { ToolNameResolution } from "@/routes/proxy/utils/gateway-tool-names";
import { readGuardrailsV2Activation } from "@/services/guardrails-deployment";
import { ApiError } from "@/types";
import {
  appendPeerMessageMarker,
  escapeRelayMarkup,
} from "./adapters/claude-code-relay";
import { referencesChildTranscriptPath } from "./adapters/trajectory";
import { appaTrajectory } from "./session-identity";
import {
  APPA_AUXILIARY_ANALYSIS,
  APPA_CHILD_TRAJECTORY_RECEIPT,
  APPA_PLUGIN_TRUSTED_CONTEXT,
  APPA_REPLAY_APPROVED_TEXT,
  APPA_REPLAY_ENCRYPTION,
  APPA_REPLAY_ENVELOPE,
  APPA_REPLAY_SESSION,
  type AppaChildTrajectory,
  type AppaClientAdapter,
  type AppaRelayArrival,
  type AppaRelayMessage,
  type AppaTrustedContext,
  type AskUserArguments,
} from "./types";
import { withoutCallerScope } from "./utils";

type AppaPluginBinding = {
  session: OpenAppaSession;
  identity: AppaTrustedContext["toolIdentity"];
  adapter: AppaClientAdapter | undefined;
  request: AppaTrustedContext["request"];
  requestBody: unknown;
  /** True when the model's response contained tool calls awaiting client execution. */
  turnOpen: boolean;
  /**
   * Admitted return text when a native handback is the only call in the batch.
   * A buffered stream replacement prevents the start proof from accompanying
   * the return.
   */
  completedHandbackReturn: string | undefined;
  /** True on internal loopback Chat requests. */
  chat: boolean;
  compaction: boolean;
  requestHeaders: IncomingHttpHeaders;
  /** A verified user-question result needs trusted workflow continuation. */
  requiresQuestionContinuation: boolean;
  /** A remedy notice requires an immediate control-tool call. */
  requiresRemedyContinuation: boolean;
  /** Offers whose first control call requested a native client review. */
  pendingHitlReviewOfferIds: string[];
  /** Verified native answers that must control the next model action. */
  nativeHitlRulings: RecordedNativeHitlRuling[];
  /** The native id this request's children will report as their parent. */
  spawnerNativeId: string | undefined;
  /** Server-bound child metadata needed to correlate its terminal return. */
  child?: AppaChildTrajectory;
  /**
   * Unscoped client session id for trajectory stamps. Captured before child
   * overlay so stamps never encode a minted parent:child id.
   */
  stampSessionId: string | undefined;
  /**
   * The calls of this request whose outcome the runtime did not see, because
   * enforcement was off: its results and its teammates' launches.
   */
  unenforcedCalls: UnenforcedCalls;
};

/** A request of a governed session, seen while enforcement is off. */
type AppaPluginObserver = {
  session: OpenAppaSession;
  adapter: AppaClientAdapter | undefined;
  requestBody: unknown;
};

type NativeQuestionClaim = {
  offerIds?: string[];
};

type IssuedNativeQuestion = {
  id: string;
  name: string;
  offerIds: string[];
};

type RecordedNativeHitlRuling = {
  offerId: string;
  ruling: "approve" | "deny" | "none";
};

type ToolCall = LlmProxyToolCallsContext["toolCalls"][number];

export class AppaPluginArchestra implements LlmProxyPlugin {
  readonly id = "archestra.appa";
  readonly finalizesToolCalls = true;
  private readonly bindings = new WeakMap<object, AppaPluginBinding>();
  private readonly observers = new WeakMap<object, AppaPluginObserver>();

  constructor(private readonly clientAdapters: readonly AppaClientAdapter[]) {}

  async onSessionInit(context: LlmProxyRequestContext): Promise<void> {
    this.bindings.delete(context.resources);
    this.observers.delete(context.resources);
    const trustedContext = getTrustedContext(context.resources);
    if (!trustedContext) return;
    const enforcement = await enforcementFor(trustedContext);
    if (enforcement !== "active") {
      await this.observe(context, trustedContext);
      return;
    }
    const chat = trustedContext.chatSource !== undefined;
    const trajectory = appaTrajectory({
      adapters: this.clientAdapters,
      headers: context.headers,
      requestBody: context.requestBody,
      trustedContext,
    });
    const binding: AppaPluginBinding = {
      session: trajectory.session,
      identity: trustedContext.toolIdentity,
      adapter: trajectory.adapter,
      request: trustedContext.request,
      requestBody: context.requestBody,
      turnOpen: false,
      completedHandbackReturn: undefined,
      chat,
      compaction: trustedContext.compaction === true,
      requestHeaders: context.headers,
      requiresQuestionContinuation: false,
      requiresRemedyContinuation: false,
      pendingHitlReviewOfferIds: [],
      nativeHitlRulings: [],
      spawnerNativeId: trajectory.adapter?.nativeConversationId(
        trajectory.matchContext,
      ),
      stampSessionId: tracesLineage(trustedContext.session, chat)
        ? clientSessionId(trustedContext.session.session_id)
        : undefined,
      unenforcedCalls: { reasons: new Map(), children: new Set() },
    };
    if (trajectory.child) {
      binding.child = trajectory.child;
      issueChildTrajectoryReceipt(context, binding.session, trajectory.child);
    }
    this.bindings.set(context.resources, binding);
    context.resources.set(APPA_REPLAY_SESSION, binding.session);
  }

  async onToolResults(
    context: LlmProxyToolResultsContext,
  ): Promise<LlmProxyToolResultsOutcome | undefined> {
    const binding = this.bindings.get(context.resources);
    if (!binding) return;
    enterCapturedGuardrailsActivation("active");
    const completions = binding.request.childReturns?.completions ?? [];
    binding.unenforcedCalls = await findUnenforcedCalls({
      session: binding.session,
      childNativeIds: completions.flatMap((completion) =>
        completion.childNativeId ? [completion.childNativeId] : [],
      ),
      toolCallIds: [
        ...context.toolResults.map((result) => result.id),
        ...completions.flatMap((completion) => [
          ...(completion.spawnCallId ? [completion.spawnCallId] : []),
          ...(completion.envelopeId ? [completion.envelopeId] : []),
        ]),
        ...[
          ...(binding.adapter
            ?.teammateLaunches?.(binding.requestBody)
            ?.values() ?? []),
        ].map((launch) => launch.spawnCallId),
      ],
    });
    // The runtime never saw a call the model made while enforcement was off,
    // so OpenAPPA ignores its result: the result reaches the model as it is.
    const toolResults = context.toolResults.filter(
      (result) =>
        binding.unenforcedCalls.reasons.get(
          withoutTrajectoryStamp(result.id),
        ) !== "made",
    );
    const childResultUpdates: Record<string, string> = Object.create(null);
    const results = toolResults.map((result) => {
      const content = binding.adapter?.normalizeChildLaunchResult?.(result);
      if (content === undefined) return result;
      childResultUpdates[result.id] = content;
      return { ...result, content };
    });
    const childReturns = await approveChildReturnCarriers({
      binding,
      results,
    });
    Object.assign(childResultUpdates, childReturns.updates);
    await admitRelayReports({
      binding,
      session: this.governedSession(binding),
      results,
      updates: childResultUpdates,
    });
    // Requests with results submit them to runtime even if current request
    // declares no tools. Proxy-only sessions declared local tools, so their
    // session still starts; a session that declared nothing has nothing to do.
    if (
      !binding.request.tools &&
      toolResults.length === 0 &&
      binding.request.declaredTools.length === 0
    ) {
      return;
    }
    assertUniqueNativeQuestionResultIds({
      binding,
      results: toolResults,
    });
    const verifiedNativeQuestionResults = await claimNativeQuestionResults({
      binding,
      results: toolResults,
    });
    binding.nativeHitlRulings = await recordNativeHitlRulings({
      binding,
      verifiedNativeQuestionResults,
    });
    binding.pendingHitlReviewOfferIds = await pendingNativeHitlOfferIds({
      binding,
      results: toolResults,
      resolvedOfferIds: new Set(
        binding.nativeHitlRulings.map((entry) => entry.offerId),
      ),
    });
    binding.requiresRemedyContinuation = hasRemedyOfferResult({
      binding,
      results: toolResults,
      verifiedNativeQuestionResults,
    });
    // A handback's result and a message's delivery receipt are the client's
    // acknowledgements of calls the runtime already governed as crossings. A
    // child return that OpenAPPA ignores never reaches the runtime.
    await withholdUnrecordedPeerReads({
      binding,
      session: this.governedSession(binding),
      results,
      updates: childResultUpdates,
    });
    const nonHandbackResults = results
      .filter(
        (result) =>
          !binding.adapter?.isChildHandbackTool?.(result.name) &&
          !binding.adapter?.isRelayTool?.(result.name) &&
          !isPeerInboxResult(binding, result.name) &&
          !childReturns.ignored.has(result.id),
      )
      // An answer to an issued question is recognized as the very result the
      // client sent, so a result nothing rewrote goes on as that object.
      .map((result) => {
        const content = childResultUpdates[result.id];
        return content === undefined ? result : { ...result, content };
      });
    const result = await processProxyResults({
      session: this.governedSession(binding),
      results: nonHandbackResults,
      encryptedChat: context.resources.get(APPA_REPLAY_ENCRYPTION) as
        | EncryptedChatAuditDisposition
        | undefined,
      canonicalize: (name: string, namespace?: string) =>
        this.canonicalize(binding, { name, namespace }),
      isUserQuestion: (answer) =>
        isUserQuestionResult({
          binding,
          answer,
          verifiedNativeQuestionResults,
        }) || isIssuedQuestionAnswer(binding, answer),
      classifySpawnResult: (answer) => {
        if (!binding.adapter?.isSpawnTool(answer.name, answer.namespace))
          return undefined;
        if (binding.request.restoredNoticeCallIds?.has(answer.id))
          return "pending";
        return (
          binding.adapter.classifySpawnResult?.(answer) ??
          (answer.isError ? "failed" : "pending")
        );
      },
      controlToolName:
        binding.request.tools?.control.name ??
        binding.request.historicalControlToolName,
      isControlResult: (answer) => isOwnControlResult(binding, answer),
      trustedChat: binding.chat,
    });
    const toolResultUpdates = {
      ...childResultUpdates,
      ...Object.fromEntries(
        Object.entries(result.toolResultUpdates).map(([id, result]) => [
          id,
          result.content,
        ]),
      ),
    };
    if (
      binding.adapter &&
      !binding.chat &&
      toolResults.some(
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
    if (!binding) {
      if (containsPeerProof(context.request)) {
        throw new ApiError(
          409,
          "OpenAPPA cannot forward a peer proof while Guardrails enforcement is off",
        );
      }
      return;
    }
    if (!context.resources.has(APPA_REPLAY_SESSION)) {
      // Quoted analysis and other non-trajectory side calls have no ledger.
      // Stripping ids, parsing relay tags, or appending guidance would be an
      // unrecorded provider-visible rewrite, and would treat quoted text as a
      // carrier. Peer proofs never take this path: they keep the fail-closed
      // branch below.
      if (context.resources.has(APPA_AUXILIARY_ANALYSIS)) return;
      const before = JSON.stringify(context.request);
      enterCapturedGuardrailsActivation("active");
      binding.adapter?.stripCarrierMetadata(context.request);
      stripPeerProofs(context.request);
      await admitRelayArrivals({
        binding,
        session: this.governedSession(binding),
        request: context.request,
      });
      if (JSON.stringify(context.request) !== before) {
        throw new ApiError(
          409,
          "OpenAPPA cannot record a provider-visible rewrite without a replay session",
        );
      }
      return;
    }
    const transform = async () => {
      if (binding) enterCapturedGuardrailsActivation("active");
      binding?.adapter?.stripCarrierMetadata(context.request);
      stripPeerProofs(context.request);
      // A compaction summarizes the history, so an unchecked message would
      // survive into the summary: messages are admitted before either turn.
      if (binding) {
        await admitRelayArrivals({
          binding,
          session: this.governedSession(binding),
          request: context.request,
        });
      }
      if (binding?.compaction) return;
      if (
        binding?.child?.lineage &&
        binding.adapter?.id === "opencode" &&
        isRecord(context.request)
      ) {
        anchorConstantGuidance({
          request: context.request,
          interactionType: context.interactionType,
          guidance: OPENCODE_DELEGATED_TASK_GUIDANCE,
        });
      }
      if (
        binding &&
        nativeHandbackBoundary(binding) &&
        isRecord(context.request)
      ) {
        const guidance = binding.adapter?.nativeHandbackGuidance?.();
        if (guidance) {
          anchorConstantGuidance({
            request: context.request,
            interactionType: context.interactionType,
            guidance,
          });
        }
      }
      if (binding?.adapter?.id === "codex") {
        appendNativeDelegationGuidance(context);
      }
      if (
        binding &&
        binding.adapter?.id !== "archestra-chat" &&
        isRecord(context.request)
      ) {
        if (binding.request.tools?.control) {
          anchorConstantGuidance({
            request: context.request,
            interactionType: context.interactionType,
            guidance: EXTERNAL_REMEDY_WORKFLOW_GUIDANCE,
          });
        }
        const askUser = binding.request.tools?.askUser;
        const nativeQuestion =
          binding.adapter?.nativeQuestion &&
          declaresNativeQuestion(
            binding,
            binding.adapter.nativeQuestion.toolName,
          )
            ? binding.adapter.nativeQuestion.toolName
            : undefined;
        const askUserTool = askUser?.name;
        if (askUserTool || nativeQuestion) {
          anchorConstantGuidance({
            request: context.request,
            interactionType: context.interactionType,
            guidance: buildElicitationMandateInstruction({
              askUserToolName: askUserTool,
              nativeQuestionToolName: nativeQuestion,
            }),
          });
          anchorConstantGuidance({
            request: context.request,
            interactionType: context.interactionType,
            guidance: QUESTION_CONTINUATION_GUIDANCE,
          });
        }
      }
      if (binding && binding.pendingHitlReviewOfferIds.length > 0) {
        binding.pendingHitlReviewOfferIds = [];
        requireCodexToolCall({ binding, context });
      }
      if (binding?.requiresRemedyContinuation) {
        binding.requiresRemedyContinuation = false;
        requireCodexToolCall({ binding, context });
      }
      if (binding && binding.nativeHitlRulings.length > 0) {
        const rulings = binding.nativeHitlRulings;
        binding.requiresQuestionContinuation = false;
        if (rulings.some((entry) => entry.ruling === "approve")) {
          requireCodexToolCall({ binding, context });
        }
      }
      if (!binding || (!binding.request.tools && !binding.session.parent_id))
        return;
      if (!binding.request.promptOperationId) {
        // Tool-result requests continue the active turn without a new prompt.
        return;
      }
      const session = this.governedSession(binding);
      await notePrompt(
        session,
        binding.request.promptOperationId,
        binding.child?.lineage,
      );
    };
    const recorder = context.resources.get(APPA_REPLAY_ENVELOPE) as
      | AppaRewriteReplay
      | undefined;
    if (recorder) {
      await recorder.rewriteEnvelope({ request: context.request, transform });
    } else {
      await transform();
    }
  }

  async onPrepareToolCalls(
    context: LlmProxyToolCallsContext,
  ): Promise<LlmProxyToolCallsOutcome | undefined> {
    const binding = this.bindings.get(context.resources);
    if (!binding) return;
    enterCapturedGuardrailsActivation("active");
    const tools = binding.request.tools;
    if (!tools) {
      // A proxy-only session declares no APPA tools, but the runtime still
      // releases the client's own question calls, so their answers need the
      // signed id too.
      const issuedNativeQuestions: IssuedNativeQuestion[] = [];
      const toolCalls = context.toolCalls.map((call) => {
        const issued = withNativeQuestionId(binding, call);
        if (!issued) return call;
        issuedNativeQuestions.push({ ...issued.question, offerIds: [] });
        return issued.call;
      });
      if (issuedNativeQuestions.length === 0) return;
      await rememberNativeQuestions(binding, issuedNativeQuestions);
      return { decision: "allow", toolCalls };
    }
    // Restore before host validation; finalization may only append the child
    // receipt, never change the arguments the other policies already checked.
    let incomingToolCalls = restoreAuthorizedSpawnRetry({
      calls: context.toolCalls,
      requestBody: binding.requestBody,
      isSpawn: (name, namespace) =>
        binding.adapter?.isSpawnTool(name, namespace) === true,
    });
    let changed = incomingToolCalls !== context.toolCalls;
    if (binding.nativeHitlRulings.length > 0) {
      const blocked = context.toolCalls[0];
      if (!blocked) return;
      if (
        binding.nativeHitlRulings.some((entry) => entry.ruling !== "approve")
      ) {
        const message =
          "The human did not approve this OpenAPPA review. Keep the dependent tool call blocked.";
        return {
          decision: "refuse",
          refusal: {
            refusalMessage: message,
            contentMessage: message,
            reason: "openappa_hitl_not_approved",
            blockedToolName: blocked.name,
            blockedToolId: blocked.id,
            toolInput: toolInputOf(blocked.arguments),
            allToolCallNames: context.toolCalls.map((call) => call.name),
          },
        };
      }
      if (binding.nativeHitlRulings.length !== 1) {
        const message = "Complete one approved OpenAPPA offer at a time.";
        return {
          decision: "refuse",
          refusal: {
            refusalMessage: message,
            contentMessage: message,
            reason: "openappa_hitl_offer_count",
            blockedToolName: blocked.name,
            blockedToolId: blocked.id,
            toolInput: toolInputOf(blocked.arguments),
            allToolCallNames: context.toolCalls.map((call) => call.name),
          },
        };
      }
      const approved = binding.nativeHitlRulings[0];
      const pending = await getHitlReview({
        session: binding.session,
        offerId: approved.offerId,
      });
      if (!pending?.remedyArguments) {
        const message =
          "The approved OpenAPPA review is no longer available. Keep the tool call blocked.";
        return {
          decision: "refuse",
          refusal: {
            refusalMessage: message,
            contentMessage: message,
            reason: "openappa_hitl_review_missing",
            blockedToolName: blocked.name,
            blockedToolId: blocked.id,
            toolInput: toolInputOf(blocked.arguments),
            allToolCallNames: context.toolCalls.map((call) => call.name),
          },
        };
      }
      incomingToolCalls = [
        {
          id: blocked.id,
          name: tools.control.name,
          ...(tools.control.namespace
            ? { namespace: tools.control.namespace }
            : {}),
          arguments: JSON.stringify(pending.remedyArguments),
        },
      ];
      binding.nativeHitlRulings = [];
      changed = true;
    }
    const claimedOfferIds = new Set<string>();
    const issuedNativeQuestions: IssuedNativeQuestion[] = [];
    const toolCalls: Array<(typeof context.toolCalls)[number]> = [];
    for (const call of incomingToolCalls) {
      // The declared control tool itself, in its own namespace: a same-named
      // tool of another server gets no receipt. Only offers the client's own
      // session minted may ride it.
      if (
        call.name === tools.control.name &&
        call.namespace === tools.control.namespace
      ) {
        const stamped = stampControlExecution(
          call,
          sessionOfferClaims(
            binding.request.offerClaims,
            binding.session.session_id,
          ),
        );
        changed ||= stamped !== call;
        toolCalls.push(stamped);
        continue;
      }
      let prepared = call;
      let offerIds: string[] = [];
      if (
        call.name === tools.askUser?.name &&
        call.namespace === tools.askUser.namespace &&
        archestraMcpBranding.getToolShortName(
          this.canonicalize(binding, call),
        ) === TOOL_ASK_USER_SHORT_NAME
      ) {
        const stamped = stampAskUserOffers(
          call,
          binding.request.askUserOfferClaims,
          claimedOfferIds,
        );
        prepared = stamped.call;
        offerIds = stamped.offerIds;
        const canonical = await canonicalizeHitlAskUserCall({
          binding,
          call: prepared,
          offerIds,
        });
        if (canonical.invalidOfferCount) {
          const message =
            "Submit each pending OpenAPPA HITL offer in a separate ask_user call.";
          return {
            decision: "refuse",
            refusal: {
              refusalMessage: message,
              contentMessage: message,
              reason: "openappa_hitl_offer_count",
              blockedToolName: call.name,
              blockedToolId: call.id,
              toolInput: toolInputOf(call.arguments),
              allToolCallNames: context.toolCalls.map((item) => item.name),
            },
          };
        }
        prepared = canonical.call;
        changed ||= prepared !== call;
      }
      // Before any policy sees it: the call the policies rule on is the one
      // the client will run.
      const nativeQuestion = this.asNativeQuestion(binding, prepared);
      changed ||= nativeQuestion !== prepared;
      prepared = nativeQuestion;
      const issued = withNativeQuestionId(binding, prepared, offerIds);
      if (issued) {
        prepared = issued.call;
        issuedNativeQuestions.push({ ...issued.question, offerIds });
        changed = true;
      }
      toolCalls.push(prepared);
    }
    await rememberNativeQuestions(binding, issuedNativeQuestions);
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
    enterCapturedGuardrailsActivation("active");
    const calls = [...context.hostedToolCalls];
    const decisions = await withCapturedGuardrailsActivation("active", () =>
      evaluateHostedToolCalls(this.governedSession(binding), calls, {
        ...this.resolution(binding),
        control: tools.control,
        lineage: binding.child?.lineage,
      }),
    );
    const held = calls.flatMap((call, index) => {
      const decision = decisions[index];
      return decision.kind === "hold"
        ? [{ call, feedback: decision.feedback }]
        : [];
    });
    if (held.length === 0) return { decision: "release" };
    // The client must run the notices, so the turn stays open.
    binding.turnOpen = true;
    const notices = held.map(({ call, feedback }) => ({
      id: call.id,
      name: tools.notice.name,
      ...(tools.notice.namespace ? { namespace: tools.notice.namespace } : {}),
      arguments: JSON.stringify(
        buildNoticeArguments({
          id: call.id,
          tool: call.name,
          arguments: call.arguments,
          result: feedback,
        }),
      ),
    }));
    const stamp = trajectoryStamper(binding, context);
    return {
      decision: "hold",
      notices: stamp ? notices.map(stamp) : notices,
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
    const observer = this.observers.get(context.resources);
    if (observer) {
      await recordObservedCalls(observer, context.toolCalls);
      return;
    }
    const binding = this.bindings.get(context.resources);
    if (!binding) return;
    enterCapturedGuardrailsActivation("active");
    if (binding.compaction && context.toolCalls.length > 0) {
      throw new ApiError(
        503,
        "OpenAPPA rejected tool calls from a compaction response",
      );
    }
    const calls = context.toolCalls;
    const session = this.governedSession(binding);
    const handbackIds = new Set(
      binding.session.parent_id && binding.adapter?.isChildHandbackTool
        ? calls
            .filter((call) => binding.adapter?.isChildHandbackTool?.(call.name))
            .map((call) => call.id)
        : [],
    );
    // Children named by this trajectory mint under this request's own id: the
    // minted parent:child id for a child turn, the root id for a parent.
    const rootId = session.session_id;
    const blockedTranscriptCalls = new Set<string>();
    if (binding.adapter) {
      for (const call of calls) {
        // Native transcript files contain unchecked intermediate output, not
        // the child's admitted return. A correctly prefixed id is not proof
        // that reading those bytes is safe.
        if (
          !handbackIds.has(call.id) &&
          !binding.adapter.isSpawnTool(call.name, call.namespace) &&
          binding.adapter.childTranscriptPaths &&
          referencesChildTranscriptPath({
            arguments: call.arguments,
            pathPatterns: binding.adapter.childTranscriptPaths,
          })
        ) {
          blockedTranscriptCalls.add(call.id);
          continue;
        }
        protectNamedChildren({
          children: binding.adapter.namesChildren({
            rootId,
            arguments: call.arguments,
          }),
          rootId,
          spawn: binding.adapter.isSpawnTool(call.name, call.namespace),
        });
      }
    }
    const reusedNames = await refuseReusedTeammateNames({
      binding,
      calls: calls.filter(
        (call) =>
          !handbackIds.has(call.id) && !blockedTranscriptCalls.has(call.id),
      ),
      session,
    });
    // A peer send must name a released dispatch of the sender. Admit the
    // message call first, then bind the peer record to that call id.
    const policy = sharedPolicy(session.organization_id);
    const evaluateOptions = {
      ...this.resolution(binding),
      isUserQuestion: (name: string, namespace?: string) => {
        const tools = binding.request.tools;
        if (tools?.platformToolNames?.has(name)) {
          return namespace === tools.askUser?.namespace;
        }
        if (
          namespace !== undefined &&
          binding.adapter?.classifyToolName(name, namespace) !== "local"
        ) {
          return false;
        }
        return isUserQuestionCall(binding, name);
      },
      isSpawn: (name: string, namespace?: string) =>
        binding.adapter?.isSpawnTool(name, namespace) === true,
      lineage: binding.child?.lineage,
      supportsDelegation: binding.adapter !== undefined && !binding.chat,
      ...(binding.request.tools
        ? {
            control: binding.request.tools.control,
            notice: binding.request.tools.notice,
          }
        : {}),
    };
    const relayCandidates = calls.filter(
      (call) =>
        !handbackIds.has(call.id) &&
        !blockedTranscriptCalls.has(call.id) &&
        !reusedNames.has(call.id) &&
        binding.adapter?.relayMessage?.(call) !== undefined,
    );
    const relayEvaluations = relayCandidates.length
      ? await withCapturedGuardrailsActivation("active", () =>
          evaluateToolCalls(session, relayCandidates, evaluateOptions, policy),
        )
      : [];
    const admittedRelayIds = new Set<string>();
    const withheldRelayDecisions = new Map<
      string,
      (typeof relayEvaluations)[number]
    >();
    for (const [index, call] of relayCandidates.entries()) {
      const decision = relayEvaluations[index];
      if (decision?.kind === "allow") {
        admittedRelayIds.add(call.id);
      } else if (decision) withheldRelayDecisions.set(call.id, decision);
    }
    const relays = await governRelays({
      binding,
      calls: relayCandidates.filter((call) => admittedRelayIds.has(call.id)),
      session,
    });
    const peerInbox = new Map<string, RelayOutcome>();
    for (const call of calls) {
      if (
        handbackIds.has(call.id) ||
        blockedTranscriptCalls.has(call.id) ||
        reusedNames.has(call.id) ||
        relays.has(call.id) ||
        !isPeerInboxCall(binding, call.name)
      ) {
        continue;
      }
      peerInbox.set(call.id, stampPeerInboxCall({ binding, call, session }));
    }
    const rest = calls.filter(
      (call) =>
        !handbackIds.has(call.id) &&
        !blockedTranscriptCalls.has(call.id) &&
        !reusedNames.has(call.id) &&
        !relays.has(call.id) &&
        !peerInbox.has(call.id),
    );
    const decisions = rest.length
      ? await withCapturedGuardrailsActivation("active", () =>
          evaluateToolCalls(session, rest, evaluateOptions, policy),
        )
      : [];
    const decisionById = new Map(
      rest.map((call, index) => [call.id, decisions[index]]),
    );
    for (const id of blockedTranscriptCalls) {
      decisionById.set(id, {
        kind: "deny",
        feedback:
          "OpenAPPA withheld raw child transcript access; use the verified child completion instead",
      });
    }
    for (const [id, feedback] of reusedNames) {
      decisionById.set(id, { kind: "deny", feedback });
    }
    for (const [id, decision] of withheldRelayDecisions) {
      decisionById.set(id, decision);
    }
    for (const [id, relay] of relays) {
      if (relay.kind === "deny") {
        decisionById.set(id, { kind: "deny", feedback: relay.feedback });
      }
    }

    const notice = binding.request.tools?.notice;
    const blocked: { id: string; name: string; reason: string }[] = [];
    const annotated: LlmProxyToolCallAnnotation[] = [];
    const mint = this.delegationMinter(
      binding,
      { ...context, toolCalls: calls },
      session,
    );
    const released: ToolCall[] = [];
    for (const call of calls) {
      if (handbackIds.has(call.id)) {
        const handback = await admitChildHandback({ binding, call });
        blocked.push({
          id: call.id,
          name: call.name,
          reason: "OpenAPPA replaced the child return with admitted bytes",
        });
        released.push(handback.call);
        if (calls.length === 1) {
          binding.completedHandbackReturn = handback.returnText;
          context.resources.set(
            APPA_REPLAY_APPROVED_TEXT,
            handback.approvedText,
          );
        }
        continue;
      }
      const inbox = peerInbox.get(call.id);
      if (inbox?.kind === "release") {
        if (inbox.call !== call) {
          blocked.push({
            id: call.id,
            name: call.name,
            reason:
              "OpenAPPA bound this peer-message call to the authenticated session",
          });
        }
        released.push(inbox.call);
        continue;
      }
      if (inbox?.kind === "deny") {
        decisionById.set(call.id, { kind: "deny", feedback: inbox.feedback });
      }
      const relay = relays.get(call.id);
      if (relay?.kind === "release") {
        if (relay.call !== call) {
          blocked.push({
            id: call.id,
            name: call.name,
            reason:
              "OpenAPPA replaced the message with the text the return check admitted",
          });
        }
        released.push(relay.call);
        continue;
      }
      const decision = decisionById.get(call.id);
      if (!decision) continue;
      if (decision.kind === "control") {
        released.push(call);
        continue;
      }
      if (decision.kind === "allow") {
        // The runtime ruled on the call as the model wrote it; the marker is
        // platform text added after, for the child the call will start.
        const delegated =
          mint && binding.adapter
            ? withDelegationMarker({ call, adapter: binding.adapter, mint })
            : undefined;
        if (
          binding.session.parent_id &&
          binding.adapter &&
          isChildSpawnCall(binding.adapter, call) &&
          !delegated
        ) {
          // An unmarked nested child would fall back to its native parent and
          // lose the governed lineage. Nothing from this evaluated batch may
          // run when that happens.
          await cancelCalls(
            session,
            rest.flatMap((each) =>
              decisionById.get(each.id)?.kind === "allow" ? [each.id] : [],
            ),
            policy,
          );
          throw new ApiError(
            400,
            "OpenAPPA cannot safely start a nested child because its delegation marker could not be attached",
          );
        }
        released.push(delegated?.call ?? call);
        if (delegated) annotated.push(delegated.annotation);
        await rememberYellSession({
          session,
          call,
          resolution: this.resolution(binding),
        });
        continue;
      }
      // The registry pins `blocked` to the wire batch: the entry names the
      // call as given. The identity the runtime ruled on — the dispatch's
      // target — is what the notice and the refusal describe.
      const identity = this.policyIdentity(binding, call);
      if (!notice) {
        // Refuses the call and cancels admitted calls when the client declares no notice tool.
        await cancelCalls(
          session,
          rest.flatMap((each) =>
            decisionById.get(each.id)?.kind === "allow" ? [each.id] : [],
          ),
          policy,
        );
        await recordOpenAppaClientFailure({
          session,
          toolCallId: call.id,
          ruling: decision.feedback,
        });
        const contentMessage =
          binding.request.declaredTools.length === 0
            ? `${decision.feedback}\n\n[appa] This client declared no tools, so the ruling cannot be delivered as a remedy notice and the call is refused. A client whose tools are not on the wire cannot be governed. Declare the tools on the wire; for Codex, set code_mode_host = false.`
            : `${decision.feedback}\n\n[appa] This client did not declare the ${archestraMcpBranding.serverName} MCP gateway remedy tools, so the call is refused. Connect the MCP gateway and allow both remedy tools to use approval plans.`;
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
        name: notice.name,
        // The client runs the notice like any tool it declared, so it must
        // name the namespace the notice tool was declared in.
        ...(notice.namespace ? { namespace: notice.namespace } : {}),
        arguments: JSON.stringify(
          buildNoticeArguments({
            id: call.id,
            tool: identity.name,
            arguments: identity.arguments,
            result: decision.feedback,
            custom: identity.custom,
            namespace: identity.namespace,
            offers: signedOffersForDenial(session, {
              offerIds: decision.offers ?? [],
              tool: identity.name,
              spelling: identity.name,
              ...(identity.dispatch ? { dispatch: identity.dispatch } : {}),
            }),
          }),
        ),
      });
    }

    // Keep turn open while tool calls are awaiting client execution.
    binding.turnOpen = true;
    const stamp = trajectoryStamper(binding, context);
    if (
      blocked.length === 0 &&
      annotated.length === 0 &&
      !stamp &&
      handbackIds.size === 0 &&
      relays.size === 0
    )
      return;
    return {
      decision: "allow",
      toolCalls: stamp ? released.map(stamp) : released,
      ...(blocked.length > 0 ? { blocked } : {}),
      ...(annotated.length > 0 ? { annotated } : {}),
    };
  }

  async onModelResponse(
    context: LlmProxyModelResponseContext,
  ): Promise<undefined> {
    const binding = this.bindings.get(context.resources);
    if (binding?.compaction || isCompactionOnlyResponse(context.response))
      return;
    if (!binding?.request.tools || binding.turnOpen) return;
    if (binding.session.parent_id) {
      return;
    }
    if (!binding.request.turnEndOperationId) return;
    enterCapturedGuardrailsActivation("active");
    await endTurn(
      this.governedSession(binding),
      binding.request.turnEndOperationId,
    );
    return undefined;
  }

  buffersModelResponse(context: LlmProxyRequestContext): boolean {
    const binding = this.bindings.get(context.resources);
    return Boolean(
      binding && (binding.compaction || binding.session.parent_id),
    );
  }

  async onBufferedModelResponse(
    context: LlmProxyBufferedModelResponseContext,
  ): Promise<LlmProxyBufferedModelResponseOutcome | undefined> {
    const binding = this.bindings.get(context.resources);
    if (binding && isCompactionOnlyResponse(context.response)) {
      binding.compaction = true;
    }
    if (binding?.compaction) return { decision: "release" };
    if (binding?.completedHandbackReturn !== undefined && context.streaming) {
      if (nativeHandbackBoundary(binding)) {
        return { decision: "release" };
      }
      return {
        decision: "replace",
        responseText: binding.completedHandbackReturn,
      };
    }
    if (!binding || binding.turnOpen || !binding.session.parent_id) {
      return;
    }
    if (!binding.request.turnEndOperationId) {
      throw new ApiError(503, "OpenAPPA could not safely end the child turn");
    }
    if (nativeHandbackBoundary(binding)) {
      await endTurn(
        this.governedSession(binding),
        binding.request.turnEndOperationId,
      );
      return { decision: "release" };
    }
    enterCapturedGuardrailsActivation("active");
    // Check correlation data and the signing key before ChildEnd.
    // If the runtime admits a value, the value crosses the boundary.
    // Fail before dispatch if the marker cannot be created.
    const childNativeId = binding.child?.lineage?.childNativeId;
    const spawnCallId = await resolveSpawnCallId(binding);
    if (!spawnCallId) throw uncorrelatedChild();
    if (!childReturnMarkersConfigured()) {
      throw new ApiError(503, "OpenAPPA could not protect the child return");
    }

    const outcome = await endChild({
      session: this.governedSession(binding),
      operationId: binding.request.turnEndOperationId.replace(
        /^turn_end:/,
        "child_end:",
      ),
      output: context.responseText,
      spawnCallId,
      ...(childNativeId ? { childNativeId } : {}),
    });
    const admitted =
      outcome.decision === "release" ? context.responseText : outcome.content;
    context.resources.set(APPA_REPLAY_APPROVED_TEXT, admitted);
    if (!outcome.crossed) {
      return { decision: "replace", responseText: admitted };
    }
    // A teammate's end reaches its lead as an idle notice, not as the result
    // of the call that started it, and it may end many turns: it carries no
    // return marker. The lead reads it only because it crossed here.
    if (childNativeId && binding.adapter?.isTeammate?.(childNativeId)) {
      return admitted === context.responseText
        ? { decision: "release" }
        : { decision: "replace", responseText: admitted };
    }
    const marker = mintBoundChildReturnMarker({
      binding,
      spawnCallId,
      value: admitted,
    });
    if (!marker) {
      throw new ApiError(503, "OpenAPPA could not protect the child return");
    }
    return {
      decision: "replace",
      responseText: `${admitted}\n\n${marker}`,
    };
  }

  async onCleanup(context: LlmProxyRequestContext): Promise<void> {
    this.bindings.delete(context.resources);
    this.observers.delete(context.resources);
  }

  // === Internal helpers ===

  /**
   * Returns the governed session for this request.
   * Child sessions retain `parent_id` so SessionStart opens a branch and inherits labels.
   */
  private governedSession(binding: AppaPluginBinding): OpenAppaSession {
    return binding.session;
  }

  /**
   * Records what OpenAPPA must know when enforcement turns on again: a
   * session that starts now, or a governed child that runs now. A request of
   * a governed session gets an observer, which records the calls the model
   * makes. A record that fails never fails the request, because enforcement
   * is off. OpenAPPA then withholds what it has no record of.
   */
  private async observe(
    context: LlmProxyRequestContext,
    trustedContext: AppaTrustedContext,
  ): Promise<void> {
    try {
      const { session, adapter, child } = appaTrajectory({
        adapters: this.clientAdapters,
        headers: context.headers,
        requestBody: context.requestBody,
        trustedContext,
      });
      const started = await observeUnenforcedSession(session);
      // A child runs now, so what it returns or sends to its parent was not
      // checked: the parent's records name the spawn that started it.
      const spawnCallId =
        child && session.parent_id
          ? await resolveSpawnCallId({ session, child })
          : undefined;
      if (spawnCallId && session.parent_id) {
        await recordUnenforcedCalls({
          organizationId: session.organization_id,
          sessionId: session.parent_id,
          toolCallIds: [spawnCallId],
          reason: "child",
          childNativeId: child?.lineage?.childNativeId,
        });
      }
      if (started !== "governed") return;
      this.observers.set(context.resources, {
        session,
        adapter,
        requestBody: context.requestBody,
      });
    } catch (error) {
      logger.warn(
        { err: error },
        "OpenAPPA could not record a request made while enforcement was off",
      );
    }
  }

  /**
   * Mints delegation markers for allowed spawn calls in this batch.
   * Returns undefined if markers cannot travel safely.
   * Safety checks include:
   * - Wire family history cannot be stripped
   * - Transport cannot re-emit calls
   * - Client names no conversation for its children to report
   * - A call in the batch cannot be parsed
   */
  private delegationMinter(
    binding: AppaPluginBinding,
    context: LlmProxyToolCallsContext,
    session: OpenAppaSession,
  ): ((prompt: string, callId: string) => string | undefined) | undefined {
    const spawnerNativeId = binding.spawnerNativeId;
    if (
      !binding.request.delegation ||
      context.canRewriteToolCalls !== true ||
      !spawnerNativeId ||
      !delegationEnabled()
    )
      return undefined;
    const readable = context.toolCalls.every(
      (call) =>
        binding.request.customTools.has(call.name) ||
        argumentRecordOf(call.arguments) !== undefined,
    );
    if (!readable) return undefined;
    // The spawner's current trajectory, as the client knows it: the caller
    // scope never reaches a client transcript.
    const parentId = withoutCallerScope(session, session.session_id);
    return (prompt, callId) =>
      mintDelegationMarker({
        organizationId: session.organization_id,
        callerId: session.caller_id,
        parentId,
        spawnerNativeId,
        prompt,
        spawnCallId: callId,
      });
  }

  /**
   * Converts an ask_user call to the client's native question tool when the
   * client declares that tool. Preserves the original tool call ID. Leaves the
   * call unchanged when the request has no native question declaration, so the
   * gateway can use MCP elicitation or fail closed without a deadlock.
   */
  private asNativeQuestion(
    binding: AppaPluginBinding,
    call: LlmProxyToolCallsContext["toolCalls"][number],
  ): LlmProxyToolCallsContext["toolCalls"][number] {
    const native = binding.adapter?.nativeQuestion;
    const askUser = binding.request.tools?.askUser;
    if (
      !native?.fromAskUser ||
      call.name !== askUser?.name ||
      call.namespace !== askUser.namespace ||
      native.isAvailable?.(binding.requestHeaders) === false ||
      !declaresNativeQuestion(binding, native.toolName) ||
      archestraMcpBranding.getToolShortName(
        this.canonicalize(binding, call),
      ) !== TOOL_ASK_USER_SHORT_NAME
    ) {
      return call;
    }
    const args = parseAskUserArguments(call.arguments);
    if (!args) return call;
    if (args.allowMultiple && native.supportsMultiple === false) return call;
    return {
      id: call.id,
      name: native.toolName,
      // An explicit empty namespace tells Responses rewrites not to inherit
      // the gateway namespace from the ask_user call this local tool replaces.
      namespace: "",
      arguments: JSON.stringify(native.fromAskUser(args)),
    };
  }

  /**
   * A call's canonical name, from its own name and the namespace it names. A
   * client's own tool is named the way the adapter records local tools; a
   * declaration the gateway attested is the gateway's, never the client's,
   * whatever the adapter's name heuristic says.
   */
  private canonicalize(
    binding: AppaPluginBinding,
    call: { name: string; namespace?: string },
  ): string {
    if (
      !binding.identity.attestationOf(call.name, call.namespace) &&
      binding.adapter?.classifyToolName(call.name, call.namespace) === "local"
    ) {
      return binding.identity.canonicalize(
        binding.adapter.normalizeLocalToolName(call.name),
      );
    }
    return binding.identity.canonicalize(call.name, call.namespace);
  }

  /** The name resolution this binding's calls are ruled under. */
  private resolution(binding: AppaPluginBinding): ToolNameResolution {
    return {
      canonicalize: (name: string, namespace?: string) =>
        this.canonicalize(binding, { name, namespace }),
      looseRunToolDispatch: binding.identity.looseRunToolDispatch,
    };
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
          name: call.name,
          arguments: call.arguments,
          namespace: call.namespace,
        },
      ],
      this.resolution(binding),
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
      namespace: call.namespace,
    };
  }
}

async function approveChildReturnCarriers(params: {
  binding: AppaPluginBinding;
  results: LlmProxyToolResultsContext["toolResults"];
}): Promise<{
  updates: Record<string, string>;
  /** Results of children that ran while enforcement was off, with no crossing. */
  ignored: Set<string>;
}> {
  const completions = params.binding.request.childReturns?.completions ?? [];
  const adapter = params.binding.adapter;
  const completionResults = params.results.filter(
    (result) =>
      params.binding.request.restoredNoticeCallIds?.has(result.id) !== true &&
      adapter?.isChildCompletionResult?.(result) === true,
  );
  const ignored = new Set<string>();
  if (completions.length === 0 && completionResults.length === 0) {
    return { updates: {}, ignored };
  }
  // Display markers carry no authority. Assistant quotes are stripped from
  // the request but never treated as parent-bound completions.
  // The durable authority: the child returns this family crossed, retained by
  // the runtime at ChildEnd. Nothing the client carries proves a return.
  const available = (
    await withCapturedGuardrailsActivation("active", () =>
      loadChildReturns({
        organizationId: params.binding.session.organization_id,
        parentSessionId: params.binding.session.session_id,
      }),
    )
  ).map((record) => ({
    ...record,
    ...(record.spawnCallId
      ? { spawnCallId: withoutTrajectoryStamp(record.spawnCallId) }
      : {}),
  }));
  // A child that ran while enforcement was off returned what the runtime did
  // not see. OpenAPPA ignores such a return only when the runtime has no
  // crossing at all for that spawn or child: any return of a child that
  // crossed is still checked against what crossed.
  const { reasons, children } = params.binding.unenforcedCalls;
  const crossedSpawns = new Set(available.map((record) => record.spawnCallId));
  const crossedChildren = new Set(
    available.map((record) => record.childNativeId),
  );
  const unenforcedReturn = (ids: {
    spawnCallId?: string;
    childNativeId?: string;
    envelopeId?: string;
  }) =>
    !(ids.spawnCallId !== undefined && crossedSpawns.has(ids.spawnCallId)) &&
    !(
      ids.childNativeId !== undefined && crossedChildren.has(ids.childNativeId)
    ) &&
    ((ids.spawnCallId !== undefined && reasons.has(ids.spawnCallId)) ||
      (ids.childNativeId !== undefined && children.has(ids.childNativeId)) ||
      (ids.envelopeId !== undefined && reasons.get(ids.envelopeId) === "made"));
  // The returns OpenAPPA ignores, by the result that carries them.
  const ignoredByEnvelope = new Map<string, AppaChildReturnCompletion[]>();
  // A fork carries its source's subagent results, but the runtime retained
  // them under the source session, so the lookup above finds none of them.
  const unrecorded = params.binding.session.fork_of
    ? { reason: FORKED_CHILD_RETURN, recovery: FORKED_CHILD_RETURN_RECOVERY }
    : { reason: UNRECORDED_CHILD_RETURN };
  const directSpawnResults = new Set(
    params.results
      .filter((result) => adapter?.isSpawnTool(result.name, result.namespace))
      .map((result) => withoutTrajectoryStamp(result.id)),
  );
  // One wait result can contain several children. Every completed leaf
  // consumes its own crossing. One genuine return cannot authorize siblings.
  const matched: Array<{
    completion: AppaChildReturnCompletion;
    record: AppaChildReturnRecord;
  }> = [];
  for (const completion of completions) {
    // Display-only echoes never consume a child's crossing.
    if (completion.assistantOrigin) continue;
    const expectedSpawn = completion.spawnCallId
      ? withoutTrajectoryStamp(completion.spawnCallId)
      : completion.envelopeId &&
          directSpawnResults.has(withoutTrajectoryStamp(completion.envelopeId))
        ? withoutTrajectoryStamp(completion.envelopeId)
        : undefined;
    const candidates = available.flatMap((record, index) =>
      record.value === completion.value ? [{ record, index }] : [],
    );
    const envelopeId = completion.envelopeId
      ? withoutTrajectoryStamp(completion.envelopeId)
      : undefined;
    if (
      candidates.length === 0 &&
      unenforcedReturn({
        spawnCallId: expectedSpawn,
        childNativeId: completion.childNativeId,
        envelopeId,
      })
    ) {
      if (envelopeId) {
        ignoredByEnvelope.set(envelopeId, [
          ...(ignoredByEnvelope.get(envelopeId) ?? []),
          completion,
        ]);
      }
      continue;
    }
    const conflictingNativeId =
      expectedSpawn !== undefined &&
      completion.childNativeId !== undefined &&
      available.some(
        (record) =>
          (record.spawnCallId === expectedSpawn &&
            record.childNativeId !== undefined &&
            record.childNativeId !== completion.childNativeId) ||
          (record.childNativeId === completion.childNativeId &&
            record.spawnCallId !== undefined &&
            record.spawnCallId !== expectedSpawn),
      );
    const exact = candidates.filter(
      ({ record }) =>
        (expectedSpawn === undefined || record.spawnCallId === expectedSpawn) &&
        (completion.childNativeId === undefined ||
          record.childNativeId === completion.childNativeId ||
          // Some native clients reveal their local task id only to the parent.
          // The retained spawn binding and exact bytes still identify the child.
          (record.childNativeId === undefined &&
            expectedSpawn !== undefined &&
            record.spawnCallId === expectedSpawn &&
            !conflictingNativeId)),
    );
    const eligible = exact.length
      ? exact
      : candidates.filter(
          ({ record }) =>
            (expectedSpawn === undefined || record.spawnCallId === undefined) &&
            (completion.childNativeId === undefined ||
              record.childNativeId === undefined),
        );
    const first = eligible[0]?.record;
    if (
      !first &&
      expectedSpawn !== undefined &&
      candidates.some(
        ({ record }) =>
          record.spawnCallId !== undefined &&
          record.spawnCallId !== expectedSpawn,
      )
    ) {
      throw childReturnRefusal({
        status: 400,
        reason: SUBSTITUTED_CHILD_RETURN,
        callId: expectedSpawn,
        childNativeId: completion.childNativeId,
      });
    }
    if (
      !first ||
      eligible.some(
        ({ record }) =>
          record.childSessionId !== first.childSessionId ||
          record.spawnCallId !== first.spawnCallId ||
          record.childNativeId !== first.childNativeId,
      )
    ) {
      const callId = completion.envelopeId ?? completion.spawnCallId;
      throw childReturnRefusal({
        ...(first ? { reason: AMBIGUOUS_CHILD_RETURN } : unrecorded),
        callId: callId && withoutTrajectoryStamp(callId),
        childNativeId: completion.childNativeId,
      });
    }
    const hit = eligible[0].index;
    const [record] = available.splice(hit, 1);
    matched.push({ completion, record });
  }
  const arrived: Array<AppaChildReturnRecord & { spawnCallId: string }> = [];
  const byEnvelope = new Map<string, AppaChildReturnRecord[]>();
  for (const { completion, record } of matched) {
    const spawnCallId =
      record.spawnCallId ??
      (completion.spawnCallId
        ? withoutTrajectoryStamp(completion.spawnCallId)
        : undefined) ??
      (completion.envelopeId &&
      directSpawnResults.has(withoutTrajectoryStamp(completion.envelopeId))
        ? withoutTrajectoryStamp(completion.envelopeId)
        : undefined);
    if (!spawnCallId) {
      throw childReturnRefusal({
        reason: UNBOUND_CHILD_RETURN,
        callId:
          completion.envelopeId &&
          withoutTrajectoryStamp(completion.envelopeId),
        childNativeId: completion.childNativeId ?? record.childNativeId,
      });
    }
    if (completion.envelopeId) {
      const envelopeId = withoutTrajectoryStamp(completion.envelopeId);
      if (directSpawnResults.has(envelopeId) && envelopeId !== spawnCallId) {
        throw childReturnRefusal({
          status: 400,
          reason: SUBSTITUTED_CHILD_RETURN,
          callId: envelopeId,
          childNativeId: completion.childNativeId ?? record.childNativeId,
        });
      }
      const envelope = byEnvelope.get(envelopeId) ?? [];
      envelope.push(record);
      byEnvelope.set(envelopeId, envelope);
    }
    arrived.push({
      ...record,
      spawnCallId,
    });
  }
  const unrecordedResult = completionResults.find(
    (result) =>
      (byEnvelope.get(withoutTrajectoryStamp(result.id)) ?? []).length === 0 &&
      !ignoredByEnvelope.has(withoutTrajectoryStamp(result.id)) &&
      !unenforcedReturn({ spawnCallId: withoutTrajectoryStamp(result.id) }),
  );
  if (unrecordedResult) {
    throw childReturnRefusal({
      ...unrecorded,
      callId: withoutTrajectoryStamp(unrecordedResult.id),
    });
  }
  // Records every verified crossing with the runtime. The runtime re-checks
  // each value against the return its fork bound, so a client-named spawn
  // call cannot stand for a child it never opened. One at a time: the runtime
  // runs one session's dispatches in order anyway, each first leases a pooled
  // connection to find its session, and a failed approval must stop the rest.
  for (const record of arrived) {
    await approveSpawnReturn({
      session: params.binding.session,
      toolCallId: record.spawnCallId,
      childId: record.childSessionId,
      value: record.value,
    });
  }
  // Strips unverified text and metadata beside valid returns.
  // Reconstructs result content solely from crossed values.
  const updates: Record<string, string> = Object.create(null);
  for (const result of completionResults) {
    const envelopeId = withoutTrajectoryStamp(result.id);
    const verified = byEnvelope.get(envelopeId) ?? [];
    const ignoredHere = ignoredByEnvelope.get(envelopeId) ?? [];
    if (
      verified.length === 0 &&
      (ignoredHere.length > 0 || unenforcedReturn({ spawnCallId: envelopeId }))
    ) {
      ignored.add(result.id);
      continue;
    }
    if (verified.length === 0) {
      throw childReturnRefusal({ ...unrecorded, callId: envelopeId });
    }
    // A return OpenAPPA ignores stays beside the crossed ones, as it came.
    updates[result.id] =
      verified.length === 1 &&
      ignoredHere.length === 0 &&
      adapter?.isSpawnTool(result.name, result.namespace)
        ? verified[0].value
        : JSON.stringify({
            status: Object.fromEntries([
              ...matched
                .filter(({ record }) => verified.includes(record))
                .map(({ completion, record }) => [
                  completion.childNativeId ?? record.childNativeId,
                  { completed: record.value },
                ]),
              ...ignoredHere.flatMap((completion) =>
                completion.childNativeId
                  ? [
                      [
                        completion.childNativeId,
                        { completed: completion.value },
                      ],
                    ]
                  : [],
              ),
            ]),
          });
  }
  return { updates, ignored };
}

/**
 * Refuses a child return carried in the conversation history. The client
 * re-sends that history with every later request, so a retry fails the same
 * way: the SDK is told not to retry, and the user is told how to continue.
 */
function childReturnRefusal(params: {
  reason: string;
  recovery?: string;
  callId: string | undefined;
  childNativeId?: string;
  status?: 400 | 409;
}): ApiError {
  // Rewind pickers list the user's own messages, never tool call ids, so the
  // ids are a reference for support and logs, not the rewind target.
  const references = [
    params.callId ? `tool call ${params.callId}` : undefined,
    params.childNativeId ? `subagent ${params.childNativeId}` : undefined,
  ].filter((reference) => reference !== undefined);
  const error = new ApiError(
    params.status ?? 409,
    [
      "OpenAPPA blocked this request.",
      params.reason,
      "Each request that contains this result fails the same way.",
      params.recovery ?? CHILD_RETURN_RECOVERY,
      ...(references.length > 0
        ? [`Reference: ${references.join(", ")}.`]
        : []),
    ].join(" "),
  );
  error.shouldRetry = false;
  return error;
}

const CHILD_RETURN_RECOVERY =
  "To continue, start a new session, or rewind the conversation to a message you sent before this subagent started.";
const FORKED_CHILD_RETURN_RECOVERY =
  "To keep this context, resume the original session. Otherwise, start a new session, or rewind the conversation to a message you sent before this subagent started.";
const UNRECORDED_CHILD_RETURN =
  "The conversation contains a subagent result that OpenAPPA has no record of. This can happen when the subagent ran while Guardrails enforcement was off, or when the result changed after the subagent finished.";
const FORKED_CHILD_RETURN =
  "The conversation contains a subagent result that OpenAPPA has no record of in this session. This conversation continues another session, and OpenAPPA checks a subagent result only in the session that ran the subagent.";
const AMBIGUOUS_CHILD_RETURN =
  "The conversation contains a subagent result that matches several subagents, so OpenAPPA cannot tell which subagent returned it.";
const UNBOUND_CHILD_RETURN =
  "The conversation contains a subagent result that OpenAPPA cannot link to the call that started the subagent.";
const SUBSTITUTED_CHILD_RETURN =
  "The conversation contains a subagent result that matches the result of a different subagent call.";

/**
 * Admits the messages other agents delivered into this request. A new send
 * carries a peer-message id and is admitted only by that id. Older checked
 * child returns and addresses still replay. A message from another session,
 * an altered trailer, or an unknown sender is withheld.
 *
 * A child's opening prompt can arrive as a message too: Claude Code hands a
 * teammate its prompt as a message from its lead. That prompt crossed with
 * the spawn, which opened the child at its parent's label; the delegation
 * marker it carried binds its exact text.
 *
 * A message that came while enforcement was off has no record of crossing.
 * OpenAPPA ignores it, and keeps it as it is, when its sender, or this child,
 * ran while enforcement was off and has no crossing on record.
 */
async function admitRelayArrivals(params: {
  binding: AppaPluginBinding;
  session: OpenAppaSession;
  request: unknown;
}): Promise<void> {
  const arrivals = params.binding.adapter?.relayArrivals?.(params.request);
  if (!arrivals?.length) return;
  const { session } = params;
  const openingPrompt = params.binding.child?.lineage?.spawnPromptDigest;
  let crossed: Promise<AppaChildReturnRecord[]> | undefined;
  let addressed: Promise<string[]> | undefined;
  const crossings = () => {
    crossed ??= loadChildReturns({
      organizationId: session.organization_id,
      parentSessionId: session.session_id,
    });
    return crossed;
  };
  const addresses = () => {
    addressed ??= session.parent_id
      ? loadChildAddresses({
          organizationId: session.organization_id,
          childSessionId: session.session_id,
        }).then((records) => records.map((record) => record.value))
      : Promise.resolve([]);
    return addressed;
  };
  const tools = advertisedPeerTools(params.binding);
  const launches = params.binding.adapter?.teammateLaunches?.(
    params.binding.requestBody,
  );
  let ranUnenforced: Promise<boolean> | undefined;
  // A message from a sender with a crossing may summarize a withheld return.
  // Only a sender with nothing on record passes while enforcement was off.
  const sentUnenforced = async (arrival: AppaRelayArrival) => {
    if (arrival.kind === "session" || arrival.peer !== undefined) return false;
    const launch =
      arrival.kind === "teammate" || arrival.kind === "agent"
        ? launches?.get(arrival.from)
        : undefined;
    if (
      launch &&
      params.binding.unenforcedCalls.reasons.has(
        withoutTrajectoryStamp(launch.spawnCallId),
      )
    ) {
      return !(await crossings()).some(
        (record) => record.childNativeId === launch.childNativeId,
      );
    }
    if (arrival.kind === "agent") return false;
    ranUnenforced ??= spawnRanUnenforced(params.binding);
    return (await ranUnenforced) && (await addresses()).length === 0;
  };
  for (const arrival of arrivals) {
    if (
      openingPrompt &&
      arrival.kind !== "session" &&
      arrival.peer === undefined &&
      isDelegatedPrompt(arrival.body, openingPrompt)
    ) {
      continue;
    }
    if (arrival.kind === "session" || arrival.peer === "malformed") {
      arrival.replace(WITHHELD_RELAY);
      continue;
    }
    if (await sentUnenforced(arrival)) continue;
    if (arrival.peer) {
      await admitPeerArrival({
        binding: params.binding,
        session,
        arrival,
        tools,
      });
      continue;
    }
    if (arrival.structured) {
      await admitStructuredRelay({
        binding: params.binding,
        session,
        arrival,
        tools,
        crossings,
        addresses,
      });
      continue;
    }
    const records = await historicRelayRecords({
      binding: params.binding,
      session,
      arrival,
      crossings,
      addresses,
    });
    const { withheld } = arrival.admit(records);
    if (withheld) {
      logger.info(
        { sessionId: session.session_id, kind: arrival.kind },
        "OpenAPPA withheld a message with no record of crossing from its sender",
      );
    }
  }
}

/**
 * Records the calls a governed session makes while enforcement is off. A
 * message to a teammate reaches it while enforcement is off, so the spawn that
 * launched the teammate is recorded too.
 */
async function recordObservedCalls(
  observer: AppaPluginObserver,
  calls: readonly ToolCall[],
): Promise<void> {
  const { session } = observer;
  try {
    const launches = observer.adapter?.teammateLaunches?.(observer.requestBody);
    const messaged = calls.flatMap((call) => {
      const to = observer.adapter?.relayMessage?.(call)?.to;
      const launch =
        to?.kind === "teammate" ? launches?.get(to.name) : undefined;
      return launch ? [launch] : [];
    });
    // The records are independent, so they are written together.
    await Promise.all([
      recordUnenforcedCalls({
        organizationId: session.organization_id,
        sessionId: session.session_id,
        toolCallIds: calls.map((call) => call.id),
        reason: "made",
      }),
      ...messaged.map((launch) =>
        recordUnenforcedCalls({
          organizationId: session.organization_id,
          sessionId: session.session_id,
          toolCallIds: [launch.spawnCallId],
          reason: "child",
          childNativeId: launch.childNativeId,
        }),
      ),
    ]);
  } catch (error) {
    logger.warn(
      { err: error },
      "OpenAPPA could not record tool calls made while enforcement was off",
    );
  }
}

/**
 * Whether this child ran, or got a message, while enforcement was off: its
 * parent's records name the spawn that started it.
 */
async function spawnRanUnenforced(
  binding: AppaPluginBinding,
): Promise<boolean> {
  const parentId = binding.session.parent_id;
  if (!binding.child || !parentId) return false;
  const spawnCallId = await resolveSpawnCallId(binding);
  if (!spawnCallId) return false;
  const found = await findUnenforcedCalls({
    session: { ...binding.session, session_id: parentId },
    toolCallIds: [spawnCallId],
  });
  return found.reasons.size > 0;
}

/** Whether a teammate envelope's sender is the child `id`: `<name>` or `<name>@<team>`. */
function namesTeammate(name: string, id: string): boolean {
  if (id === name) return true;
  return id.startsWith(`${name}@`) && !id.slice(name.length + 1).includes("@");
}

/**
 * A message call returns the client's receipt, or the report of an agent the
 * message resumed. That report is a child's return like any other, so it
 * reaches the model only when it crossed into this session.
 */
async function admitRelayReports(params: {
  binding: AppaPluginBinding;
  session: OpenAppaSession;
  results: LlmProxyToolResultsContext["toolResults"];
  updates: Record<string, string>;
}): Promise<void> {
  const adapter = params.binding.adapter;
  if (!adapter?.admitRelayReport) return;
  const reports = params.results.filter(
    (result) =>
      adapter.isRelayTool?.(result.name) &&
      !result.isError &&
      !adapter.isRelayReceipt?.(result.content),
  );
  if (reports.length === 0) return;
  const records = (
    await loadChildReturns({
      organizationId: params.session.organization_id,
      parentSessionId: params.session.session_id,
    })
  ).map((record) => record.value);
  for (const result of reports) {
    const admitted = adapter.admitRelayReport(result.content, records);
    if (admitted.withheld && typeof admitted.content === "string") {
      params.updates[result.id] = admitted.content;
    }
  }
}

/**
 * Refuses a spawn that names a teammate this session already launched or
 * started. The child session takes its id from the teammate's name, so a
 * second spawn's prepared fork would never open: the new teammate would run
 * on the first one's trajectory, at its older label.
 */
async function refuseReusedTeammateNames(params: {
  binding: AppaPluginBinding;
  calls: readonly ToolCall[];
  session: OpenAppaSession;
}): Promise<Map<string, string>> {
  const { binding, session } = params;
  const refused = new Map<string, string>();
  const adapter = binding.adapter;
  if (!adapter?.teammateName) return refused;
  const named = params.calls.flatMap((call) => {
    const name = adapter.teammateName?.(call);
    return name ? [{ call, name }] : [];
  });
  if (named.length === 0) return refused;
  const started = await OpenAppaSessionModel.childNativeIds({
    organizationId: session.organization_id,
    parentSessionId: session.session_id,
  });
  const launched = adapter.teammateLaunches?.(binding.requestBody);
  const spawned = new Set<string>();
  for (const { call, name } of named) {
    if (
      spawned.has(name) ||
      launched?.has(name) ||
      started.some((id) => id === name || id.startsWith(`${name}@`))
    ) {
      refused.set(
        call.id,
        `This session already started a teammate named "${name}". OpenAPPA checks each teammate from its own spawn, so it did not start a second one under that name. Start the teammate under a new name.`,
      );
    }
    spawned.add(name);
  }
  return refused;
}

/** How the runtime ruled on one message between agents. */
type RelayOutcome =
  | { kind: "release"; call: ToolCall }
  | { kind: "deny"; feedback: string };

type PeerNotice = {
  messageId: string;
  expiresAt: string;
};

/**
 * Governs a batch's messages between agents before any other call opens.
 * A new send is a peer message. It does not end the sender and it does not
 * start the recipient. The runtime mints the message id; free text carries
 * that id in a trailer. Structured protocol stays byte-stable.
 */
async function governRelays(params: {
  binding: AppaPluginBinding;
  calls: readonly ToolCall[];
  session: OpenAppaSession;
}): Promise<Map<string, RelayOutcome>> {
  const { binding, session } = params;
  const outcomes = new Map<string, RelayOutcome>();
  const adapter = binding.adapter;
  if (!adapter?.relayMessage) return outcomes;
  for (const call of params.calls) {
    const relay = adapter.relayMessage(call);
    if (!relay || relay.to.kind === "session") continue;
    if (relay.to.kind === "broadcast") {
      outcomes.set(call.id, { kind: "deny", feedback: RELAY_BROADCAST });
      continue;
    }
    if (relay.value.length === 0) {
      outcomes.set(call.id, {
        kind: "deny",
        feedback: RELAY_UNKNOWN_RECIPIENT,
      });
      continue;
    }
    const target = await resolveRelayTarget({
      binding,
      session,
      relay,
    });
    if (target.kind === "deny") {
      outcomes.set(call.id, target);
      continue;
    }
    const sent = await sendPeerMessage({
      session,
      operationId: `peer_send:${call.id}`,
      recipientSessionId: target.recipientSessionId,
      ...(target.recipientParentId
        ? { recipientParentId: target.recipientParentId }
        : {}),
      ...(target.recipientNativeId
        ? { recipientNativeId: target.recipientNativeId }
        : {}),
      ...(target.recipientSpawnCallId
        ? { recipientSpawnCallId: target.recipientSpawnCallId }
        : {}),
      value: relay.value,
    });
    if (sent.kind === "denied") {
      await cancelCalls(session, [call.id]);
      outcomes.set(call.id, { kind: "deny", feedback: sent.feedback });
      continue;
    }
    if (relay.structured) {
      outcomes.set(call.id, { kind: "release", call });
      continue;
    }
    if (!adapter.rewriteRelayMessage) {
      outcomes.set(call.id, { kind: "deny", feedback: RELAY_UNGOVERNED });
      continue;
    }
    outcomes.set(call.id, {
      kind: "release",
      call: {
        ...call,
        arguments: adapter.rewriteRelayMessage(
          call.arguments,
          appendPeerMessageMarker(relay.value, sent.messageId),
        ),
      },
    });
  }
  return outcomes;
}

type RelayTarget = {
  recipientSessionId: string;
  recipientParentId?: string;
  recipientNativeId?: string;
  recipientSpawnCallId?: string;
};

async function resolveRelayTarget(params: {
  binding: AppaPluginBinding;
  session: OpenAppaSession;
  relay: AppaRelayMessage;
}): Promise<
  ({ kind: "target" } & RelayTarget) | { kind: "deny"; feedback: string }
> {
  const { binding, session, relay } = params;
  if (relay.to.kind === "lead") {
    if (!session.parent_id || !binding.child) {
      return { kind: "deny", feedback: RELAY_UNGOVERNED };
    }
    const parent = await persistedSession(session, session.parent_id);
    if (!parent) return { kind: "deny", feedback: RELAY_UNGOVERNED };
    return {
      kind: "target",
      recipientSessionId: parent.session_id,
      ...(parent.parent_id ? { recipientParentId: parent.parent_id } : {}),
    };
  }
  if (relay.to.kind !== "teammate") {
    return { kind: "deny", feedback: RELAY_UNKNOWN_RECIPIENT };
  }
  const own = await resolveNamedChild({
    binding,
    parent: session,
    name: relay.to.name,
    useRequestLaunches: true,
  });
  if (own === "ambiguous") {
    return { kind: "deny", feedback: RELAY_AMBIGUOUS_RECIPIENT };
  }
  if (own?.unchecked) return { kind: "deny", feedback: RELAY_UNCHECKED };
  if (own) return childTarget(session, own);
  if (!session.parent_id) {
    return { kind: "deny", feedback: RELAY_UNKNOWN_RECIPIENT };
  }
  const parent = await persistedSession(session, session.parent_id);
  if (!parent) return { kind: "deny", feedback: RELAY_UNKNOWN_RECIPIENT };
  const sibling = await resolveNamedChild({
    binding,
    parent,
    name: relay.to.name,
    useRequestLaunches: false,
  });
  if (sibling === "ambiguous") {
    return { kind: "deny", feedback: RELAY_AMBIGUOUS_RECIPIENT };
  }
  if (!sibling || sibling.unchecked) {
    return {
      kind: "deny",
      feedback: sibling?.unchecked ? RELAY_UNCHECKED : RELAY_UNKNOWN_RECIPIENT,
    };
  }
  return childTarget(parent, sibling);
}

function childTarget(
  parent: OpenAppaSession,
  child: { childNativeId: string; spawnCallId?: string; started: boolean },
): { kind: "target" } & RelayTarget {
  return {
    kind: "target",
    recipientSessionId: `${parent.session_id}:${child.childNativeId}`,
    recipientParentId: parent.session_id,
    recipientNativeId: child.childNativeId,
    ...(!child.started && child.spawnCallId
      ? { recipientSpawnCallId: child.spawnCallId }
      : {}),
  };
}

/**
 * The child a name identifies under `parent`: a started child, a launch
 * receipt still in this request, or a persisted allowed spawn. A name that
 * fits more than one child fits none. A teammate that started while
 * enforcement was off is unchecked, so no message reaches it.
 */
async function resolveNamedChild(params: {
  binding: AppaPluginBinding;
  parent: OpenAppaSession;
  name: string;
  useRequestLaunches: boolean;
}): Promise<
  | {
      childNativeId: string;
      spawnCallId?: string;
      started: boolean;
      unchecked?: true;
    }
  | "ambiguous"
  | undefined
> {
  const started = await OpenAppaSessionModel.childNativeIds({
    organizationId: params.parent.organization_id,
    parentSessionId: params.parent.session_id,
  });
  const startedMatch = uniqueNamed(params.name, started);
  if (startedMatch === "ambiguous") return "ambiguous";
  if (startedMatch) {
    return { childNativeId: startedMatch, started: true };
  }
  const aliases = await OpenAppaSpawnCorrelationModel.allowedSpawnAliases({
    organizationId: params.parent.organization_id,
    callerId: params.parent.caller_id,
    parentSessionId: params.parent.session_id,
  });
  const durable = uniqueAlias(params.name, aliases, params.binding.adapter);
  if (durable === "ambiguous") return "ambiguous";
  const launch = params.useRequestLaunches
    ? params.binding.adapter
        ?.teammateLaunches?.(params.binding.requestBody)
        .get(params.name)
    : undefined;
  const childNativeId = durable?.childNativeId ?? launch?.childNativeId;
  const spawnCallId = durable?.spawnCallId ?? launch?.spawnCallId;
  if (!childNativeId) return undefined;
  if (!spawnCallId) return { childNativeId, started: false };
  if (durable) return { childNativeId, spawnCallId, started: false };
  const allowed = await OpenAppaSpawnCorrelationModel.allowedSpawn({
    organizationId: params.parent.organization_id,
    callerId: params.parent.caller_id,
    parentSessionId: params.parent.session_id,
    spawnCallId,
  });
  const off =
    allowed &&
    (await startedUnenforced({
      ...params.parent,
      session_id: childSessionId(params.parent.session_id, childNativeId),
      parent_id: params.parent.session_id,
    }));
  return allowed && !off
    ? { childNativeId, spawnCallId, started: false }
    : { childNativeId, spawnCallId, started: false, unchecked: true };
}

const RELAY_BROADCAST =
  "OpenAPPA checks each message against the agent that receives it. Send the message to each teammate by name.";
const RELAY_UNKNOWN_RECIPIENT =
  "OpenAPPA cannot identify the agent this message is for, so it did not send the message. Send it to a teammate by the name the teammate started with.";
const RELAY_AMBIGUOUS_RECIPIENT =
  "More than one teammate in this session has that name, so OpenAPPA cannot tell which one this message is for. The message was not sent.";
const RELAY_UNCHECKED =
  "This teammate started while Guardrails enforcement was off, so OpenAPPA does not check it. OpenAPPA does not send messages to an agent that it does not check, so it did not send this message. To continue its work, start a new teammate under a new name with the Agent tool and give it the task. OpenAPPA checks that spawn.";
const RELAY_UNGOVERNED =
  "OpenAPPA cannot tell which spawn started this agent, so it cannot check this message. The message was not sent.";
const WITHHELD_RELAY =
  "[appa] Message withheld: this message has no record of crossing from its sender into this session, so its text is hidden.";
const WITHHELD_PEER_READ =
  "[appa] Message withheld: this peer-message result has no record of a runtime read, so its text is hidden.";
const PARENT_ENVELOPE_NAMES = new Set(["team-lead", "main"]);

async function persistedSession(
  sender: OpenAppaSession,
  sessionId: string,
): Promise<OpenAppaSession | undefined> {
  const row = await OpenAppaSessionModel.familySession({
    organizationId: sender.organization_id,
    sessionId,
    callerId: sender.caller_id,
  });
  if (!row) return undefined;
  return {
    organization_id: sender.organization_id,
    session_id: row.sessionId,
    ...(row.callerId ? { caller_id: row.callerId } : {}),
    ...(row.parentId ? { parent_id: row.parentId } : {}),
  };
}

function uniqueNamed(
  name: string,
  ids: readonly string[],
): string | "ambiguous" | undefined {
  if (ids.includes(name)) return name;
  const named = ids.filter((id) => namesTeammate(name, id));
  if (named.length > 1) return "ambiguous";
  return named[0];
}

function uniqueAlias(
  name: string,
  aliases: readonly AllowedSpawnAlias[],
  adapter: AppaClientAdapter | undefined,
): { childNativeId: string; spawnCallId: string } | "ambiguous" | undefined {
  const matches = aliases.flatMap((alias) => {
    const launch = alias.launchText
      ? adapter?.launchIdentity?.(alias.launchText)
      : undefined;
    const named =
      alias.name === name ||
      alias.description === name ||
      launch?.name === name ||
      (launch !== undefined && namesTeammate(name, launch.childNativeId));
    const childNativeId = launch?.childNativeId;
    if (!named || !childNativeId) return [];
    return [{ childNativeId, spawnCallId: alias.spawnCallId }];
  });
  const ids = new Set(matches.map((match) => match.childNativeId));
  if (ids.size > 1) return "ambiguous";
  return matches[0];
}

async function admitPeerArrival(params: {
  binding: AppaPluginBinding;
  session: OpenAppaSession;
  arrival: AppaRelayArrival;
  tools: { list?: string; read?: string };
}): Promise<void> {
  const trailer = params.arrival.peer;
  if (!trailer || trailer === "malformed") {
    params.arrival.replace(WITHHELD_RELAY);
    return;
  }
  const senderSessionId = await resolveArrivalSender({
    binding: params.binding,
    session: params.session,
    arrival: params.arrival,
  });
  if (!senderSessionId) {
    params.arrival.replace(WITHHELD_RELAY);
    return;
  }
  // Name resolution is only a hint. The runtime checks the immutable release
  // and recipient's live label under its family lock; later sender activity
  // cannot relabel the stored body or authorize a different sender.
  const admitted = await admitPeerMessage({
    session: params.session,
    messageId: trailer.messageId,
    senderSessionId,
    value: trailer.value,
  });
  if (admitted.kind === "admitted") {
    params.arrival.replace(admitted.value);
    return;
  }
  if (admitted.kind === "held") {
    params.arrival.replace(heldPeerNotice(admitted.notices, params.tools));
    return;
  }
  params.arrival.replace(WITHHELD_RELAY);
}

async function historicRelayRecords(params: {
  binding: AppaPluginBinding;
  session: OpenAppaSession;
  arrival: AppaRelayArrival;
  crossings: () => Promise<AppaChildReturnRecord[]>;
  addresses: () => Promise<string[]>;
}): Promise<string[]> {
  if (params.arrival.kind === "session" || params.arrival.from === "") {
    return [];
  }
  if (
    params.arrival.kind === "coordinator" ||
    PARENT_ENVELOPE_NAMES.has(params.arrival.from)
  ) {
    return params.addresses();
  }
  const returns = await params.crossings();
  const matched = returns.filter((record) =>
    returnNamesSender(params.arrival.from, record, params.session.session_id),
  );
  const senders = new Set(
    matched.map(
      (record) =>
        record.childNativeId ??
        record.childSessionId.slice(params.session.session_id.length + 1),
    ),
  );
  if (senders.size === 1) return matched.map((record) => record.value);
  if (senders.size > 1) return [];
  const launched = params.binding.adapter
    ?.teammateLaunches?.(params.binding.requestBody)
    .get(params.arrival.from);
  if (launched) {
    const values = returns
      .filter(
        (record) =>
          record.spawnCallId === withoutTrajectoryStamp(launched.spawnCallId) &&
          (!record.childNativeId ||
            record.childNativeId === launched.childNativeId),
      )
      .map((record) => record.value);
    if (values.length > 0) return values;
  }
  const aliases = await OpenAppaSpawnCorrelationModel.allowedSpawnAliases({
    organizationId: params.session.organization_id,
    callerId: params.session.caller_id,
    parentSessionId: params.session.session_id,
  });
  const named = aliases.filter(
    (alias) =>
      alias.name === params.arrival.from ||
      alias.description === params.arrival.from,
  );
  if (named.length === 1) {
    const values = returns
      .filter((record) => record.spawnCallId === named[0]?.spawnCallId)
      .map((record) => record.value);
    if (values.length > 0) return values;
  }
  if (named.length > 1) return [];
  const senderSessionId = await resolveArrivalSender(params);
  if (
    senderSessionId &&
    params.session.parent_id &&
    senderSessionId !== params.session.session_id
  ) {
    return params.addresses();
  }
  return [];
}

function returnNamesSender(
  from: string,
  record: AppaChildReturnRecord,
  parentSessionId: string,
): boolean {
  const nativeId =
    record.childNativeId ??
    (record.childSessionId.startsWith(`${parentSessionId}:`)
      ? record.childSessionId.slice(parentSessionId.length + 1)
      : undefined);
  if (!nativeId) return false;
  return nativeId === from || namesTeammate(from, nativeId);
}

async function resolveArrivalSender(params: {
  binding: AppaPluginBinding;
  session: OpenAppaSession;
  arrival: AppaRelayArrival;
}): Promise<string | undefined> {
  const { session, arrival } = params;
  if (arrival.kind === "session" || arrival.from === "") return undefined;
  if (
    arrival.kind === "coordinator" ||
    PARENT_ENVELOPE_NAMES.has(arrival.from)
  ) {
    return session.parent_id;
  }
  const own = await resolveNamedChild({
    binding: params.binding,
    parent: session,
    name: arrival.from,
    useRequestLaunches: true,
  });
  if (own && own !== "ambiguous" && !own.unchecked) {
    return `${session.session_id}:${own.childNativeId}`;
  }
  if (own === "ambiguous" || !session.parent_id) return undefined;
  const parent = await persistedSession(session, session.parent_id);
  if (!parent) return undefined;
  const sibling = await resolveNamedChild({
    binding: params.binding,
    parent,
    name: arrival.from,
    useRequestLaunches: false,
  });
  if (!sibling || sibling === "ambiguous" || sibling.unchecked)
    return undefined;
  return `${parent.session_id}:${sibling.childNativeId}`;
}

async function admitStructuredRelay(params: {
  binding: AppaPluginBinding;
  session: OpenAppaSession;
  arrival: AppaRelayArrival;
  tools: { list?: string; read?: string };
  crossings: () => Promise<AppaChildReturnRecord[]>;
  addresses: () => Promise<string[]>;
}): Promise<void> {
  const { arrival } = params;
  if (arrival.harnessOnly) return;
  const senderSessionId = await resolveArrivalSender({
    binding: params.binding,
    session: params.session,
    arrival,
  });
  if (senderSessionId) {
    const correlated = await admitPeerMessage({
      session: params.session,
      senderSessionId,
      value: arrival.body,
    });
    if (correlated.kind === "admitted") {
      arrival.replace(correlated.value);
      return;
    }
    if (correlated.kind === "held" && correlated.notices.length === 1) {
      arrival.replace(
        heldPeerNotice(
          correlated.notices,
          params.tools,
          protocolRequestId(arrival.body),
        ),
      );
      return;
    }
  }
  const records = await historicRelayRecords({
    binding: params.binding,
    session: params.session,
    arrival,
    crossings: params.crossings,
    addresses: params.addresses,
  });
  if (arrival.recorded?.(records)) {
    const { withheld } = arrival.admit(records);
    if (withheld) {
      logger.info(
        { sessionId: params.session.session_id, kind: arrival.kind },
        "OpenAPPA withheld a message with no record of crossing from its sender",
      );
    }
    return;
  }
  arrival.replace(
    inboxDiscoveryNotice(params.tools, protocolRequestId(arrival.body)),
  );
}

function heldPeerNotice(
  notices: readonly PeerNotice[],
  tools: { list?: string; read?: string },
  requestId?: string,
): string {
  const ids = notices.map((notice) => notice.messageId).join(", ");
  const expiry = notices
    .map((notice) => notice.expiresAt)
    .filter((value) => value.length > 0)
    .slice(0, 1)
    .join("");
  const when = expiry ? ` Expires ${expiry}.` : "";
  const protocol = requestId
    ? ` Protocol request id: ${requestId}. Read the held message before answering that request.`
    : "";
  if (tools.list && tools.read) {
    return `[appa] Message held. Its text is not shown here. Message id: ${ids}.${when}${protocol} Call ${tools.list}, then ${tools.read} with message_id set to that id.`;
  }
  return `[appa] Message held. Its text is not shown here. Message id: ${ids}.${when}${protocol} This client did not declare the gateway tools that can read it. Connect the MCP gateway and allow list_peer_messages and read_peer_message.`;
}

const PROTOCOL_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;

function protocolRequestId(body: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    const record = parsed as { request_id?: unknown; requestId?: unknown };
    const id = record.request_id ?? record.requestId;
    return typeof id === "string" && PROTOCOL_REQUEST_ID.test(id)
      ? id
      : undefined;
  } catch {
    return undefined;
  }
}

function inboxDiscoveryNotice(
  tools: { list?: string; read?: string },
  requestId?: string,
): string {
  const protocol = requestId
    ? ` Protocol request id: ${requestId}. Read the held message before answering that request.`
    : "";
  if (tools.list && tools.read) {
    return `[appa] Message withheld. Its text is not shown here.${protocol} Call ${tools.list}, then ${tools.read} with the message_id from that list.`;
  }
  return `[appa] Message withheld. Its text is not shown here.${protocol} This client did not declare the gateway tools that can read it. Connect the MCP gateway and allow list_peer_messages and read_peer_message.`;
}

function advertisedPeerTools(binding: AppaPluginBinding): {
  list?: string;
  read?: string;
} {
  const found: { list?: string; read?: string } = {};
  for (const declared of binding.request.declaredTools) {
    const short = peerShortName(binding, declared.name, declared.namespace);
    if (short === TOOL_LIST_PEER_MESSAGES_SHORT_NAME && !found.list) {
      found.list = declared.name;
    }
    if (short === TOOL_READ_PEER_MESSAGE_SHORT_NAME && !found.read) {
      found.read = declared.name;
    }
  }
  return found;
}

function peerShortName(
  binding: AppaPluginBinding,
  name: string,
  namespace?: string,
): string | null {
  const spelled = namespace ? `${namespace}__${name}` : name;
  const canonical = binding.identity.canonicalize(spelled);
  return (
    archestraMcpBranding.getToolShortName(canonical) ??
    archestraMcpBranding.getToolShortName(binding.identity.canonicalize(name))
  );
}

function isPeerInboxCall(binding: AppaPluginBinding, name: string): boolean {
  const short = peerShortName(binding, name);
  return (
    short === TOOL_LIST_PEER_MESSAGES_SHORT_NAME ||
    short === TOOL_READ_PEER_MESSAGE_SHORT_NAME
  );
}

function isPeerInboxResult(binding: AppaPluginBinding, name: string): boolean {
  return isPeerInboxCall(binding, name);
}

function stampPeerInboxCall(params: {
  binding: AppaPluginBinding;
  call: ToolCall;
  session: OpenAppaSession;
}): RelayOutcome {
  const short = peerShortName(params.binding, params.call.name);
  const secret = config.openappa.offerSigningSecret;
  if (
    !secret ||
    (short !== TOOL_LIST_PEER_MESSAGES_SHORT_NAME &&
      short !== TOOL_READ_PEER_MESSAGE_SHORT_NAME)
  ) {
    return { kind: "deny", feedback: PEER_INBOX_UNBOUND };
  }
  const args = argumentRecordOf(params.call.arguments) ?? {};
  const messageId =
    short === TOOL_READ_PEER_MESSAGE_SHORT_NAME
      ? stringArgument(args.message_id)
      : undefined;
  if (short === TOOL_READ_PEER_MESSAGE_SHORT_NAME && !messageId) {
    return { kind: "deny", feedback: PEER_INBOX_UNBOUND };
  }
  const proof = signPeerProof(
    {
      v: 1,
      organization_id: params.session.organization_id,
      caller_id: params.session.caller_id ?? null,
      session_id: params.session.session_id,
      parent_id: params.session.parent_id ?? null,
      call_id: params.call.id,
      action:
        short === TOOL_LIST_PEER_MESSAGES_SHORT_NAME
          ? "list_peer_messages"
          : "read_peer_message",
      message_id: messageId ?? null,
    },
    secret,
  );
  if (!proof) return { kind: "deny", feedback: PEER_INBOX_UNBOUND };
  const { [PEER_PROOF_ARGUMENT]: _ignored, ...rest } = args;
  return {
    kind: "release",
    call: {
      ...params.call,
      arguments: JSON.stringify({ ...rest, [PEER_PROOF_ARGUMENT]: proof }),
    },
  };
}

async function withholdUnrecordedPeerReads(params: {
  binding: AppaPluginBinding;
  session: OpenAppaSession;
  results: LlmProxyToolResultsContext["toolResults"];
  updates: Record<string, string>;
}): Promise<void> {
  for (const result of params.results) {
    if (!isPeerInboxResult(params.binding, result.name)) continue;
    if (isPeerReadResult(params.binding, result.name)) {
      const receipt = await OpenAppaSessionModel.retainedPeerReadReceipt({
        organizationId: params.session.organization_id,
        sessionId: params.session.session_id,
        callerId: params.session.caller_id,
        toolCallId: result.id,
      });
      params.updates[result.id] = receipt
        ? restoredPeerRead({
            binding: params.binding,
            session: params.session,
            toolName: result.name,
            receipt,
          })
        : WITHHELD_PEER_READ;
      continue;
    }
    const retained = await OpenAppaSessionModel.retainedToolResult({
      organizationId: params.session.organization_id,
      sessionId: params.session.session_id,
      callerId: params.session.caller_id,
      toolCallId: result.id,
    });
    params.updates[result.id] = retained ?? WITHHELD_PEER_READ;
  }
}

function restoredPeerRead(params: {
  binding: AppaPluginBinding;
  session: OpenAppaSession;
  toolName: string;
  receipt: Awaited<
    ReturnType<typeof OpenAppaSessionModel.retainedPeerReadReceipt>
  >;
}): string {
  const { binding, session, toolName, receipt } = params;
  if (!receipt) return WITHHELD_PEER_READ;
  if (receipt.kind === "admitted") {
    return escapeRelayMarkup(receipt.approvedOutput);
  }
  const offers = signedOffersForDenial(session, {
    offerIds: receipt.offers.map((offer) => offer.offer_id),
    tool: TOOL_READ_PEER_MESSAGE_SHORT_NAME,
    spelling: toolName,
  });
  // These claims come from the runtime receipt, not the client's tool result.
  // The next control call needs them as well as the model-visible ruling.
  binding.request = {
    ...binding.request,
    offerClaims: [...(binding.request.offerClaims ?? []), ...offers],
  };
  return JSON.stringify({
    ruling: receipt.feedback,
    ...(offers.length > 0 ? { offers } : {}),
  });
}

function isPeerReadResult(binding: AppaPluginBinding, name: string): boolean {
  return peerShortName(binding, name) === TOOL_READ_PEER_MESSAGE_SHORT_NAME;
}

function stringArgument(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

const PEER_INBOX_UNBOUND =
  "OpenAPPA cannot bind this peer-message call to the authenticated session, so it was not sent. Connect the MCP gateway and retry.";

async function admitChildHandback(params: {
  binding: AppaPluginBinding;
  call: ToolCall;
}): Promise<{ call: ToolCall; returnText: string; approvedText: string }> {
  const { binding, call } = params;
  const adapter = binding.adapter;
  const raw = adapter?.childHandbackValue?.(call.arguments);
  if (!raw) {
    throw new ApiError(400, "OpenAPPA child handback carried no return value");
  }
  const childNativeId = binding.child?.lineage?.childNativeId;
  const spawnCallId = await resolveSpawnCallId(binding);
  if (!binding.session.parent_id || !spawnCallId) throw uncorrelatedChild();
  if (!binding.request.turnEndOperationId) {
    throw new ApiError(503, "OpenAPPA could not safely end the child turn");
  }
  if (!childReturnMarkersConfigured()) {
    throw new ApiError(503, "OpenAPPA could not protect the child return");
  }
  const outcome = await endChild({
    session: binding.session,
    operationId: binding.request.turnEndOperationId.replace(
      /^turn_end:/,
      "child_end:",
    ),
    output: raw,
    spawnCallId,
    ...(childNativeId ? { childNativeId } : {}),
  });
  const admitted =
    outcome.decision === "release" ? raw : (outcome.content ?? "");
  if (!outcome.crossed) {
    throw new ApiError(409, admitted || "OpenAPPA withheld the child return");
  }
  const marker = mintBoundChildReturnMarker({
    binding,
    spawnCallId,
    value: admitted,
  });
  if (!marker) {
    throw new ApiError(503, "OpenAPPA could not protect the child return");
  }
  const returnText = `${admitted}\n\n${marker}`;
  const rewritten = adapter?.rewriteChildHandback?.(call.arguments, returnText);
  return {
    call: {
      ...call,
      arguments: rewritten === undefined ? returnText : rewritten,
    },
    returnText,
    approvedText: admitted,
  };
}

/**
 * A child whose spawn no record names cannot return to its parent, however
 * often it retries, so the client is told not to retry.
 */
function uncorrelatedChild(): ApiError {
  const error = new ApiError(
    409,
    "OpenAPPA cannot tell which spawn started this subagent, so it cannot return the subagent's result to its parent. Start a new subagent.",
  );
  error.shouldRetry = false;
  return error;
}

/**
 * A declared native handback is the only completion this child can deliver.
 * The gate is the governed request's tool list plus an attested child binding,
 * not the client name and not prose in an unbound session.
 */
function nativeHandbackBoundary(binding: AppaPluginBinding): boolean {
  return (
    binding.child?.lineage !== undefined &&
    binding.adapter?.requiresNativeChildHandback?.(binding.requestBody) === true
  );
}

function mintBoundChildReturnMarker(params: {
  binding: AppaPluginBinding;
  spawnCallId: string;
  value: string;
}): string | undefined {
  const child = params.binding.child;
  const lineage = child?.lineage;
  const parentId = child?.parentId ?? params.binding.session.parent_id;
  if (!parentId) return undefined;
  return mintChildReturnMarker({
    organizationId: params.binding.session.organization_id,
    callerId: params.binding.session.caller_id,
    parentId,
    childId: child?.sessionId ?? params.binding.session.session_id,
    ...(lineage?.childNativeId ? { childNativeId: lineage.childNativeId } : {}),
    ...(lineage?.nativeParentId
      ? { spawnerNativeId: lineage.nativeParentId }
      : {}),
    spawnCallId: params.spawnCallId,
    value: params.value,
    ...(params.binding.adapter?.id === "codex"
      ? { format: "inline" as const }
      : {}),
  });
}

/**
 * The spawn call a child return answers. Lineage carries it from the child's
 * first request. A later request may lose that marker, so the child's first
 * retained prompt recovers its signed spawn binding without guessing from
 * unrelated parent calls.
 */
async function resolveSpawnCallId(
  binding: Pick<AppaPluginBinding, "child" | "session">,
): Promise<string | undefined> {
  const lineage = binding.child?.lineage;
  if (lineage?.spawnCallId) return lineage.spawnCallId;
  if (!binding.session.parent_id) return undefined;
  return (
    (await OpenAppaSpawnCorrelationModel.soleOpenSpawn({
      organizationId: binding.session.organization_id,
      callerId: binding.session.caller_id,
      parentSessionId: binding.session.parent_id,
      childSessionId: binding.session.session_id,
    })) ?? undefined
  );
}

function isCompactionOnlyResponse(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const response = value as Record<string, unknown>;
  return (
    response.object === "response.compaction" ||
    (Array.isArray(response.output) &&
      response.output.length > 0 &&
      response.output.every(
        (item) =>
          item && typeof item === "object" && item.type === "compaction",
      ))
  );
}

function getTrustedContext(
  resources: ReadonlyMap<PropertyKey, unknown>,
): AppaTrustedContext | undefined {
  const trustedContext = resources.get(APPA_PLUGIN_TRUSTED_CONTEXT);
  return typeof trustedContext === "object" &&
    trustedContext !== null &&
    "session" in trustedContext &&
    "profileId" in trustedContext &&
    "toolIdentity" in trustedContext &&
    "request" in trustedContext
    ? (trustedContext as AppaTrustedContext)
    : undefined;
}

function issueChildTrajectoryReceipt(
  context: LlmProxyRequestContext,
  session: OpenAppaSession,
  child: AppaChildTrajectory,
): void {
  const lineage = child.lineage;
  if (!lineage) return;
  const footer = mintChildTrajectoryReceipt({
    organizationId: session.organization_id,
    callerId: session.caller_id,
    parentId: child.parentId,
    childId: child.sessionId,
    ...(lineage.childNativeId ? { childNativeId: lineage.childNativeId } : {}),
    spawnerNativeId: lineage.nativeParentId,
    spawnCallId: lineage.spawnCallId,
  });
  if (!footer) return;
  context.resources.set(APPA_CHILD_TRAJECTORY_RECEIPT, {
    footer,
    inHistory: lineage.source === "receipt",
  });
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
 * Returns offers from history that belong to the current session.
 * A fork replays parent notices and offers. To prevent modifying parent state,
 * the fork excludes parent offers from its control calls.
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

/**
 * Attaches a delegation marker to an allowed spawn call's prompt.
 * Preserves the call ID, name, namespace, and argument format.
 */
function withDelegationMarker(params: {
  call: ToolCall;
  adapter: AppaClientAdapter;
  mint: (prompt: string, callId: string) => string | undefined;
}): { call: ToolCall; annotation: LlmProxyToolCallAnnotation } | undefined {
  const { call } = params;
  if (!params.adapter.isSpawnTool(call.name, call.namespace)) return undefined;
  const args = argumentRecordOf(call.arguments);
  const spawn = args && params.adapter.spawnPromptField(call.name, args);
  if (!args || !spawn) return undefined;
  const value = args[spawn.field];
  let appended: string | Record<string, unknown>;
  let next: unknown;
  if (spawn.kind === "text") {
    if (typeof value !== "string" || value.trim().length === 0)
      return undefined;
    const marker = params.mint(value, call.id);
    if (!marker) return undefined;
    appended = `\n\n${marker}`;
    next = value + appended;
  } else {
    if (!Array.isArray(value) || value.length === 0) return undefined;
    const marker = params.mint("", call.id);
    if (!marker) return undefined;
    appended = { type: "text", text: marker };
    next = [...value, appended];
  }
  const nextArgs = { ...args, [spawn.field]: next };
  return {
    call: {
      ...call,
      arguments:
        typeof call.arguments === "string"
          ? JSON.stringify(nextArgs)
          : nextArgs,
    },
    annotation: {
      id: call.id,
      name: call.name,
      field: spawn.field,
      appended,
    },
  };
}

/**
 * Determines whether a tool call spawns a child trajectory.
 * Tests with sample arguments if actual arguments cannot be parsed.
 */
function isChildSpawnCall(adapter: AppaClientAdapter, call: ToolCall): boolean {
  if (!adapter.isSpawnTool(call.name, call.namespace)) return false;
  const args = argumentRecordOf(call.arguments);
  if (args && adapter.spawnPromptField(call.name, args)) return true;
  return (
    adapter.spawnPromptField(call.name, {
      prompt: "probe",
      message: "probe",
      items: [{ type: "text", text: "probe" }],
    }) !== undefined
  );
}

const AUTHORIZED_RETRY =
  /Call the (\S+) tool again with exactly these arguments: /;

type AuthorizedSpawn = {
  tool: string;
  arguments: Record<string, unknown>;
  namespace?: string;
};

/**
 * Replaces one rewritten retry of an authorized spawn with the arguments the
 * offer covers. The runtime matches the tool and those arguments, not the
 * call id. A different task name, a non-spawn, or a retry that already
 * carried the authorized arguments is not rewritten.
 * One pending acceptance restores at most one call in a batch; it does not
 * authorize fan-out. Every remaining call still needs its own runtime ruling.
 */
function restoreAuthorizedSpawnRetry(params: {
  calls: readonly ToolCall[];
  requestBody: unknown;
  isSpawn: (name: string, namespace?: string) => boolean;
}): readonly ToolCall[] {
  const pending = pendingAuthorizedSpawn(params.requestBody);
  if (!pending) return params.calls;
  let restored = false;
  return params.calls.map((call) => {
    if (restored || !params.isSpawn(call.name, call.namespace)) return call;
    const args = argumentRecordOf(call.arguments);
    if (
      !args ||
      !sameAuthorizedSpawn({
        name: call.name,
        arguments: args,
        pending,
      })
    ) {
      return call;
    }
    restored = true;
    if (spawnArgumentsCovered(args, pending.arguments)) {
      return call.namespace || !pending.namespace
        ? call
        : { ...call, namespace: pending.namespace };
    }
    return {
      ...call,
      ...(call.namespace || !pending.namespace
        ? {}
        : { namespace: pending.namespace }),
      arguments:
        typeof call.arguments === "string"
          ? JSON.stringify(pending.arguments)
          : pending.arguments,
    };
  });
}

function pendingAuthorizedSpawn(body: unknown): AuthorizedSpawn | undefined {
  const input = isRecord(body) ? body.input : undefined;
  if (!Array.isArray(input)) return undefined;
  let pending: AuthorizedSpawn | undefined;
  const namespaceByTask = new Map<string, string>();
  for (const item of input) {
    if (!isRecord(item)) continue;
    if (item.type === "function_call" || item.type === "custom_tool_call") {
      const args = argumentRecordOf(
        typeof item.arguments === "string"
          ? item.arguments
          : JSON.stringify(item.arguments ?? {}),
      );
      const name = typeof item.name === "string" ? item.name : undefined;
      if (!args || !name) continue;
      const task =
        typeof args.task_name === "string" ? args.task_name : undefined;
      if (
        task &&
        typeof item.namespace === "string" &&
        !namespaceByTask.has(task)
      ) {
        namespaceByTask.set(task, item.namespace);
      }
      if (
        pending &&
        sameAuthorizedSpawn({ name, arguments: args, pending }) &&
        spawnArgumentsCovered(args, pending.arguments)
      ) {
        pending = undefined;
      }
      continue;
    }
    if (
      pending &&
      (item.type === "message" || item.type === undefined) &&
      item.role === "user"
    ) {
      pending = undefined;
      continue;
    }
    const accepted = outputTexts(item.output)
      .map(parseAuthorizedRetry)
      .filter((retry) => retry !== undefined);
    if (accepted.length > 1) {
      // One output must identify one retry, not choose among accepted blobs.
      pending = undefined;
      continue;
    }
    const authorized = accepted[0];
    if (!authorized) continue;
    const task =
      typeof authorized.arguments.task_name === "string"
        ? authorized.arguments.task_name
        : undefined;
    pending = {
      ...authorized,
      ...(task && namespaceByTask.has(task)
        ? { namespace: namespaceByTask.get(task) }
        : {}),
    };
  }
  return pending;
}

function parseAuthorizedRetry(
  text: string,
): { tool: string; arguments: Record<string, unknown> } | undefined {
  if (!text.startsWith("[appa] Authorized.")) return undefined;
  const match = AUTHORIZED_RETRY.exec(text);
  if (!match) return undefined;
  const parsed = parseJsonObject(text.slice(match.index + match[0].length));
  if (!parsed) return undefined;
  return { tool: match[1], arguments: parsed };
}

function sameAuthorizedSpawn(params: {
  name: string;
  arguments: Record<string, unknown>;
  pending: AuthorizedSpawn;
}): boolean {
  if (localSpawnName(params.name) !== localSpawnName(params.pending.tool)) {
    return false;
  }
  // The prompt is the only field a retry may rewrite. Any other difference,
  // including a reused task_name with different options, is another call.
  const promptField =
    typeof params.pending.arguments.message === "string"
      ? "message"
      : Array.isArray(params.pending.arguments.items)
        ? "items"
        : undefined;
  if (
    !promptField ||
    ("message" in params.pending.arguments &&
      "items" in params.pending.arguments) ||
    ("message" in params.arguments && "items" in params.arguments) ||
    (promptField === "message"
      ? typeof params.arguments.message !== "string"
      : !Array.isArray(params.arguments.items))
  ) {
    return false;
  }
  const authorizedKeys = Object.keys(params.pending.arguments)
    .filter((key) => key !== promptField)
    .sort();
  const actualKeys = Object.keys(params.arguments)
    .filter((key) => key !== promptField)
    .sort();
  if (authorizedKeys.join("\0") !== actualKeys.join("\0")) return false;
  return authorizedKeys.every(
    (key) =>
      JSON.stringify(params.arguments[key]) ===
      JSON.stringify(params.pending.arguments[key]),
  );
}

function spawnArgumentsCovered(
  actual: Record<string, unknown>,
  authorized: Record<string, unknown>,
): boolean {
  if (
    typeof authorized.task_name === "string" &&
    actual.task_name !== authorized.task_name
  ) {
    return false;
  }
  if (typeof authorized.message === "string") {
    return (
      typeof actual.message === "string" &&
      (actual.message === authorized.message ||
        actual.message.startsWith(
          `${authorized.message}\n\n[appa] delegated trajectory `,
        ))
    );
  }
  if (Array.isArray(authorized.items)) {
    return (
      Array.isArray(actual.items) &&
      JSON.stringify(actual.items.slice(0, authorized.items.length)) ===
        JSON.stringify(authorized.items)
    );
  }
  return JSON.stringify(actual) === JSON.stringify(authorized);
}

function localSpawnName(name: string): string {
  const slash = name.lastIndexOf("/");
  const dotted = name.lastIndexOf(".");
  return name.slice(Math.max(slash, dotted) + 1);
}

function outputTexts(value: unknown, depth = 0): string[] {
  // Inspect at most eight nested content/JSON wrappers, not arbitrary documents.
  if (depth > 8) return [];
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed === "string") return [parsed];
      if (Array.isArray(parsed)) return outputTexts(parsed, depth + 1);
      if (isRecord(parsed) && Array.isArray(parsed.content)) {
        return outputTexts(parsed.content, depth + 1);
      }
    } catch {
      /* Plain tool-result text is not JSON. */
    }
    return [value];
  }
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item === "string") return [item];
    if (!isRecord(item)) return [];
    if (typeof item.text === "string") return [item.text];
    return outputTexts(item.content, depth + 1);
  });
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  const start = text.indexOf("{");
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index++) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          const parsed: unknown = JSON.parse(text.slice(start, index + 1));
          return isRecord(parsed) ? parsed : undefined;
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

/**
 * A call's arguments as an object. Empty text is the empty object a call
 * with no input streams as; anything else must parse to an object.
 */
function argumentRecordOf(
  args: string | Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (typeof args !== "string") return args;
  if (args.trim().length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(args);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function protectNamedChildren(params: {
  children: string[];
  rootId: string;
  spawn: boolean;
}): void {
  for (const child of params.children) {
    if (child === params.rootId || !child.startsWith(`${params.rootId}:`)) {
      throw new ApiError(
        400,
        params.spawn
          ? "OpenAPPA spawn named a child trajectory that is not bound to this parent"
          : "OpenAPPA child trajectory is not bound to this parent",
      );
    }
  }
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
    ...(call.namespace ? { namespace: call.namespace } : {}),
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

/**
 * Attaches signed offer envelopes from this turn's notices to an ask_user call.
 * This lets the tool include a verified remedy continuation in its result.
 * The proxy is the sole writer of this field; client-supplied copies are stripped first.
 */
function stampAskUserOffers(
  call: LlmProxyToolCallsContext["toolCalls"][number],
  offerClaims: readonly OfferJws[] | undefined,
  claimedOfferIds: Set<string>,
): {
  call: LlmProxyToolCallsContext["toolCalls"][number];
  offerIds: string[];
} {
  const originalArguments =
    typeof call.arguments === "string"
      ? call.arguments
      : JSON.stringify(call.arguments);
  let argumentsValue: unknown;
  try {
    argumentsValue = JSON.parse(originalArguments);
  } catch {
    return { call, offerIds: [] };
  }
  if (
    !argumentsValue ||
    typeof argumentsValue !== "object" ||
    Array.isArray(argumentsValue)
  )
    return { call, offerIds: [] };
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
    return {
      call:
        Object.keys(clientArguments).length ===
        Object.keys(argumentRecord).length
          ? call
          : { ...call, arguments: JSON.stringify(clientArguments) },
      offerIds: [],
    };
  }
  for (const id of requestedOfferIds) claimedOfferIds.add(id);
  return {
    call: {
      ...call,
      arguments: JSON.stringify({
        ...clientArguments,
        remedy_offers: selectedOffers,
      }),
    },
    offerIds: requestedOfferIds,
  };
}

async function canonicalizeHitlAskUserCall(params: {
  binding: AppaPluginBinding;
  call: LlmProxyToolCallsContext["toolCalls"][number];
  offerIds: readonly string[];
}): Promise<{
  call: LlmProxyToolCallsContext["toolCalls"][number];
  invalidOfferCount: boolean;
}> {
  if (params.offerIds.length !== 1) {
    const pending = await Promise.all(
      params.offerIds.map((offerId) =>
        getHitlReview({ session: params.binding.session, offerId }),
      ),
    );
    return {
      call: params.call,
      invalidOfferCount: pending.some(Boolean),
    };
  }
  let hitl = await getHitlAskUserArguments({
    session: params.binding.session,
    offerIds: params.offerIds,
  });
  const native = params.binding.adapter?.nativeQuestion;
  if (
    !hitl &&
    native?.fromAskUser &&
    native.isAvailable?.(params.binding.requestHeaders) !== false &&
    declaresNativeQuestion(params.binding, native.toolName)
  ) {
    const offerId = params.offerIds[0];
    const claims = claimsForOffer(
      offerId,
      sessionOfferClaims(
        params.binding.request.askUserOfferClaims,
        params.binding.session.session_id,
      ),
    );
    if (claims) {
      const review = await loadOfferReview({
        organizationId: params.binding.session.organization_id,
        sessionId: params.binding.session.session_id,
        offerId,
      });
      if (review) {
        if (
          review.offer_id !== offerId ||
          review.session_id !== params.binding.session.session_id
        ) {
          throw new ApiError(409, "OpenAPPA review does not match this offer");
        }
        const staged = await stageLoadedHitlReview({
          session: params.binding.session,
          review: {
            ...review,
            remedyArguments: { offer_id: offerId, ...claims },
          },
        });
        hitl = await getHitlAskUserArguments({
          session: params.binding.session,
          offerIds: params.offerIds,
        });
        if (staged === "unusable" || !hitl) {
          throw new ApiError(409, "OpenAPPA review cannot be shown safely");
        }
      }
    }
  }
  if (!hitl) return { call: params.call, invalidOfferCount: false };
  const raw =
    typeof params.call.arguments === "string"
      ? params.call.arguments
      : JSON.stringify(params.call.arguments);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { call: params.call, invalidOfferCount: false };
  }
  if (!isRecord(parsed)) return { call: params.call, invalidOfferCount: false };
  return {
    call: {
      ...params.call,
      arguments: JSON.stringify({
        ...hitl,
        ...(Array.isArray(parsed.remedy_offers)
          ? { remedy_offers: parsed.remedy_offers }
          : {}),
      }),
    },
    invalidOfferCount: false,
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
  "That reply answers an instruction to wait for the user, so the same decision needs no second free-text answer or repeat confirmation.",
  "Carrying out the user's explicitly selected remedy is following that decision, not choosing a remedy yourself.",
  "If the requested task still has unfinished work, continue using that answer in this turn rather than ending with only an acknowledgment.",
  "If the user asked only to record a decision, do not perform extra actions.",
  "A form's accept/submitted status is not by itself agreement with a remedy: follow the selected answer.",
  "Only if the answer explicitly accepts a currently offered, unexecuted remedy, call the declared execute_remedy_plan tool for that offer.",
  "Retry the blocked call once, after execute_remedy_plan reports that the plan is authorized.",
  "If the remedy fails, its result is withheld, or the retry is blocked again, stop and tell the user about that failure.",
  "Do not apply new offers or repeat the workflow under the earlier acceptance.",
  "For a tool discovered through search_tools that is not directly declared, execute that retry using the same gateway's declared run_tool: put the discovered tool name in tool_name and the original arguments in tool_args.",
  "Resource listing is not tool execution. Do not substitute list_mcp_resources for that retry.",
  "Never invent a plan, treat an error or missing answer as consent, or repeat a completed remedy or retry.",
  "If a question is declined, dismissed, cancelled, or unanswered, do not proceed with its dependent action.",
  "State briefly that it will not proceed, then stop that action without repeating options, asking again, or adding a follow-up question or invitation (including 'let me know').",
  "Continue only independent work supported by other answers.",
  "Revisit a rejected decision only after a new user request.",
].join(" ");

const NATIVE_DELEGATION_GUIDANCE_MARKER =
  "collaboration.spawn_agent is declared.";

function nativeDelegationGuidance(): string {
  return [
    NATIVE_DELEGATION_GUIDANCE_MARKER,
    "A request for a native subagent is a direct function call with namespace collaboration and name spawn_agent.",
    "If collaboration.wait_agent is declared, call it for that subagent's result.",
    "If waiting is refused, do not probe list_agents, sleep, or shell commands as substitutes. Report the block or await the client's automatic completion notice.",
    "Do not run a nested Codex CLI as that subagent, and do not report a nested CLI result as a subagent result.",
    "An explicit user request to run a shell command stays a shell command. Do not rewrite it into spawn_agent.",
  ].join(" ");
}

function appendNativeDelegationGuidance(
  context: LlmProxyBeforeModelContext,
): void {
  if (context.interactionType !== "openai:responses") return;
  if (!isRecord(context.request)) return;
  if (hasNativeDelegationMarker(context.request)) return;
  const declared = collectDeclaredToolNames(context.request);
  const spawnDeclared = declared.some(
    (tool) => tool.namespace === "collaboration" && tool.name === "spawn_agent",
  );
  if (!spawnDeclared) return;
  anchorConstantGuidance({
    request: context.request,
    interactionType: context.interactionType,
    guidance: nativeDelegationGuidance(),
  });
}

function hasNativeDelegationMarker(request: Record<string, unknown>): boolean {
  if (
    typeof request.instructions === "string" &&
    request.instructions.includes(NATIVE_DELEGATION_GUIDANCE_MARKER)
  ) {
    return true;
  }
  if (!Array.isArray(request.input)) return false;
  return request.input.some((item) => {
    if (!isRecord(item) || !Array.isArray(item.content)) return false;
    return item.content.some(
      (block) =>
        isRecord(block) &&
        typeof block.text === "string" &&
        block.text.startsWith(NATIVE_DELEGATION_GUIDANCE_MARKER),
    );
  });
}

const OPENCODE_DELEGATED_TASK_GUIDANCE = [
  "This is a delegated task, not a new general coding assignment. Perform only the operations the parent's task requires.",
  "For a named MCP read, use the declared MCP discovery and execution tools directly. Do not run pwd or probe repository paths, inspect local files, or execute shell commands merely to prepare that read.",
  "Required policy remedies, permission questions, and native completion transport remain available, but do not authorize extra business operations. Do not find substitutes for a denied unrelated tool.",
].join(" ");

const EXTERNAL_REMEDY_WORKFLOW_GUIDANCE = [
  "The organization's guardrails policy can block a tool call and offer remedy plans in its ruling.",
  "A remedy plan is the policy's own way to continue, and execute_remedy_plan applies the plan through the policy.",
  "If the plan fits the user's request, continue the task and apply the plan with execute_remedy_plan.",
  "Use the offer_id and plan from the ruling.",
  "If the user requires consent before applying a plan, ask the declared ask_user tool with that offer ID in remedy_offer_ids first. The platform loads the exact review without applying the plan. Never use an unbound question as authorization.",
  "The policy decides when the user must approve a plan.",
  "In that case, execute_remedy_plan returns review_required.",
  "Then ask the user with the declared ask_user tool, one call for each pending offer, not in plain text.",
  "Put the offer ID from that persisted result in remedy_offer_ids, and use the header Approval and the options Approve and Deny.",
  "The platform shows the user the exact review.",
  "When a verified human answer approves a pending OpenAPPA review, your next and only tool calls must be execute_remedy_plan for the approved offer shown in that answer and the earlier plan.",
  "Retry the blocked call only after execute_remedy_plan reports that the plan is authorized.",
  "When a verified human answer did not approve the pending OpenAPPA review, do not call execute_remedy_plan and do not retry the blocked call.",
  "Tell the user briefly that the action stays blocked, and stop that action.",
].join(" ");

const NATIVE_QUESTION_ID_PATTERN =
  /^(toolu|call|aq)_aq1_([A-Za-z0-9_-]{16})_([A-Za-z0-9_-]{22})$/;

function isGatewayAskUser(binding: AppaPluginBinding, name: string): boolean {
  const namespace = binding.request.tools?.namespaces?.get(name);
  if (namespace) {
    const namespaced = `${namespace}__${name}`;
    const canonical = binding.identity.canonicalize(namespaced);
    return (
      canonical !== namespaced &&
      archestraMcpBranding.getToolShortName(canonical) ===
        TOOL_ASK_USER_SHORT_NAME
    );
  }
  const labeled = underscoreLabeledPlatformToolName(name, (toolName) =>
    binding.identity.canonicalize(toolName),
  );
  if (labeled) {
    return (
      archestraMcpBranding.getToolShortName(labeled) ===
      TOOL_ASK_USER_SHORT_NAME
    );
  }
  const canonical = binding.identity.canonicalize(name);
  return (
    canonical !== name &&
    archestraMcpBranding.getToolShortName(canonical) ===
      TOOL_ASK_USER_SHORT_NAME
  );
}

function isUserQuestionCall(binding: AppaPluginBinding, name: string): boolean {
  return (
    binding.request.tools?.platformToolNames?.has(name) === true ||
    nativeQuestionName(binding, name) !== undefined ||
    isGatewayAskUser(binding, name)
  );
}

/**
 * True for a call that the runtime releases as a user question. The runtime
 * keeps no record of such a call, so the result side must recognize its
 * answer by other means.
 */
function releasesUserQuestion(
  binding: AppaPluginBinding,
  call: { name: string; namespace?: string },
): boolean {
  const tools = binding.request.tools;
  if (tools?.platformToolNames?.has(call.name)) {
    return call.namespace === tools.askUser?.namespace;
  }
  if (
    call.namespace !== undefined &&
    binding.adapter?.classifyToolName(call.name, call.namespace) !== "local"
  ) {
    return false;
  }
  return isUserQuestionCall(binding, call.name);
}

/**
 * Gives a native question call a signed id, but only when the runtime
 * releases that call as a user question. An answer under this id skips the
 * runtime's result check, so a call that the runtime rules on must keep its
 * own id.
 */
function withNativeQuestionId(
  binding: AppaPluginBinding,
  call: ToolCall,
  offerIds: readonly string[] = [],
): { call: ToolCall; question: { id: string; name: string } } | undefined {
  const name = nativeQuestionName(binding, call.name);
  if (!name || !releasesUserQuestion(binding, call)) return undefined;
  const id = issueNativeQuestionId({
    session: binding.session,
    name,
    currentId: call.id,
    arguments: call.arguments,
    offerIds,
  });
  return { call: { ...call, wireId: id }, question: { id, name } };
}

async function rememberNativeQuestions(
  binding: AppaPluginBinding,
  questions: readonly IssuedNativeQuestion[],
): Promise<void> {
  await Promise.all(
    questions.map((question) =>
      cacheManager.set(
        nativeQuestionCacheKey({
          session: binding.session,
          id: question.id,
        }),
        {
          name: question.name,
          ...(question.offerIds.length > 0
            ? { offerIds: question.offerIds }
            : {}),
        },
        TimeInMs.Minute * 10,
      ),
    ),
  );
}

function isUserQuestionResult(params: {
  binding: AppaPluginBinding;
  answer: { id: string; name: string };
  verifiedNativeQuestionResults: ReadonlyMap<object, NativeQuestionClaim>;
}): boolean {
  if (
    params.binding.request.tools?.platformToolNames?.has(params.answer.name) ===
    true
  )
    return true;
  if (isGatewayAskUser(params.binding, params.answer.name)) return true;
  const name = nativeQuestionName(params.binding, params.answer.name);
  return (
    name !== undefined &&
    params.verifiedNativeQuestionResults.has(params.answer)
  );
}

/**
 * An answer to a question the proxy issued in this session, by the question's
 * signed id. The claim on an issued question is spent by the first request
 * that carries its answer; the id is not, so every later turn that replays the
 * answer reads it too.
 */
function isIssuedQuestionAnswer(
  binding: AppaPluginBinding,
  answer: { id: string; name: string },
): boolean {
  const name = nativeQuestionName(binding, answer.name);
  return (
    name !== undefined &&
    verifyNativeQuestionId({ session: binding.session, name, id: answer.id })
  );
}

async function claimNativeQuestionResults(params: {
  binding: AppaPluginBinding;
  results: ReadonlyArray<{ id: string; name: string }>;
}): Promise<Map<object, NativeQuestionClaim>> {
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
  const verified = new Map<object, NativeQuestionClaim>();
  if (candidates.length === 0) return verified;
  const claimed = new Map(
    (
      await cacheManager.getAndDeleteMany<{
        name?: unknown;
        offerIds?: unknown;
      }>(candidates.map((candidate) => candidate.key))
    ).map((entry) => [entry.key, entry.value]),
  );
  for (const candidate of candidates) {
    const entry = claimed.get(candidate.key);
    if (entry?.name === candidate.name) {
      const offerIds = Array.isArray(entry.offerIds)
        ? entry.offerIds.filter(
            (offerId): offerId is string =>
              typeof offerId === "string" && offerId.length > 0,
          )
        : undefined;
      verified.set(candidate.result, {
        ...(offerIds && offerIds.length > 0 ? { offerIds } : {}),
      });
    }
  }
  return verified;
}

async function recordNativeHitlRulings(params: {
  binding: AppaPluginBinding;
  verifiedNativeQuestionResults: ReadonlyMap<object, NativeQuestionClaim>;
}): Promise<RecordedNativeHitlRuling[]> {
  const parse = params.binding.adapter?.nativeQuestion?.rulingFromResult;
  if (!parse) return [];
  const recorded: RecordedNativeHitlRuling[] = [];
  for (const [answer, claim] of params.verifiedNativeQuestionResults) {
    if (!claim.offerIds || claim.offerIds.length === 0 || !isRecord(answer))
      continue;
    const ruling = parse({
      content:
        typeof answer.content === "string"
          ? answer.content
          : JSON.stringify(answer.content ?? null),
      ...(typeof answer.isError === "boolean"
        ? { isError: answer.isError }
        : {}),
    });
    logger.debug(
      {
        ruling,
        offerIds: claim.offerIds,
        contentType: Array.isArray(answer.content)
          ? "array"
          : typeof answer.content,
      },
      "Recorded native OpenAPPA HITL answer",
    );
    for (const offerId of claim.offerIds) {
      if (
        await recordHitlRuling({
          session: params.binding.session,
          offerId,
          ruling,
        })
      ) {
        recorded.push({ offerId, ruling });
      }
    }
  }
  return recorded;
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
  const namespace = binding.request.tools?.namespaces?.get(name);
  const gateway =
    namespace?.startsWith(CODEX_MCP_NAMESPACE_PREFIX) ||
    binding.adapter.classifyToolName(name) === "gateway" ||
    binding.identity.canonicalize(name) !== name;
  if (gateway) return undefined;
  const normalized = binding.adapter.normalizeLocalToolName(name);
  return normalized === native.toolName ? normalized : undefined;
}

function declaresNativeQuestion(
  binding: AppaPluginBinding,
  nativeToolName: string,
): boolean {
  const adapter = binding.adapter;
  if (!adapter) return false;
  return (binding.request.declaredTools ?? []).some((tool) => {
    if (binding.identity.attestationOf(tool.name, tool.namespace)) return false;
    if (adapter.classifyToolName(tool.name, tool.namespace) !== "local")
      return false;
    return adapter.normalizeLocalToolName(tool.name) === nativeToolName;
  });
}

function issueNativeQuestionId(params: {
  session: OpenAppaSession;
  name: string;
  currentId: string;
  arguments: unknown;
  offerIds: readonly string[];
}): string {
  if (!config.openappa.offerSigningSecret) {
    throw new ApiError(
      503,
      "OpenAPPA native question signing is not configured (ARCHESTRA_OPENAPPA_OFFER_SIGNING_SECRET)",
    );
  }
  const nonce = createHmac("sha256", config.openappa.offerSigningSecret)
    .update("archestra-native-question-nonce-v1\0")
    .update(
      JSON.stringify([
        params.session.organization_id,
        params.session.caller_id ?? "",
        params.session.session_id,
        params.session.parent_id ?? "",
        params.name,
        params.currentId,
        canonicalQuestionArgs(params.arguments),
        params.offerIds,
      ]),
    )
    .digest()
    .subarray(0, 12)
    .toString("base64url");
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
  const scope = nativeQuestionTag({
    session: params.session,
    name: "cache",
    nonce: params.id,
  }).toString("base64url");
  return `${CacheKey.OpenAppaNativeQuestion}-${scope}`;
}

function canonicalQuestionArgs(value: unknown): unknown {
  const parsed = typeof value === "string" ? parsedJson(value) : value;
  return stableJson(parsed ?? value);
}

function parsedJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function stableJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableJson((value as Record<string, unknown>)[key])]),
  );
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

/**
 * Whether a result answers this request's declared remedy call: the same tool
 * in the same namespace, as the request's identity resolves it. A pending
 * review is the gateway's own answer to that call, and the HITL flow handles
 * it.
 */
function isOwnControlResult(
  binding: AppaPluginBinding,
  result: { name: string; namespace?: string; content: unknown },
): boolean {
  const control = binding.request.tools?.control;
  if (!control) return false;
  const namespace =
    result.namespace ?? binding.request.tools?.namespaces?.get(result.name);
  if (namespace !== control.namespace) return false;
  if (
    binding.identity.canonicalize(result.name, namespace) !==
    binding.identity.canonicalize(control.name, control.namespace)
  )
    return false;
  return reviewRequiredOfferId(result.content, 0) === null;
}

async function pendingNativeHitlOfferIds(params: {
  binding: AppaPluginBinding;
  results: LlmProxyToolResultsContext["toolResults"];
  resolvedOfferIds: ReadonlySet<string>;
}): Promise<string[]> {
  const control = params.binding.request.tools?.control;
  if (!control) return [];
  const offerIds = new Set<string>();
  for (const result of params.results) {
    if (result.isError) continue;
    const canonicalResult = params.binding.identity.canonicalize(
      result.name,
      params.binding.request.tools?.namespaces?.get(result.name),
    );
    const canonicalControl = params.binding.identity.canonicalize(
      control.name,
      control.namespace,
    );
    const resultShortName = archestraMcpBranding.getToolShortName(result.name);
    if (
      result.name !== control.name &&
      canonicalResult !== canonicalControl &&
      resultShortName !== TOOL_EXECUTE_REMEDY_PLAN_SHORT_NAME &&
      !result.name.endsWith(TOOL_EXECUTE_REMEDY_PLAN_SHORT_NAME)
    )
      continue;
    const offerId = reviewRequiredOfferId(result, 0);
    if (offerId && !params.resolvedOfferIds.has(offerId)) offerIds.add(offerId);
  }
  const pending = await Promise.all(
    [...offerIds].map(async (offerId) => ({
      offerId,
      review: await getHitlReview({
        session: params.binding.session,
        offerId,
      }),
    })),
  );
  return pending
    .filter((entry) => entry.review !== undefined)
    .map((entry) => entry.offerId);
}

function hasRemedyOfferResult(params: {
  binding: AppaPluginBinding;
  results: LlmProxyToolResultsContext["toolResults"];
  verifiedNativeQuestionResults: ReadonlyMap<object, NativeQuestionClaim>;
}): boolean {
  let latestBlockedResult = -1;
  for (const [index, result] of params.results.entries()) {
    if (result.isError) continue;
    const content =
      typeof result.content === "string"
        ? result.content
        : JSON.stringify(result.content ?? null);
    if (
      content.includes("[appa] Blocked") &&
      content.includes("execute_remedy_plan") &&
      content.includes("offer_id")
    ) {
      latestBlockedResult = index;
    }
  }
  if (latestBlockedResult < 0) return false;

  const control = params.binding.request.tools?.control;
  for (
    let index = latestBlockedResult + 1;
    index < params.results.length;
    index++
  ) {
    const result = params.results[index];
    if (params.verifiedNativeQuestionResults.has(result)) return false;
    if (!control) continue;
    const canonicalResult = params.binding.identity.canonicalize(
      result.name,
      params.binding.request.tools?.namespaces?.get(result.name),
    );
    const canonicalControl = params.binding.identity.canonicalize(
      control.name,
      control.namespace,
    );
    if (
      result.name === control.name ||
      canonicalResult === canonicalControl ||
      archestraMcpBranding.getToolShortName(result.name) ===
        TOOL_EXECUTE_REMEDY_PLAN_SHORT_NAME ||
      result.name.endsWith(TOOL_EXECUTE_REMEDY_PLAN_SHORT_NAME)
    ) {
      return false;
    }
  }
  return true;
}

function reviewRequiredOfferId(value: unknown, depth: number): string | null {
  if (depth > 4 || value === null || value === undefined) return null;
  if (typeof value === "string") {
    try {
      return reviewRequiredOfferId(JSON.parse(value), depth + 1);
    } catch {
      for (const line of value.split(/\r?\n/)) {
        const candidate = line.trim();
        if (!candidate.startsWith("{") && !candidate.startsWith("[")) continue;
        try {
          const offerId = reviewRequiredOfferId(
            JSON.parse(candidate),
            depth + 1,
          );
          if (offerId) return offerId;
        } catch {
          // Continue past non-JSON log lines and bounded metadata.
        }
      }
      return null;
    }
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const offerId = reviewRequiredOfferId(item, depth + 1);
      if (offerId) return offerId;
    }
    return null;
  }
  if (!isRecord(value)) return null;
  if (
    value.outcome === "review_required" &&
    typeof value.offer_id === "string" &&
    value.offer_id.length > 0
  ) {
    return value.offer_id;
  }
  for (const nested of [value.structuredContent, value.content, value.text]) {
    const offerId = reviewRequiredOfferId(nested, depth + 1);
    if (offerId) return offerId;
  }
  return null;
}

function anchorConstantGuidance(params: {
  request: Record<string, unknown>;
  interactionType: string;
  guidance: string;
}): void {
  if (params.interactionType === "openai:responses") {
    if (responsesGuidancePresent(params.request, params.guidance)) return;
    appendInstruction(params.request, "instructions", params.guidance);
    return;
  }
  if (params.interactionType === "openai:chatCompletions") {
    anchorChatGuidance(params.request, params.guidance);
    return;
  }
  if (params.interactionType === "anthropic:messages") {
    anchorAnthropicGuidance(params.request, params.guidance);
  }
}

function anchorAnthropicGuidance(
  request: Record<string, unknown>,
  guidance: string,
): void {
  if (Array.isArray(request.system)) {
    if (
      request.system.some(
        (block) =>
          isRecord(block) && block.type === "text" && block.text === guidance,
      )
    ) {
      return;
    }
    request.system.push({ type: "text", text: guidance });
    return;
  }
  appendInstruction(request, "system", guidance);
}

function anchorChatGuidance(
  request: Record<string, unknown>,
  guidance: string,
): void {
  const messages = Array.isArray(request.messages)
    ? request.messages
    : undefined;
  if (
    messages?.some(
      (message) =>
        isRecord(message) &&
        (message.role === "system" || message.role === "developer") &&
        messageText(message).includes(guidance),
    )
  ) {
    return;
  }
  if (typeof request.system === "string") {
    appendInstruction(request, "system", guidance);
    return;
  }
  if (!messages) return;
  const first = messages[0];
  if (
    isRecord(first) &&
    (first.role === "system" || first.role === "developer")
  ) {
    if (typeof first.content === "string") {
      if (!first.content.includes(guidance)) {
        first.content =
          first.content.length > 0
            ? `${first.content}\n\n${guidance}`
            : guidance;
      }
      return;
    }
    if (Array.isArray(first.content)) {
      first.content.push({ type: "text", text: guidance });
      return;
    }
  }
  messages.unshift({ role: "developer", content: guidance });
}

function responsesGuidancePresent(
  request: Record<string, unknown>,
  guidance: string,
): boolean {
  if (
    typeof request.instructions === "string" &&
    request.instructions.includes(guidance)
  ) {
    return true;
  }
  if (!Array.isArray(request.input)) return false;
  return request.input.some((item) => {
    if (!isRecord(item) || item.role !== "developer") return false;
    if (typeof item.content === "string") {
      return item.content.includes(guidance);
    }
    if (!Array.isArray(item.content)) return false;
    return item.content.some(
      (block) =>
        isRecord(block) &&
        typeof block.text === "string" &&
        block.text.includes(guidance),
    );
  });
}

function messageText(message: Record<string, unknown>): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .map((block) =>
      isRecord(block) && typeof block.text === "string" ? block.text : "",
    )
    .join("\n");
}

/** Prevents Codex from converting a required HITL workflow step into prose. */
function requireCodexToolCall(params: {
  binding: AppaPluginBinding;
  context: LlmProxyBeforeModelContext;
}): void {
  if (
    params.binding.adapter?.id !== "codex" ||
    params.context.interactionType !== "openai:responses" ||
    !isRecord(params.context.request)
  ) {
    return;
  }
  // Namespace members cannot be selected individually through Responses API
  // tool_choice, so require one call and let the adjacent developer instruction
  // select the exact OpenAPPA workflow tool.
  params.context.request.tool_choice = "required";
  params.context.request.parallel_tool_calls = false;
}

function appendInstruction(
  request: Record<string, unknown>,
  key: "instructions" | "system",
  guidance: string,
): void {
  const instructions = request[key];
  if (typeof instructions === "string" && instructions.includes(guidance)) {
    return;
  }
  request[key] =
    typeof instructions === "string" && instructions.length > 0
      ? `${instructions}\n\n${guidance}`
      : guidance;
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

/**
 * Appends trajectory stamps to tool-call IDs for supported wire families.
 * Stamped IDs identify source session lineage in future turns.
 * Skips sessions that lack caller scoping, or models that truncate tool-call IDs.
 */
function trajectoryStamper(
  binding: AppaPluginBinding,
  context: Pick<
    LlmProxyRequestContext,
    "interactionType" | "provider" | "model"
  >,
):
  | ((
      call: LlmProxyToolCallsContext["toolCalls"][number],
    ) => LlmProxyToolCallsContext["toolCalls"][number])
  | undefined {
  const { session, stampSessionId } = binding;
  const callerId = session.caller_id;
  const secret = config.openappa.offerSigningSecret;
  if (
    !callerId ||
    secret.length === 0 ||
    !appaWireFamily(context.interactionType) ||
    !stampSessionId ||
    shortensToolCallIds(context)
  )
    return undefined;
  return (call) => ({
    ...call,
    wireId: stampToolCallId({
      // Compose transport stamps instead of replacing inner wire identities,
      // such as the signed native-question ID used to claim a HITL answer.
      callId: call.wireId ?? call.id,
      sessionId: stampSessionId,
      organizationId: session.organization_id,
      callerId,
      secret,
    }),
  });
}

/**
 * Returns true if the client or model truncates tool-call IDs.
 * Models from the Mistral family or using the Mistral provider truncate IDs,
 * which corrupts trajectory stamps. When adding support for a model family
 * whose IDs are too short to carry a stamp, extend
 * SHORT_TOOL_CALL_ID_MODEL_FAMILIES below.
 */
function shortensToolCallIds(
  context: Pick<LlmProxyRequestContext, "provider" | "model">,
): boolean {
  const model = context.model.toLowerCase();
  return (
    context.provider === "mistral" ||
    SHORT_TOOL_CALL_ID_MODEL_FAMILIES.some((family) => model.includes(family))
  );
}

const SHORT_TOOL_CALL_ID_MODEL_FAMILIES = [
  "mistral",
  "devstral",
  "codestral",
  "pixtral",
  "mixtral",
];

async function enforcementFor(
  trustedContext: AppaTrustedContext,
): Promise<"active" | "inactive"> {
  if (trustedContext.enforcement) return trustedContext.enforcement;
  try {
    return await readGuardrailsV2Activation();
  } catch {
    throw new ApiError(503, "Guardrails availability could not be confirmed");
  }
}

/** Returns true if this session is caller-scoped and eligible for lineage tracing. */
function tracesLineage(session: OpenAppaSession, chat: boolean): boolean {
  const callerId = session.caller_id;
  return (
    !chat &&
    callerId !== undefined &&
    session.session_id.startsWith(`${callerId}|`)
  );
}
