import { createHash, createHmac, randomBytes } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { isDeepStrictEqual } from "node:util";
import {
  AGENT_TOOL_PREFIX,
  buildElicitationMandateInstruction,
  isAgentTool,
  isYellToolShortName,
  OPENAPPA_RUNTIME_TOOL_SHORT_NAMES,
  PROXY_STAMPED_TOOL_ARGUMENTS,
  SELF_FORK_TOOL_NAME,
  slugify,
  TimeInMs,
  TOOL_ASK_USER_SHORT_NAME,
  TOOL_EXECUTE_REMEDY_PLAN_SHORT_NAME,
  TOOL_GET_REMEDY_PLANS_SHORT_NAME,
  TOOL_LIST_PEER_MESSAGES_SHORT_NAME,
  TOOL_READ_PEER_MESSAGE_SHORT_NAME,
  TOOL_START_AGENT_RUN_SHORT_NAME,
} from "@archestra/shared";
import { isOpenCodeFamilyClient } from "@archestra/shared/opencode-family";
import { archestraMcpBranding } from "@/archestra-mcp-server/branding";
import { readRunToolArgs } from "@/archestra-mcp-server/run-tool-target";
import { type AllowedCacheKey, CacheKey, cacheManager } from "@/cache-manager";
import config from "@/config";
import logger from "@/logging";
import AgentModel from "@/models/agent";
import OpenAppaSessionModel from "@/models/openappa-session";
import OpenAppaSpawnCorrelationModel, {
  type AllowedSpawnAlias,
} from "@/models/openappa-spawn-correlation";
import { reportAgentRuntimeObservedReads } from "@/observability/metrics/agent-runtime";
import { childSessionId, clientSessionId } from "@/openappa/actor";
import {
  type AppaChildReturnCompletion,
  collectAndStripChildReturns,
  mintChildReturnMarker,
} from "@/openappa/child-return";
import {
  mintChildTrajectoryReceipt,
  verifyChildTrajectoryReceipt,
} from "@/openappa/child-trajectory-receipt";
import { recordOpenAppaClientFailure } from "@/openappa/client-failure-report";
import { normalizeCommandExecutionArguments } from "@/openappa/command-normalization";
import { currentTrajectory } from "@/openappa/current-trajectory";
import {
  delegationEnabled,
  isDelegatedPrompt,
  mintDelegationMarker,
  verifyDelegatedPrompt,
} from "@/openappa/delegation";
import { recoverDiagnosticTurn } from "@/openappa/diagnostic-recovery";
import {
  askHitlReviewInForm,
  getHitlAskUserArguments,
  getHitlInspectableAskUserArguments,
  getHitlReview,
  getHitlReviewResult,
  HITL_QUESTION_TTL_MS,
  type HitlReviewOutcome,
  hitlReviewAskedInForm,
  isHitlReviewOutcome,
  peekHitlDecision,
  recordHitlRuling,
  renewHitlReview,
  resolveHitlInspectableAnswer,
  sealHitlClosure,
} from "@/openappa/hitl-review";
import {
  HITL_INSPECT_LABEL,
  hitlReviewCardAnswer,
  PREVIOUS_HITL_CARD_LABELS,
  previousHitlCardAnswer,
} from "@/openappa/hitl-review-overview";
import { buildNoticeArguments, type RemedyExecution } from "@/openappa/notice";
import {
  PEER_PROOF_ARGUMENT,
  signPeerProof,
  stripPeerProofs,
} from "@/openappa/peer-claims";
import {
  isObservedRead,
  RUNTIME_TOOL_PROOF_ARGUMENT,
  signRuntimeToolProof,
  stripRuntimeToolProofs,
} from "@/openappa/runtime-tool-claims";
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
  returnRuntimeValue,
  type SpawnReturnDeclaration,
  SUBAGENT_TOOL,
  sendPeerMessage,
  sharedPolicy,
  startRuntimeChild,
  UNDELIVERABLE_RETURN_CONTRACT,
  withCapturedGuardrailsActivation,
} from "@/openappa/service";
import {
  subagentChildSession,
  subagentReturnPrefix,
} from "@/openappa/subagent-binding";
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
import {
  type AppaWireFamily,
  appaTurnBoundaries,
  appaWireFamily,
} from "@/openappa/wire";
import {
  isReportingToolCall,
  rememberYellSession,
  reportingToolSpellings,
} from "@/openappa/yell-session";
import type {
  LlmProxyBeforeModelContext,
  LlmProxyBufferedModelResponseContext,
  LlmProxyBufferedModelResponseOutcome,
  LlmProxyHostedToolCallsContext,
  LlmProxyHostedToolCallsOutcome,
  LlmProxyModelResponseContext,
  LlmProxyPlugin,
  LlmProxyRequestContext,
  LlmProxyRuntimeToolProof,
  LlmProxyToolCallAnnotation,
  LlmProxyToolCallsContext,
  LlmProxyToolCallsOutcome,
  LlmProxyToolResultsContext,
  LlmProxyToolResultsOutcome,
} from "@/proxy/plugins/registry";
import { normalizeToolCallsForPolicy } from "@/routes/proxy/llm-proxy-helpers";
import { collectDeclaredToolNames } from "@/routes/proxy/utils/declared-tool-names";
import type { ToolNameResolution } from "@/routes/proxy/utils/gateway-tool-names";
import { pendingExports } from "@/services/agent-runtime/pending-exports";
import {
  agentRunUrl,
  submittedRunNextStep,
} from "@/services/agent-runtime/run-handle";
import { readGuardrailsV2Activation } from "@/services/guardrails-deployment";
import { ApiError, type CommonToolResult } from "@/types";
import type {
  RuntimeLaunchFailureReason,
  RuntimeLaunchOutcome,
} from "@/types/openappa-runtime-launch";
import { claudeCodeNativeChildIds } from "./adapters/claude-code";
import {
  appendPeerMessageMarker,
  escapeRelayMarkup,
} from "./adapters/claude-code-relay";
import { labeledQuestionRuling } from "./adapters/native-question-ruling";
import { openCodeReviewQuestion } from "./adapters/opencode-review";
import { nativeId, referencesChildTranscriptPath } from "./adapters/trajectory";
import { appaTrajectory } from "./session-identity";
import {
  APPA_CHILD_TRAJECTORY_RECEIPT,
  APPA_PLUGIN_TRUSTED_CONTEXT,
  type AppaChildTrajectory,
  type AppaClientAdapter,
  type AppaRelayArrival,
  type AppaRelayMessage,
  type AppaTrustedContext,
  type AskUserArguments,
  type NativeQuestionNoAnswer,
  type NativeQuestionReading,
} from "./types";
import {
  withCallerScope,
  withoutCallerScope,
  withoutRemedySections,
} from "./utils";

type AppaPluginBinding = {
  /** The request continues a provider thread that holds the system prompt. */
  threadContinue: boolean;
  /** Limits later hooks to reporting and prevents a second recovery attempt. */
  reportingRecovery?: boolean;
  session: OpenAppaSession;
  identity: AppaTrustedContext["toolIdentity"];
  adapter: AppaClientAdapter | undefined;
  request: AppaTrustedContext["request"];
  requestBody: unknown;
  runtimeSessionId?: string;
  runtimeTaskId?: string;
  sessionInitialized?: boolean;
  /** True when the model's response contained tool calls awaiting client execution. */
  turnOpen: boolean;
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
  /** Offers whose native answer could not be read; asked again in a form. */
  unreadNativeAnswerOfferIds: string[];
  /** Offers whose native answer came after their review expired; staged again on request. */
  expiredNativeQuestionOfferIds: string[];
  /** The native id this request's children will report as their parent. */
  spawnerNativeId: string | undefined;
  /** Server-bound child metadata needed to correlate its terminal return. */
  child?: AppaChildTrajectory;
  /** Child return contract for this request, injected before the provider call. */
  returnContract?: string;
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
  identity: AppaTrustedContext["toolIdentity"];
  requestBody: unknown;
};

type NativeQuestionClaim = {
  /** Exact server-issued native question, never recovered from client history. */
  askedQuestion?: string;
  offerIds?: string[];
  /** The card offered Inspect; its answers resolve inspection state. */
  inspectable?: boolean;
  /** The issued card carried the complete review in its input or preceding text. */
  reviewText?: boolean;
  /** The exact staged payload the card was issued from. */
  digest?: string;
};

type IssuedNativeQuestion = {
  askedQuestion?: string;
  id: string;
  name: string;
  offerIds: string[];
  inspectable?: boolean;
  reviewText?: boolean;
  digest?: string;
};

type RecordedNativeHitlRuling = {
  offerId: string;
  ruling: "approve" | "deny" | "none";
  reviewedTool?: string;
  reviewedArguments?: string;
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
    const teammateId = await correlatedClaudeTeammateId({
      adapters: this.clientAdapters,
      headers: context.headers,
      requestBody: context.requestBody,
      trustedContext,
    });
    const trajectory = appaTrajectory({
      adapters: this.clientAdapters,
      headers: context.headers,
      requestBody: context.requestBody,
      trustedContext: teammateId
        ? { ...trustedContext, claudeTeammateNativeId: teammateId }
        : trustedContext,
    });
    const binding: AppaPluginBinding = {
      session: trajectory.session,
      identity: trustedContext.toolIdentity,
      adapter: trajectory.adapter,
      request: trustedContext.request,
      requestBody: context.requestBody,
      runtimeSessionId: trustedContext.runtimeSessionId,
      runtimeTaskId: trustedContext.runtimeTaskId,
      turnOpen: false,
      chat,
      compaction: trustedContext.compaction === true,
      threadContinue: trustedContext.thread === "continue",
      requestHeaders: context.headers,
      requiresQuestionContinuation: false,
      requiresRemedyContinuation: false,
      pendingHitlReviewOfferIds: [],
      nativeHitlRulings: [],
      unreadNativeAnswerOfferIds: [],
      expiredNativeQuestionOfferIds: [],
      spawnerNativeId: trajectory.adapter?.nativeConversationId(
        trajectory.matchContext,
      ),
      stampSessionId: tracesLineage(trustedContext.session, chat)
        ? clientSessionId(trustedContext.session.session_id)
        : undefined,
      unenforcedCalls: { reasons: new Map(), children: new Set() },
    };
    if (trajectory.child) {
      if (teammateId && trajectory.child.lineage) {
        trajectory.child.lineage.nativeConversationId =
          trajectory.adapter?.nativeConversationId(trajectory.matchContext);
      }
      binding.child = trajectory.child;
      issueChildTrajectoryReceipt(context, binding.session, trajectory.child);
    }
    this.bindings.set(context.resources, binding);
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
    let childReturns: Awaited<ReturnType<typeof approveChildReturnCarriers>>;
    const trustedContext = context.resources.get(APPA_PLUGIN_TRUSTED_CONTEXT) as
      | AppaTrustedContext
      | undefined;
    try {
      if (trustedContext?.childReturnRefusal)
        throw trustedContext.childReturnRefusal;
      childReturns = await approveChildReturnCarriers({ binding, results });
    } catch (error) {
      const family = appaWireFamily(context.interactionType);
      const recovery =
        (error instanceof ChildReturnRefusal ||
          (error instanceof ApiError &&
            error === trustedContext?.childReturnRefusal)) &&
        family &&
        !binding.threadContinue &&
        !binding.reportingRecovery
          ? recoverDiagnosticTurn({
              body: binding.requestBody,
              family,
              refusal: error.message,
              tools: reportingToolSpellings({
                identity: binding.identity,
                declarations: binding.request.declaredTools,
                nativeQuestion: binding.adapter?.nativeQuestion?.toolName,
              }),
              isAllowedCall: (call) =>
                isReportingToolCall({
                  call,
                  resolution: this.resolution(binding),
                  nativeQuestion: binding.adapter?.nativeQuestion?.toolName,
                }),
            })
          : undefined;
      // Off an OpenAPPA wire, the reporting turn cannot run, so the refusal
      // does not offer it.
      if (!family) throw withoutReportingRecovery(error);
      if (!recovery) throw error;
      binding.reportingRecovery = true;
      if (trustedContext) trustedContext.childReturnRefusal = undefined;
      Object.assign(binding.request, {
        // Any malformed frame left after filtering must fail closed here.
        childReturns: collectAndStripChildReturns(binding.requestBody, {
          openCodeBackgroundReturns:
            !!binding.adapter && isOpenCodeFamilyClient(binding.adapter.id),
          codexMailboxReturns: binding.adapter?.id === "codex",
        }),
        promptOperationId: undefined,
        ...appaTurnBoundaries({ family, body: binding.requestBody }),
      });
      // reportingRecovery prevents this filtered pass from recovering again.
      return this.onToolResults({
        ...context,
        toolResults: context.toolResults.filter((result) =>
          recovery.resultIds.has(result.id),
        ),
      });
    }
    Object.assign(childResultUpdates, childReturns.updates);
    const governed = this.governedSession(binding);
    await admitRelayReports({
      binding,
      session: governed,
      results,
      updates: childResultUpdates,
    });
    // Requests with results submit them even if this request declares no tools.
    // A root that declared nothing has nothing to submit. A bound child still
    // starts, so its return contract is delivered before inference.
    if (
      !governed.parent_id &&
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
    const nativeAnswers = await recordNativeHitlRulings({
      binding,
      verifiedNativeQuestionResults,
    });
    binding.nativeHitlRulings = nativeAnswers.rulings;
    // An unread answer leaves its review pending. Its own guidance asks again.
    binding.unreadNativeAnswerOfferIds = nativeAnswers.unreadOfferIds;
    // An answer whose review expired is no ruling. Its own guidance has the
    // review staged again.
    binding.expiredNativeQuestionOfferIds = nativeAnswers.expiredOfferIds;
    // An inspect answer asks for the same card again. The instruction rides
    // the answer's own result text, so the request's earlier messages stay
    // byte-identical across turns.
    const continuedReviewUpdates: Record<string, string> = Object.create(null);
    for (const continuation of nativeAnswers.continued) {
      const instruction = continuedReviewInstruction({ binding, continuation });
      continuedReviewUpdates[continuation.resultId] = instruction;
      // The client re-sends this answer with every later request, and its
      // one-use claim is gone by then: the instruction it read must come from
      // here, byte-identical, or the model's earlier history changes. The
      // entry outlives the review, whose close deletes nothing here.
      try {
        await cacheManager.set(
          hitlReviewContinuationKey({
            session: governed,
            resultId: continuation.resultId,
          }),
          instruction,
          TimeInMs.Day,
        );
      } catch {
        logger.warn("OpenAPPA could not retain a review continuation");
      }
    }
    // Answers this request re-sends from its history read what they read when
    // they were answered: replaying never claims, rules, or opens an inspection.
    const replayedReviewUpdates = await replayedReviewContinuations({
      binding,
      results: toolResults,
      answered: continuedReviewUpdates,
    });
    binding.pendingHitlReviewOfferIds = await pendingNativeHitlOfferIds({
      binding,
      results: toolResults,
      resolvedOfferIds: new Set([
        ...binding.nativeHitlRulings.map((entry) => entry.offerId),
        ...nativeAnswers.unreadOfferIds,
        ...nativeAnswers.continued.map((entry) => entry.offerId),
        ...nativeAnswers.expiredOfferIds,
      ]),
    });
    // A handback's result and a message's delivery receipt are the client's
    // acknowledgements of calls the runtime already governed as crossings. A
    // child return that OpenAPPA ignores never reaches the runtime.
    await withholdUnrecordedPeerReads({
      binding,
      session: governed,
      results,
      updates: childResultUpdates,
    });
    const runtimeSpawns = await releasedRuntimeSpawns({
      binding,
      session: governed,
      toolResults,
    });
    const subagentReturns = await admitSubagentReturns({
      session: governed,
      spawnIds: runtimeSpawns,
    });
    const runtimeLaunches = await OpenAppaSpawnCorrelationModel.runtimeLaunches(
      {
        organizationId: governed.organization_id,
        callerId: governed.caller_id,
        sessionId: governed.session_id,
        toolCallIds: [...runtimeSpawns],
      },
    );
    // An undeclared call or one whose annotator gave no answer never ran, and
    // the runtime has no record of it. Restore the host-held notice instead of
    // accepting client text or ruling on it as an executed call.
    const unansweredNotices = new Map<string, string>();
    for (const answer of results) {
      const notice = await cacheManager.get<string>(
        unansweredNoticeKey({ session: governed, callId: answer.id }),
      );
      if (typeof notice === "string") unansweredNotices.set(answer.id, notice);
    }
    // The runtime withholds the output of a spawn that failed. What the gateway
    // recorded about the launch is not that output, so it is restored after.
    const failedLaunchResults: Record<string, string> = {};
    const nonHandbackResults = results
      .filter(
        (result) =>
          !binding.adapter?.isChildHandbackTool?.(result.name) &&
          !binding.adapter?.isRelayTool?.(result.name) &&
          !isPeerInboxResult(binding, result.name, result.namespace) &&
          !childReturns.ignored.has(result.id) &&
          !unansweredNotices.has(result.id),
      )
      // An answer to an issued question is recognized as the very result the
      // client sent, so a result nothing rewrote goes on as that object.
      .map((result) => {
        const subagentReturn = subagentReturns.get(
          withoutTrajectoryStamp(result.id),
        );
        if (subagentReturn !== undefined) {
          childResultUpdates[result.id] = subagentReturn;
          return { ...result, content: subagentReturn };
        }
        if (runtimeSpawns.has(withoutTrajectoryStamp(result.id))) {
          const launch = runtimeLaunches.get(withoutTrajectoryStamp(result.id));
          const content = runtimeLaunchResult(launch);
          childResultUpdates[result.id] = content;
          if (launch?.kind === "failed")
            failedLaunchResults[result.id] = content;
          return { ...result, content };
        }
        const content = childResultUpdates[result.id];
        return content === undefined ? result : { ...result, content };
      });
    const result = await processProxyResults({
      session: governed,
      results: nonHandbackResults,
      canonicalize: (name: string, namespace?: string) =>
        this.canonicalize(binding, { name, namespace }),
      isUserQuestion: (answer) => isUserQuestionResult({ binding, answer }),
      classifySpawnResult: (answer) => {
        // Recorded above as the spawn's result: nothing more to approve.
        if (subagentReturns.has(withoutTrajectoryStamp(answer.id))) {
          return "pending";
        }
        if (runtimeSpawns.has(withoutTrajectoryStamp(answer.id))) {
          const launch = runtimeLaunches.get(withoutTrajectoryStamp(answer.id));
          if (launch) return launch.kind === "launched" ? "pending" : "failed";
          return answer.isError ? "failed" : "pending";
        }
        if (!binding.adapter?.isSpawnTool(answer.name, answer.namespace))
          return undefined;
        if (binding.request.restoredNoticeCallIds?.has(answer.id))
          return "pending";
        if (childReturns.failedSpawns.has(answer.id)) return "failed";
        return (
          binding.adapter.classifySpawnResult?.(answer) ??
          (answer.isError ? "failed" : "pending")
        );
      },
      controlToolName:
        binding.request.tools?.control.name ??
        binding.request.historicalControlToolName,
      isControlResult: (answer) => isOwnControlResult(binding, answer),
      pendingReviewResult: (answer) => pendingReviewResult(binding, answer),
      trustedChat: binding.chat,
      deliverReturnContract: (text) => {
        binding.returnContract = text;
      },
    });
    for (const [index, answer] of context.toolResults.entries()) {
      if (result.toolResultUpdates[answer.id]?.code !== "unreleased_call")
        continue;
      logger.info(
        {
          sessionId: governed.session_id,
          callerId: governed.caller_id,
          toolCallId: answer.id,
          thread: trustedContext?.thread ?? "none",
          // 0 for the request's last tool result; above 0 for one the client
          // replays from earlier in its history.
          laterResults: context.toolResults.length - 1 - index,
        },
        "OpenAPPA has no record of releasing the call this tool result answers",
      );
    }
    for (const [id, notice] of unansweredNotices)
      result.toolResultUpdates[id] = {
        content: notice,
        outputSource: "runtime",
        denied: true,
      };
    const carriedKeys = toolResults.map((answer) =>
      carriedRulingKey({
        session: this.governedSession(binding),
        callId: answer.id,
      }),
    );
    const carriedRulings = binding.adapter?.answersUndeclaredCalls
      ? await cacheManager.getMany<string>(carriedKeys)
      : new Map<AllowedCacheKey, string>();
    for (const [index, answer] of toolResults.entries()) {
      // Read, not consumed: the client sends this result on every later
      // request, and the model must read the same text each time.
      const ruling = await cacheManager.get<string>(
        notLoadedRulingKey({
          session: this.governedSession(binding),
          callId: answer.id,
        }),
      );
      if (ruling !== undefined && ruling !== null) {
        result.toolResultUpdates[answer.id] = {
          content: ruling,
          outputSource: "runtime",
          denied: true,
        };
      }
      const approved = result.toolResultUpdates[answer.id];
      if (approved?.denied) {
        const clarification = await cacheManager.get<string>(
          deniedCallClarificationKey({
            session: this.governedSession(binding),
            callId: answer.id,
          }),
        );
        if (clarification) approved.content += clarification;
        if (approved.offers?.length === 0 && !approved.review?.length) {
          approved.content += NO_REMEDY_PLAN_HINT;
        }
      }
      // Already complete, and with no plan this client could act on.
      const carried = carriedRulings.get(carriedKeys[index]);
      if (typeof carried === "string")
        result.toolResultUpdates[answer.id] = {
          content: carried,
          outputSource: "runtime",
          denied: true,
          offers: [],
        };
    }
    binding.requiresRemedyContinuation = await hasRemedyOfferResult({
      binding,
      results: toolResults,
      toolResultUpdates: result.toolResultUpdates,
      verifiedNativeQuestionResults,
    });
    if (result.returnContract) {
      binding.returnContract = result.returnContract;
    }
    binding.sessionInitialized = true;
    const waitTool = binding.adapter?.pendingServersTool;
    // A ruling in the result of the client's wait tool is a denial that tool
    // carried: the model made another call there, and has to be told so.
    const carriedDenials = new Map(
      toolResults.flatMap((answer) =>
        answer.name === waitTool &&
        !answer.namespace &&
        result.toolResultUpdates[answer.id]?.denied &&
        !binding.request.restoredNoticeCallIds?.has(answer.id)
          ? [[answer.id, answer] as const]
          : [],
      ),
    );
    const toolResultUpdates = {
      ...childResultUpdates,
      ...Object.fromEntries(
        Object.entries(result.toolResultUpdates).map(([id, result]) => {
          const wait = carriedDenials.get(id);
          return [
            id,
            wait
              ? `[appa] OpenAPPA sent this ${waitTool} call in place of the tool call you made. Your call did not run. The remedy tools were still loading, so the client waited for them.${waitFailure(wait)} The ruling on your call follows.\n\n${result.content}`
              : result.content,
          ];
        }),
      ),
      ...failedLaunchResults,
      // Inspect answers are the platform's own instruction to re-ask for the
      // same card; they replace the client's answer text entirely.
      ...continuedReviewUpdates,
      ...replayedReviewUpdates,
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
          }),
      )
    ) {
      binding.requiresQuestionContinuation = true;
    }
    return {
      // Use runtime-approved output for tool results.
      toolResultUpdates,
    };
  }

  async onBeforeModel(context: LlmProxyBeforeModelContext): Promise<void> {
    const binding = this.bindings.get(context.resources);
    if (binding) enterCapturedGuardrailsActivation("active");
    binding?.adapter?.stripCarrierMetadata(context.request);
    stripPeerProofs(context.request);
    stripRuntimeToolProofs(context.request);
    // A compaction summarizes the history, so an unchecked message would
    // survive into the summary: messages are admitted before either turn.
    if (binding) {
      if (binding.session.parent_id && !binding.sessionInitialized) {
        const started = await startRuntimeChild({
          session: this.governedSession(binding),
        });
        binding.returnContract = started.contract ?? binding.returnContract;
        binding.sessionInitialized = true;
      }
      if (binding.returnContract && !binding.threadContinue) {
        deliverReturnContract({
          request: context.request,
          interactionType: context.interactionType,
          contract: binding.returnContract,
        });
      }
      await admitRelayArrivals({
        binding,
        session: this.governedSession(binding),
        request: context.request,
      });
      if (binding.runtimeSessionId === binding.session.session_id) {
        // A runtime has no tool call open here: its results are in and its
        // next calls are not out. Files its parent pinned while it was busy
        // can cross now.
        await pendingExports.drain(this.governedSession(binding));
      }
    }
    if (binding?.compaction) return;
    if (binding?.adapter?.id === "codex") {
      appendNativeDelegationGuidance(context);
    }
    if (binding && binding.adapter?.id !== "archestra-chat") {
      if (binding.request.tools?.control) {
        insertRequestGuidance({
          request: context.request,
          interactionType: context.interactionType,
          guidance: EXTERNAL_REMEDY_WORKFLOW_GUIDANCE,
          onContinue: binding.threadContinue ? "skip" : undefined,
        });
      }
      const askUser = binding.request.tools?.askUser;
      // Name the native question tool only when asNativeQuestion would send
      // ask_user to it. Otherwise the model calls a tool that cannot return
      // the user's answer, and then asks again in prose.
      const nativeQuestion =
        binding.adapter?.nativeQuestion &&
        binding.adapter.nativeQuestion.isAvailable?.(binding.requestHeaders) !==
          false &&
        declaresNativeQuestion(binding, binding.adapter.nativeQuestion.toolName)
          ? binding.adapter.nativeQuestion.toolName
          : undefined;
      const askUserTool = askUser?.name;
      if (askUserTool || nativeQuestion) {
        insertRequestGuidance({
          request: context.request,
          interactionType: context.interactionType,
          guidance: buildElicitationMandateInstruction({
            askUserToolName: askUserTool,
            nativeQuestionToolName: nativeQuestion,
          }),
          onContinue: binding.threadContinue ? "skip" : undefined,
        });
      }
    }
    if (binding && binding.unreadNativeAnswerOfferIds.length > 0) {
      const offerIds = binding.unreadNativeAnswerOfferIds;
      binding.unreadNativeAnswerOfferIds = [];
      appendQuestionContinuation({
        request: context.request,
        interactionType: context.interactionType,
        guidance: unreadNativeAnswerGuidance(offerIds),
        onContinue: binding.threadContinue ? "turn" : undefined,
      });
      requireCodexToolCall({ binding, context });
    }
    if (binding && binding.expiredNativeQuestionOfferIds.length > 0) {
      const offerIds = binding.expiredNativeQuestionOfferIds;
      binding.expiredNativeQuestionOfferIds = [];
      appendQuestionContinuation({
        request: context.request,
        interactionType: context.interactionType,
        guidance: expiredNativeQuestionGuidance(offerIds),
        onContinue: binding.threadContinue ? "turn" : undefined,
      });
      requireCodexToolCall({ binding, context });
    }
    if (binding && binding.pendingHitlReviewOfferIds.length > 0) {
      const offerIds = binding.pendingHitlReviewOfferIds;
      binding.pendingHitlReviewOfferIds = [];
      appendQuestionContinuation({
        request: context.request,
        interactionType: context.interactionType,
        guidance: hitlQuestionGuidance(offerIds),
        onContinue: binding.threadContinue ? "turn" : undefined,
      });
      requireCodexToolCall({ binding, context });
    }
    if (binding?.requiresRemedyContinuation) {
      binding.requiresRemedyContinuation = false;
      appendQuestionContinuation({
        request: context.request,
        interactionType: context.interactionType,
        guidance: REMEDY_OFFER_CONTINUATION_GUIDANCE,
        onContinue: binding.threadContinue ? "turn" : undefined,
      });
      requireCodexToolCall({ binding, context });
    }
    if (binding && binding.nativeHitlRulings.length > 0) {
      const rulings = binding.nativeHitlRulings;
      binding.requiresQuestionContinuation = false;
      appendQuestionContinuation({
        request: context.request,
        interactionType: context.interactionType,
        guidance: hitlDecisionGuidance(rulings),
        onContinue: binding.threadContinue ? "turn" : undefined,
      });
      if (rulings.some((entry) => entry.ruling === "approve")) {
        requireCodexToolCall({ binding, context });
      }
    }
    if (binding?.requiresQuestionContinuation) {
      appendQuestionContinuation({
        request: context.request,
        interactionType: context.interactionType,
        onContinue: binding.threadContinue ? "turn" : undefined,
      });
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
  }

  async onPrepareToolCalls(
    context: LlmProxyToolCallsContext,
  ): Promise<LlmProxyToolCallsOutcome | undefined> {
    const binding = this.bindings.get(context.resources);
    if (!binding) return;
    enterCapturedGuardrailsActivation("active");
    const tools = binding.request.tools;
    // Ordinary questions are identified by their actual client call/result
    // frames. Only a pending review needs a proxy-issued, one-use binding.
    if (!tools) return;
    const illegalSpawn = unsupportedNativeSpawn(
      binding,
      binding.reportingRecovery
        ? context.toolCalls.filter((call) =>
            isReportingToolCall({
              call,
              resolution: this.resolution(binding),
              nativeQuestion: binding.adapter?.nativeQuestion?.toolName,
            }),
          )
        : context.toolCalls,
    );
    if (illegalSpawn) {
      const message = illegalSpawnFeedback(illegalSpawn);
      return {
        decision: "refuse",
        refusal: {
          refusalMessage: message,
          contentMessage: message,
          reason: "openappa_invalid_spawn_arguments",
          blockedToolName: illegalSpawn.name,
          blockedToolId: illegalSpawn.id,
          toolInput: { rejectedFields: illegalSpawn.fields },
          allToolCallNames: context.toolCalls.map((call) => call.name),
        },
      };
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
    if (binding.reportingRecovery)
      binding.nativeHitlRulings = binding.nativeHitlRulings.filter((entry) =>
        isReportingReviewTool(entry.reviewedTool),
      );
    if (binding.nativeHitlRulings.length > 0) {
      const blocked = context.toolCalls[0];
      if (!blocked) return;
      const rejected = binding.nativeHitlRulings.filter(
        (entry) => entry.ruling !== "approve",
      );
      const rejectedCall = incomingToolCalls.find((call) => {
        const [target] = normalizeToolCallsForPolicy(
          [call],
          this.resolution(binding),
        );
        return rejected.some((entry) => {
          if (
            isSpecialToolMember(binding, call, "control") &&
            toolInputOf(call.arguments).offer_id === entry.offerId
          )
            return true;
          // An incomplete server-issued review cannot identify an independent
          // action safely. Otherwise only the exact reviewed action is blocked.
          if (!entry.reviewedTool) return true;
          if (target.toolCallName !== entry.reviewedTool) return false;
          if (!entry.reviewedArguments) return true;
          try {
            return isDeepStrictEqual(
              normalizeCommandExecutionArguments(
                target.toolCallName,
                JSON.parse(target.toolCallArgs),
              ),
              JSON.parse(entry.reviewedArguments),
            );
          } catch {
            return true;
          }
        });
      });
      if (rejectedCall) {
        const message =
          "The human did not approve this OpenAPPA review. Keep the dependent tool call blocked.";
        return {
          decision: "refuse",
          refusal: {
            refusalMessage: message,
            contentMessage: message,
            reason: "openappa_hitl_not_approved",
            blockedToolName: rejectedCall.name,
            blockedToolId: rejectedCall.id,
            toolInput: toolInputOf(rejectedCall.arguments),
            allToolCallNames: context.toolCalls.map((call) => call.name),
          },
        };
      }
      const approvedRulings = binding.nativeHitlRulings.filter(
        (entry) => entry.ruling === "approve",
      );
      if (approvedRulings.length > 0) {
        if (approvedRulings.length !== 1) {
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
        const approved = approvedRulings[0];
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
    }
    const claimedOfferIds = new Set<string>();
    const issuedNativeQuestions: IssuedNativeQuestion[] = [];
    const toolCalls: Array<(typeof context.toolCalls)[number]> = [];
    for (const call of incomingToolCalls) {
      // The declared control tool itself, in its own namespace: a same-named
      // tool of another server gets no receipt. The acting run always comes
      // from this request, never from an offer in replayed history.
      if (isSpecialToolMember(binding, call, "control")) {
        const stamped = stampControlExecution(call, binding.session);
        changed ||= stamped !== call;
        toolCalls.push(stamped);
        continue;
      }
      let prepared = call;
      let offerIds: string[] = [];
      let askedInForm = false;
      let reviewText: string | undefined;
      let inspectableReview = false;
      let reviewDigest: string | undefined;
      let askedQuestion: string | undefined;
      if (
        isSpecialToolMember(binding, call, "askUser") &&
        archestraMcpBranding.getToolShortName(
          this.canonicalize(binding, call),
        ) === TOOL_ASK_USER_SHORT_NAME
      ) {
        const stamped = stampAskUserTrajectory(
          call,
          binding.session,
          claimedOfferIds,
        );
        prepared = stamped.call;
        offerIds = stamped.offerIds;
        // A review whose native answer could not be read stays on the gateway,
        // whose form returns the choice as data; it never offers Inspect.
        askedInForm =
          offerIds.length > 0 &&
          (await hitlReviewAskedInForm({ session: binding.session, offerIds }));
        const canonical = await canonicalizeHitlAskUserCall({
          binding,
          call: prepared,
          offerIds,
          inspectable:
            !askedInForm &&
            inspectsNatively(binding, context.canShowToolCallReview === true),
        });
        if (canonical.invalidOfferCount || canonical.reviewUnavailable) {
          const message = canonical.reviewUnavailable
            ? "The pending approval review changed or expired before its card could be issued. Request the current review again; no permission was granted."
            : "Submit each pending OpenAPPA HITL offer in a separate ask_user call.";
          return {
            decision: "refuse",
            refusal: {
              refusalMessage: message,
              contentMessage: message,
              reason: canonical.reviewUnavailable
                ? "openappa_hitl_review_unavailable"
                : "openappa_hitl_offer_count",
              blockedToolName: call.name,
              blockedToolId: call.id,
              toolInput: toolInputOf(call.arguments),
              allToolCallNames: context.toolCalls.map((item) => item.name),
            },
          };
        }
        prepared = canonical.call;
        offerIds = canonical.offerIds;
        reviewText = canonical.reviewText;
        inspectableReview = canonical.inspectable === true;
        reviewDigest = canonical.digest;
        askedQuestion = canonical.askedQuestion;
        changed ||= prepared !== call;
      }
      // Before any policy sees it: the call the policies rule on is the one
      // the client will run.
      const nativeQuestion = askedInForm
        ? prepared
        : this.asNativeQuestion(binding, prepared, offerIds.length > 0);
      changed ||= nativeQuestion !== prepared;
      prepared = nativeQuestion;
      const issued =
        offerIds.length > 0
          ? withNativeQuestionId(binding, prepared)
          : undefined;
      if (issued) {
        prepared = issued.call;
        // Claude's complete review precedes the card as assistant text.
        // OpenCode-family clients carry it in the bound question input instead.
        if (reviewText && !askedQuestion)
          prepared = { ...prepared, reviewDetails: reviewText };
        issuedNativeQuestions.push({
          ...issued.question,
          offerIds,
          ...(inspectableReview ? { inspectable: true } : {}),
          ...(reviewDigest ? { digest: reviewDigest } : {}),
          ...(askedQuestion ? { askedQuestion } : {}),
          ...(reviewText ? { reviewText: true } : {}),
        });
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
    const decisions = binding.reportingRecovery
      ? calls.map(() => ({
          kind: "hold" as const,
          feedback:
            "OpenAPPA blocked this conversation. Only reporting tools and their approval flow may run; this operation did not run.",
        }))
      : await withCapturedGuardrailsActivation("active", () =>
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
      // A call is signed only once the record that this session made it
      // exists: that record is what the gateway checks an observed proof by.
      const recorded = await recordObservedCalls(observer, context.toolCalls);
      return signObservedRuntimeCalls(observer, context.toolCalls, recorded);
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
    const blockedTranscriptCalls = new Set<string>(
      binding.reportingRecovery
        ? calls
            .filter(
              (call) =>
                !isReportingToolCall({
                  call,
                  resolution: this.resolution(binding),
                  nativeQuestion: binding.adapter?.nativeQuestion?.toolName,
                }),
            )
            .map((call) => call.id)
        : [],
    );
    if (binding.reportingRecovery) {
      for (const call of calls) {
        if (blockedTranscriptCalls.has(call.id)) continue;
        const [target] = normalizeToolCallsForPolicy(
          [call],
          this.resolution(binding),
        );
        if (
          archestraMcpBranding.getToolShortName(target.toolCallName) !==
          TOOL_EXECUTE_REMEDY_PLAN_SHORT_NAME
        )
          continue;
        const offerId = toolInputOf(target.toolCallArgs).offer_id;
        try {
          const tool =
            typeof offerId === "string"
              ? ((await getHitlReview({ session: binding.session, offerId }))
                  ?.tool ??
                (
                  await loadOfferReview({
                    organizationId: binding.session.organization_id,
                    sessionId: binding.session.session_id,
                    offerId,
                  })
                )?.tool)
              : undefined;
          if (!isReportingReviewTool(tool)) blockedTranscriptCalls.add(call.id);
        } catch (error) {
          logger.warn(
            {
              err: error,
              sessionId: binding.session.session_id,
              callId: call.id,
            },
            "OpenAPPA withheld a reporting remedy because its review could not be loaded",
          );
          blockedTranscriptCalls.add(call.id);
        }
      }
    }
    if (binding.adapter) {
      for (const call of calls) {
        if (blockedTranscriptCalls.has(call.id)) continue;
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
    const runtimeCalls = await resolveRuntimeCalls({
      organizationId: binding.session.organization_id,
      calls: calls.filter((call) => !blockedTranscriptCalls.has(call.id)),
      resolution: this.resolution(binding),
    });
    const evaluateOptions = {
      spawnCallIds: new Set(
        [...runtimeCalls].filter(([, call]) => call.spawn).map(([id]) => id),
      ),
      declareSpawnReturn: (call: { id: string }) =>
        delegationReturnDeclaration(runtimeCalls.get(call.id)),
      ...this.resolution(binding),
      isUserQuestion: (name: string, namespace?: string) => {
        const tools = binding.request.tools;
        if (tools?.platformToolNames?.has(name)) {
          return isSpecialToolMember(binding, { name, namespace }, "askUser");
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
      supportsDelegation:
        [...runtimeCalls.values()].some((call) => call.spawn) ||
        (binding.adapter !== undefined && !binding.chat),
      ...(binding.request.tools
        ? {
            control: binding.request.tools.control,
            notice: binding.request.tools.notice,
            controlAliases: binding.request.tools.controlAliases,
            noticeAliases: binding.request.tools.noticeAliases,
          }
        : {}),
    };
    // A session that defers tools can name one it never loaded, and the client
    // may still run it. Its declaration, and with it the attestation that
    // gives a gateway tool its identity, is not on this request, so a rule on
    // that tool might not match the name it arrives under. Such a call is
    // refused with the way to load it, never ruled on under a weaker name.
    const notLoaded = new Map<string, string>();
    if (binding.request.defersTools) {
      for (const call of calls) {
        if (handbackIds.has(call.id) || isDeclaredCall(binding, call)) continue;
        notLoaded.set(call.id, notLoadedFeedback({ binding, call }));
      }
    }
    const relayCandidates = calls.filter(
      (call) =>
        !notLoaded.has(call.id) &&
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
        notLoaded.has(call.id) ||
        handbackIds.has(call.id) ||
        blockedTranscriptCalls.has(call.id) ||
        reusedNames.has(call.id) ||
        relays.has(call.id) ||
        !isPeerInboxCall(binding, call.name, call.namespace)
      ) {
        continue;
      }
      peerInbox.set(call.id, stampPeerInboxCall({ binding, call, session }));
    }
    const rest = calls.filter(
      (call) =>
        !notLoaded.has(call.id) &&
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
    for (const [id, decision] of decisionById) {
      // Only the notice of this call runs. The runtime holds no record of the
      // call, so the result the client sends back is answered from here and
      // never ruled on as a call that ran.
      if (decision.kind === "deny" && decision.unanswered)
        await cacheManager.set(
          unansweredNoticeKey({ session, callId: id }),
          decision.feedback,
          TimeInMs.Day,
        );
    }
    for (const [id, feedback] of notLoaded) {
      decisionById.set(id, { kind: "deny", feedback });
      // The runtime holds no record of this call, so the result the client
      // sends back for it is answered from here.
      await cacheManager.set(
        notLoadedRulingKey({ session, callId: id }),
        feedback,
        TimeInMs.Day,
      );
    }
    for (const id of blockedTranscriptCalls) {
      decisionById.set(id, {
        kind: "deny",
        feedback: binding.reportingRecovery
          ? "OpenAPPA blocked this conversation. Only reporting tools and their approval flow may run; this operation did not run."
          : "OpenAPPA withheld raw child transcript access; use the verified child completion instead",
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
    // Resolved once for the batch, by the first denial that has no notice tool.
    let pendingServersTool: Promise<string | undefined> | undefined;
    const blocked: { id: string; name: string; reason: string }[] = [];
    const rewritten: { id: string; name: string }[] = [];
    const annotated: LlmProxyToolCallAnnotation[] = [];
    const runtimeProofs: LlmProxyRuntimeToolProof[] = [];
    const mint = this.delegationMinter(
      binding,
      { ...context, toolCalls: calls },
      session,
    );
    const released: ToolCall[] = [];
    for (const call of calls) {
      if (handbackIds.has(call.id)) {
        const handback = await admitChildHandback({ binding, call });
        rewritten.push({ id: call.id, name: call.name });
        // The rewritten call carries the admitted return. Claude Code takes a
        // report only through this call, so it must reach the client as a
        // call, streamed or not; text in its place is an undelivered report.
        released.push(handback.call);
        continue;
      }
      const inbox = peerInbox.get(call.id);
      if (inbox?.kind === "release") {
        if (inbox.call !== call) {
          rewritten.push({ id: call.id, name: call.name });
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
          rewritten.push({ id: call.id, name: call.name });
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
        const runtime = runtimeCalls.get(call.id);
        if (runtime) {
          const proof = signRuntimeToolProof({
            session,
            toolCallId: withoutTrajectoryStamp(call.id),
            action: runtime.action,
            arguments: runtime.args,
            spawn: runtime.spawn,
            secret: config.openappa.offerSigningSecret,
          });
          if (!proof)
            throw new ApiError(
              503,
              "OpenAPPA could not protect this runtime call",
            );
          runtimeProofs.push({
            id: call.id,
            name: call.name,
            action: runtime.action,
            session,
            spawn: runtime.spawn,
            wrapped: runtime.wrapper !== undefined,
          });
          released.push(signedCall({ call, runtime, proof }));
          continue;
        }
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
      let clarification = "";
      if (identity.dispatch) {
        const namespace = call.namespace
          ? ` in wire namespace ${JSON.stringify(call.namespace)}`
          : "";
        clarification = `\n\n[appa] This call already went through the run_tool wrapper ${JSON.stringify(identity.dispatch)}${namespace}, with tool_name targeting ${JSON.stringify(identity.name)}. Calling the target directly or retrying the same wrapper call is the same blocked call, not a routing correction.`;
      }
      // Only a recorded policy denial can establish that no remedy is offered.
      // Local failures and pending reviews retain their own recovery guidance.
      const noPlan =
        decision.recorded === true &&
        decision.offers?.length === 0 &&
        !decision.review?.length;
      const ruling =
        decision.feedback + clarification + (noPlan ? NO_REMEDY_PLAN_HINT : "");
      if (decision.recorded && clarification) {
        // The next request restores the runtime's ruling, not the client's
        // notice result. Retain only our addition; never replace that ruling.
        try {
          await cacheManager.set(
            deniedCallClarificationKey({ session, callId: call.id }),
            clarification,
            TimeInMs.Day,
          );
        } catch {
          // Ancillary prose must not interrupt a ruled batch or its cancellation.
          logger.warn("OpenAPPA could not retain denial clarification");
        }
      }
      if (!notice) {
        // The client's own wait tool stands in for the notice tool. The call
        // keeps its id, the client waits for its MCP servers instead of
        // running it, and the runtime answers that id's result with its
        // ruling, so the next request can declare the remedy tools. The wait
        // tool takes no arguments and its output never reaches the model. A
        // denial the runtime did not record has no ruling to answer with, so
        // it is refused below.
        let wait: string | undefined;
        if (decision.recorded) {
          pendingServersTool ??= this.pendingServersTool(binding, session);
          wait = await pendingServersTool;
        }
        if (wait && call.name !== wait) {
          blocked.push({
            id: call.id,
            name: call.name,
            reason: decision.feedback,
          });
          released.push({ id: call.id, name: wait, arguments: "{}" });
          continue;
        }
        // Clients connect MCP servers in the background, so a session's first
        // request often leaves before the gateway's tool list arrives. One
        // resend normally carries the tools; only a repeat within the same
        // session is a client that cannot receive remedies.
        const admitted = rest.flatMap((each) =>
          decisionById.get(each.id)?.kind === "allow" ? [each.id] : [],
        );
        let transient: boolean;
        try {
          transient =
            !binding.request.defersTools &&
            binding.request.declaredTools.length > 0 &&
            !(await this.remedyToolsMissingBefore(session));
          // A client that defers tools has not failed to receive remedies: it
          // has not loaded the tools yet.
          if (!transient && !binding.request.defersTools) {
            await recordOpenAppaClientFailure({
              session,
              toolCallId: call.id,
              ruling: decision.feedback,
            });
          }
        } catch (error) {
          // The batch never reaches the client, so its admitted calls never run.
          await cancelCalls(session, admitted, policy);
          throw error;
        }
        // A call that only needs loading gets that one instruction. A client
        // that defers tools can still load the remedy tools and act on the
        // plans. Any other session cannot act on them, so the ruling loses its
        // plan and delegation sections: the model would otherwise pass them
        // on to the person as options.
        // A ruling with no plan can still advise a subagent route, which the
        // runtime renders whether or not it offers a plan; here it is cut too.
        const contentMessage = notLoaded.has(call.id)
          ? decision.feedback
          : binding.request.defersTools
            ? noPlan
              ? ruling
              : `${ruling}\n\n[appa] This client defers tools it has not loaded, and the ${archestraMcpBranding.serverName} MCP gateway remedy tools are not loaded in this session, so the ruling could not be offered as a remedy and the call is refused. Search for ${TOOL_GET_REMEDY_PLANS_SHORT_NAME} and ${TOOL_EXECUTE_REMEDY_PLAN_SHORT_NAME} with your tool search, then call the denied tool again to receive the remedy.`
            : noPlan
              ? `${withoutRemedySections(decision.feedback)}${clarification}${NO_REMEDY_PLAN_HINT}`
              : `${withoutRemedySections(decision.feedback)}${clarification}\n\n${remedylessRefusalNote({ binding, transient })}`;
        // The ruling reaches the model as the result of an undeclared notice
        // call. The client answers it with an error, and the next request
        // restores the denied call and the ruling from the call's arguments.
        const carrier = await this.undeclaredNoticeCarrier({
          binding,
          context,
          session,
          callId: call.id,
          ruling: contentMessage,
        });
        if (carrier) {
          blocked.push({
            id: call.id,
            name: call.name,
            reason: decision.feedback,
          });
          released.push({
            id: call.id,
            name: carrier,
            arguments: JSON.stringify(
              buildNoticeArguments({
                id: call.id,
                tool: identity.name,
                arguments: identity.arguments,
                result: contentMessage,
                custom: identity.custom,
                namespace: identity.namespace,
              }),
            ),
          });
          continue;
        }
        // Refuses the call and cancels admitted calls when the client declares no notice tool.
        await cancelCalls(session, admitted, policy);
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
            result: ruling,
            custom: identity.custom,
            namespace: identity.namespace,
          }),
        ),
      });
    }

    // Keep turn open while tool calls are awaiting client execution.
    binding.turnOpen = true;
    const stamp = trajectoryStamper(binding, context);
    if (
      blocked.length === 0 &&
      rewritten.length === 0 &&
      annotated.length === 0 &&
      !stamp &&
      handbackIds.size === 0 &&
      relays.size === 0 &&
      runtimeCalls.size === 0
    )
      return;
    return {
      decision: "allow",
      toolCalls: stamp ? released.map(stamp) : released,
      ...(blocked.length > 0 ? { blocked } : {}),
      ...(rewritten.length > 0 ? { rewritten } : {}),
      ...(annotated.length > 0 ? { annotated } : {}),
      ...(runtimeProofs.length > 0 ? { runtimeProofs } : {}),
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
    if (!binding || binding.turnOpen || !binding.session.parent_id) {
      return;
    }
    if (
      binding.adapter?.id === "claude-code" &&
      (binding.request.declaredTools?.some(
        (tool) =>
          !tool.namespace &&
          binding.adapter?.isChildHandbackTool?.(tool.name) === true,
      ) ||
        isClaudeProgressLabelRequest(
          binding.requestBody,
          binding.child?.lineage?.spawnPromptDigest,
        ))
    ) {
      // With a native handback, intermediate text does not cross to the parent.
      // Claude's progress-label side call also does not finish its active child.
      return { decision: "release" };
    }
    if (!binding.request.turnEndOperationId) {
      throw new ApiError(503, "OpenAPPA could not safely end the child turn");
    }
    enterCapturedGuardrailsActivation("active");
    // Runtime workspace returns use their authenticated task identity.
    if (binding.runtimeSessionId === binding.session.session_id) {
      if (!binding.runtimeTaskId) {
        throw new ApiError(
          409,
          "OpenAPPA found no authenticated task identity for the runtime turn",
        );
      }
      const outcome = await returnRuntimeValue({
        session: this.governedSession(binding),
        operationId: `runtime-return:${binding.runtimeTaskId}:${context.requestId}`,
        value: context.responseText,
      });
      if (outcome.kind === "held") {
        return { decision: "replace", responseText: outcome.reason };
      }
      return outcome.value === context.responseText
        ? { decision: "release" }
        : { decision: "replace", responseText: outcome.value };
    }
    // If the runtime admits a value, the value crosses the boundary.
    const childNativeId = binding.child?.lineage?.childNativeId;
    const spawnCallId = await resolveSpawnCallId(binding);
    if (!spawnCallId) throw uncorrelatedChild();
    let admitted = context.responseText;
    if (context.responseText === "") {
      // A turn with no text returns nothing. The runtime reads a child end
      // with no value as the end of the child: after it, the child can call no
      // tool and can return nothing. The parent can still send this child a
      // follow-up, so the turn ends as a turn and the child stays open.
      await endTurn(
        this.governedSession(binding),
        binding.request.turnEndOperationId,
      );
    } else {
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
      admitted =
        outcome.decision === "release" ? context.responseText : outcome.content;
      if (!outcome.crossed) {
        return { decision: "replace", responseText: admitted };
      }
    }
    // A teammate's end reaches its lead as an idle notice, not as the result
    // of the call that started it, and it may end many turns: it carries no
    // return marker. The lead reads it only because it crossed here.
    if (
      binding.child?.lineage?.nativeConversationId ||
      (childNativeId && binding.adapter?.isTeammate?.(childNativeId))
    ) {
      return admitted === context.responseText
        ? { decision: "release" }
        : { decision: "replace", responseText: admitted };
    }
    const marker = mintChildReturnMarker({
      organizationId: binding.session.organization_id,
      callerId: binding.session.caller_id,
      parentId: binding.session.parent_id,
      childId: binding.session.session_id,
      ...(childNativeId ? { childNativeId } : {}),
      spawnCallId,
      value: admitted,
      ...(binding.adapter?.id === "codex" ? { format: "inline" as const } : {}),
    });
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
        identity: trustedContext.toolIdentity,
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
        ...(binding.runtimeSessionId
          ? { runtimeSessionId: binding.runtimeSessionId }
          : {}),
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
    /** The call carries a server-held review, not arguments the model wrote. */
    review: boolean,
  ): LlmProxyToolCallsContext["toolCalls"][number] {
    const native = binding.adapter?.nativeQuestion;
    if (
      !native?.fromAskUser ||
      !isSpecialToolMember(binding, call, "askUser") ||
      native.isAvailable?.(binding.requestHeaders) === false ||
      !declaresNativeQuestion(binding, native.toolName) ||
      archestraMcpBranding.getToolShortName(
        this.canonicalize(binding, call),
      ) !== TOOL_ASK_USER_SHORT_NAME
    ) {
      return call;
    }
    const parsed = parseAskUserArguments(call.arguments);
    if (!parsed) return call;
    if (parsed.allowMultiple && native.supportsMultiple === false) return call;
    // A preview shows only a call this server holds. Text a model put in
    // these fields of its own question could pass for a review's call.
    const {
      callPreview: _callPreview,
      shortQuestion: _shortQuestion,
      ...asked
    } = parsed;
    const args = review
      ? parsed
      : {
          ...asked,
          options: asked.options.map(
            ({ preview: _preview, ...option }) => option,
          ),
        };
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
    return canonicalCallName(binding, call);
  }

  /** The name resolution this binding's calls are ruled under. */
  private resolution(binding: AppaPluginBinding): ToolNameResolution {
    return toolNameResolution(binding);
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

  /**
   * Whether this session was already refused once for a request without the
   * gateway remedy tools. Records the current refusal so the next one counts.
   */
  /**
   * The notice tool name a denial is released under when the client declares
   * no notice tool, for a client that answers an undeclared call with an error
   * result. The ruling the call's result shows is kept first: the runtime
   * would answer it with the plans this client cannot act on. None when the
   * client declares that name, where it would run, or the ruling is not kept.
   */
  private async undeclaredNoticeCarrier(params: {
    binding: AppaPluginBinding;
    context: LlmProxyToolCallsContext;
    session: OpenAppaSession;
    callId: string;
    ruling: string;
  }): Promise<string | undefined> {
    const { binding } = params;
    if (
      !binding.adapter?.answersUndeclaredCalls ||
      params.context.interactionType !== "anthropic:messages"
    )
      return undefined;
    const name = archestraMcpBranding.getToolName(
      TOOL_GET_REMEDY_PLANS_SHORT_NAME,
    );
    const declared = [
      ...binding.request.declaredTools,
      ...(binding.request.heldTools ?? []),
    ];
    if (declared.some((tool) => tool.name === name)) return undefined;
    try {
      await cacheManager.set(
        carriedRulingKey({ session: params.session, callId: params.callId }),
        params.ruling,
        TimeInMs.Day,
      );
    } catch (error) {
      logger.warn({ err: error }, "OpenAPPA could not keep a carried ruling");
      return undefined;
    }
    return name;
  }

  private async remedyToolsMissingBefore(
    session: OpenAppaSession,
  ): Promise<boolean> {
    return seenBefore(CacheKey.OpenAppaRemedyToolsMissing, session);
  }

  /**
   * The client's own wait tool, when this request declares it and the session
   * has not waited yet for the gateway remedy tools. Records the wait: a
   * session whose remedy tools are still missing after it is refused.
   */
  private async pendingServersTool(
    binding: AppaPluginBinding,
    session: OpenAppaSession,
  ): Promise<string | undefined> {
    const name = binding.adapter?.pendingServersTool;
    if (
      !name ||
      !binding.request.declaredTools.some(
        (tool) => tool.name === name && !tool.namespace,
      )
    )
      return undefined;
    return (await seenBefore(CacheKey.OpenAppaRemedyToolsAwaited, session))
      ? undefined
      : name;
  }
}

const NO_REMEDY_PLAN_HINT =
  "\n\n[appa] This ruling offers no remedy plan. Explain the ruling to the user and STOP this blocked action. Do not retry the same call, directly or through a wrapper.";

/**
 * Why a refused call got no remedy, and what the person does about it. The
 * client's adapter knows where its gateway state is seen and how to sign in.
 * Without one, the first miss in a session is read as tools still loading.
 */
function remedylessRefusalNote(params: {
  binding: AppaPluginBinding;
  transient: boolean;
}): string {
  const server = archestraMcpBranding.serverName;
  // A request with no tools at all is not a gateway that is still loading or
  // needs a sign-in. The client known to send one is Codex in code mode, which
  // runs its tools outside the request, so the text names its setting.
  if (params.binding.request.declaredTools.length === 0) {
    return `[appa] This request listed no tools, so the ruling could not be offered as a remedy and the call is refused. Remedies need the ${server} MCP gateway tools in the request. Connect the gateway, then start a new session. In Codex, also set code_mode_host = false: code mode keeps its tools out of the request.`;
  }
  const lead = `[appa] This request did not include the ${server} MCP gateway tools, so no remedy plan can be used in this session, and a subagent started from it has the same limit. The call is refused.`;
  const hint = params.binding.adapter?.gatewayToolsHint?.(server);
  if (hint) return `${lead} ${hint}`;
  return params.transient
    ? `${lead} The gateway tools usually finish loading a moment after the session starts. Send your message again.`
    : `${lead} Connect this client to the ${server} MCP gateway, then start a new session.`;
}

function deniedCallClarificationKey(params: {
  session: OpenAppaSession;
  callId: string;
}): AllowedCacheKey {
  return `${CacheKey.OpenAppaDeniedCallClarification}-${Buffer.from(
    JSON.stringify([
      params.session.organization_id,
      params.session.session_id,
      withoutTrajectoryStamp(params.callId),
    ]),
  ).toString("base64url")}`;
}

/** The client's own report of a failed wait, so the model sees the real error. */
function waitFailure(wait: CommonToolResult): string {
  if (!wait.isError) return "";
  const reported =
    typeof wait.content === "string"
      ? wait.content
      : JSON.stringify(wait.content);
  return ` The wait itself failed, and the client reported:\n${reported}\n`;
}

function unansweredNoticeKey(params: {
  session: OpenAppaSession;
  callId: string;
}): AllowedCacheKey {
  return `${CacheKey.OpenAppaUnansweredAnnotationNotice}-${Buffer.from(
    `${params.session.organization_id}:${params.session.session_id}:${withoutTrajectoryStamp(params.callId)}`,
  ).toString("base64url")}`;
}

function notLoadedRulingKey(params: {
  session: OpenAppaSession;
  callId: string;
}): AllowedCacheKey {
  return `${CacheKey.OpenAppaNotLoadedRuling}-${Buffer.from(
    `${params.session.organization_id}:${params.session.session_id}:${withoutTrajectoryStamp(params.callId)}`,
  ).toString("base64url")}`;
}

function carriedRulingKey(params: {
  session: OpenAppaSession;
  callId: string;
}): AllowedCacheKey {
  return `${CacheKey.OpenAppaCarriedRuling}-${Buffer.from(
    `${params.session.organization_id}:${params.session.session_id}:${withoutTrajectoryStamp(params.callId)}`,
  ).toString("base64url")}`;
}

/** Whether the request declares the tool this call names, as the client spells it. */
function isDeclaredCall(
  binding: AppaPluginBinding,
  call: { name: string; namespace?: string },
): boolean {
  return binding.request.declaredTools.some(
    (tool) => tool.name === call.name && sameNamespace(tool, call),
  );
}

/**
 * Whether two tools share a namespace. An empty namespace is none: a declared
 * local tool has no namespace, and the native question that replaces ask_user
 * carries an explicit empty one.
 */
function sameNamespace(
  a: { namespace?: string },
  b: { namespace?: string },
): boolean {
  return (a.namespace || undefined) === (b.namespace || undefined);
}

function notLoadedFeedback(params: {
  binding: AppaPluginBinding;
  call: { name: string; namespace?: string };
}): string {
  const { call } = params;
  const held = params.binding.request.heldTools?.some(
    (tool) => tool.name === call.name && sameNamespace(tool, call),
  );
  return held
    ? `[appa] ${call.name} cannot be used until ${TOOL_GET_REMEDY_PLANS_SHORT_NAME} and ${TOOL_EXECUTE_REMEDY_PLAN_SHORT_NAME} are both loaded. Search for the one that is missing with your tool search, then call it again.`
    : `[appa] ${call.name} is not loaded in this session. Search for it with your tool search, then call it again.`;
}

/** Whether `flag` was already set for this session today. Sets it. */
async function seenBefore(
  flag:
    | typeof CacheKey.OpenAppaRemedyToolsMissing
    | typeof CacheKey.OpenAppaRemedyToolsAwaited,
  session: OpenAppaSession,
): Promise<boolean> {
  const key: AllowedCacheKey = `${flag}-${Buffer.from(
    `${session.organization_id}:${session.session_id}`,
  ).toString("base64url")}`;
  if (await cacheManager.get<boolean>(key)) return true;
  await cacheManager.set(key, true, TimeInMs.Day);
  return false;
}

async function correlatedClaudeTeammateId(
  params: Parameters<typeof appaTrajectory>[0],
): Promise<string | undefined> {
  const trusted = params.trustedContext;
  const matchContext = {
    headers: params.headers,
    requestBody: params.requestBody,
    trustedContext: { ...trusted, session: { ...trusted.session } },
  };
  const adapter = params.adapters.find((candidate) =>
    candidate.matches(matchContext),
  );
  if (adapter?.id !== "claude-code") return undefined;
  const native = claudeCodeNativeChildIds(matchContext);
  const parentNativeId = nativeId(native.parentNativeId);
  const childNativeId = nativeId(native.childNativeId);
  const nativeConversationId = adapter.nativeConversationId(matchContext);
  if (
    !parentNativeId ||
    !childNativeId ||
    childNativeId === parentNativeId ||
    childNativeId !== nativeConversationId
  )
    return undefined;

  const session = trusted.session;
  const receipt = trusted.request.childTrajectoryReceipts?.find((candidate) =>
    verifyChildTrajectoryReceipt({
      receipt: candidate,
      organizationId: session.organization_id,
      callerId: session.caller_id,
      spawnerNativeId: parentNativeId,
      nativeConversationId,
    }),
  );
  const marker =
    !receipt &&
    trusted.request.delegation?.markers.find(
      (candidate) =>
        !`:${candidate.parentId}:`.includes(`:${childNativeId}:`) &&
        verifyDelegatedPrompt({
          marker: candidate,
          organizationId: session.organization_id,
          callerId: session.caller_id,
          spawnerNativeId: parentNativeId,
        })?.promptDigest,
    );
  const spawnCallId = marker ? marker.spawnCallId : receipt?.spawnCallId;
  if (!spawnCallId) return undefined;
  const parentId = marker ? marker.parentId : receipt?.parentId;
  if (!parentId) return undefined;
  const aliases = await OpenAppaSpawnCorrelationModel.allowedSpawnAliases({
    organizationId: session.organization_id,
    callerId: session.caller_id,
    parentSessionId: withCallerScope(session, parentId),
  });
  const ids = new Set(
    aliases.flatMap((alias) => {
      if (
        withoutTrajectoryStamp(alias.spawnCallId) !==
        withoutTrajectoryStamp(spawnCallId)
      )
        return [];
      const launch = alias.launchText
        ? adapter.launchIdentity?.(alias.launchText)
        : undefined;
      if (!alias.name || !/^[A-Za-z0-9_-]{1,64}$/.test(alias.name)) return [];
      if (launch && launch.name !== alias.name) return [];
      if (!marker && alias.name !== receipt?.childNativeId) return [];
      // Launch acknowledgements are control/status, not necessarily stored
      // results. The allowed native call supplies the stable teammate name.
      return [alias.name];
    }),
  );
  if (ids.size > 1)
    throw new ApiError(
      409,
      "OpenAPPA found conflicting teammate launch identities for this spawn",
    );
  return [...ids][0];
}

type RuntimeCall = {
  action: string;
  args: Record<string, unknown>;
  wrapper?: Record<string, unknown>;
  stringArgs?: boolean;
  spawn: boolean;
};

const runtimeToolActions = new Set<string>(OPENAPPA_RUNTIME_TOOL_SHORT_NAMES);

/** The canonical name a call is ruled under, by the session's tool identity. */
function canonicalCallName(
  params: {
    identity: AppaTrustedContext["toolIdentity"];
    adapter: AppaClientAdapter | undefined;
  },
  call: { name: string; namespace?: string },
): string {
  if (
    !params.identity.attestationOf(call.name, call.namespace) &&
    params.adapter?.classifyToolName(call.name, call.namespace) === "local"
  ) {
    return params.identity.canonicalize(
      params.adapter.normalizeLocalToolName(call.name),
    );
  }
  return params.identity.canonicalize(call.name, call.namespace);
}

function toolNameResolution(params: {
  identity: AppaTrustedContext["toolIdentity"];
  adapter: AppaClientAdapter | undefined;
}): ToolNameResolution {
  return {
    canonicalize: (name: string, namespace?: string) =>
      canonicalCallName(params, { name, namespace }),
    looseRunToolDispatch: params.identity.looseRunToolDispatch,
  };
}

/** The call as released: its arguments, or its `run_tool` target's, carry the proof. */
function signedCall(params: {
  call: ToolCall;
  runtime: RuntimeCall;
  proof: string;
}): ToolCall {
  const { call, runtime } = params;
  const signed = {
    ...runtime.args,
    [RUNTIME_TOOL_PROOF_ARGUMENT]: params.proof,
  };
  return {
    ...call,
    arguments: runtime.wrapper
      ? {
          ...runtime.wrapper,
          tool_args: runtime.stringArgs ? JSON.stringify(signed) : signed,
        }
      : signed,
  };
}

async function resolveRuntimeCalls(params: {
  organizationId: string;
  calls: readonly ToolCall[];
  resolution: ToolNameResolution;
}): Promise<Map<string, RuntimeCall>> {
  const result = new Map<string, RuntimeCall>();
  for (const call of params.calls) {
    const [target] = normalizeToolCallsForPolicy([call], params.resolution);
    // Already canonical: the call's own resolved name, or the tool `run_tool`
    // dispatches. It is not a wire spelling, and resolving it as one marks it
    // foreign behind an attested gateway, so the call would go out unsigned.
    const action =
      archestraMcpBranding.getToolShortName(target.toolCallName) ??
      target.toolCallName;
    if (!runtimeToolActions.has(action) && !isAgentTool(action)) continue;
    const args = argumentRecordOf(target.toolCallArgs);
    if (!args) continue;
    const wrapper = target.isRunToolDispatchTarget
      ? argumentRecordOf(call.arguments)
      : undefined;
    // run_tool refuses tool_args it cannot read, so that call never runs and
    // gets no proof.
    if (wrapper && !readRunToolArgs(wrapper.tool_args)) continue;
    result.set(call.id, {
      action,
      args,
      spawn: false,
      ...(wrapper
        ? { wrapper, stringArgs: typeof wrapper.tool_args === "string" }
        : {}),
    });
  }
  if (
    [...result.values()].some(
      (call) =>
        call.action === TOOL_START_AGENT_RUN_SHORT_NAME ||
        isAgentTool(call.action),
    )
  ) {
    const { organizationId } = params;
    const [runtimeTargets, spawnTargets] = await Promise.all([
      AgentModel.findRuntimeTargets(organizationId),
      AgentModel.findSpawnTargets(organizationId),
    ]);
    const ids = new Set(runtimeTargets.map((target) => target.id));
    // Delegating to one of the organization's own agents, in a runtime or in
    // this process, starts a child trajectory. Built-in subagents do not.
    const names = new Set([
      SELF_FORK_TOOL_NAME,
      ...[...runtimeTargets, ...spawnTargets].map(
        (target) => `${AGENT_TOOL_PREFIX}${slugify(target.name)}`,
      ),
    ]);
    for (const call of result.values()) {
      call.spawn =
        call.action === TOOL_START_AGENT_RUN_SHORT_NAME
          ? typeof call.args.agent_id === "string" &&
            ids.has(call.args.agent_id)
          : names.has(call.action);
    }
  }
  return result;
}

/**
 * The results of released spawns whose in-process child already returned. The
 * child's turn crossed its value at its end; the parent receives exactly those
 * bytes, recorded as the spawn's result. A spawn with no crossed return is a
 * runtime launch, or a child that failed or was withheld.
 */
async function admitSubagentReturns(params: {
  session: OpenAppaSession;
  spawnIds: ReadonlySet<string>;
}): Promise<Map<string, string>> {
  const returns = await withCapturedGuardrailsActivation("active", () =>
    Promise.all(
      [...params.spawnIds].map(async (spawnCallId) => {
        const child = subagentChildSession(params.session, spawnCallId);
        const [latest] = await loadChildReturns({
          organizationId: params.session.organization_id,
          parentSessionId: params.session.session_id,
          childSessionId: child.session_id,
          operationPrefix: subagentReturnPrefix(spawnCallId),
        });
        return { spawnCallId, childId: child.session_id, latest };
      }),
    ),
  );
  const admitted = new Map<string, string>();
  for (const { spawnCallId, childId, latest } of returns) {
    if (!latest) continue;
    await approveSpawnReturn({
      session: params.session,
      toolCallId: spawnCallId,
      childId,
      value: latest.value,
    });
    admitted.set(spawnCallId, latest.value);
  }
  return admitted;
}

/**
 * An Archestra delegation call declares its own child's return: as spoken by
 * default, schema-attested when it names a `return_schema`. A runtime launch
 * through `start_agent_run` keeps the explicit declaration flow.
 */
function delegationReturnDeclaration(
  call: RuntimeCall | undefined,
): SpawnReturnDeclaration | undefined {
  if (!call?.spawn || !isAgentTool(call.action)) return undefined;
  const schema = call.args.return_schema;
  return isRecord(schema)
    ? { kind: "attested", schema }
    : { kind: "as_spoken" };
}

async function releasedRuntimeSpawns(params: {
  binding: AppaPluginBinding;
  session: OpenAppaSession;
  toolResults: LlmProxyToolResultsContext["toolResults"];
}): Promise<Set<string>> {
  const possible = params.toolResults.filter((answer) => {
    const name = params.binding.identity.canonicalize(
      answer.name,
      answer.namespace,
    );
    const action = archestraMcpBranding.getToolShortName(name) ?? name;
    return (
      action === "run_tool" ||
      runtimeToolActions.has(action) ||
      isAgentTool(action)
    );
  });
  const calls = await OpenAppaSpawnCorrelationModel.releasedCalls({
    organizationId: params.session.organization_id,
    callerId: params.session.caller_id,
    sessionId: params.session.session_id,
    toolCallIds: possible.map((answer) => withoutTrajectoryStamp(answer.id)),
  });
  return new Set(
    [...calls]
      .filter(([, call]) => {
        const action =
          archestraMcpBranding.getToolShortName(call.tool) ?? call.tool;
        return (
          call.spawn &&
          (action === TOOL_START_AGENT_RUN_SHORT_NAME ||
            action === SUBAGENT_TOOL ||
            isAgentTool(action))
        );
      })
      .map(([id]) => id),
  );
}

/**
 * What the model reads as the result of a runtime launch: what the gateway
 * recorded for the call, in text written here. The result the client sends
 * back is not read, so its form and its text do not matter.
 */
function runtimeLaunchResult(
  outcome: RuntimeLaunchOutcome | undefined,
): string {
  if (!outcome) return "The runtime launch returned no verifiable handle.";
  if (outcome.kind === "launched") {
    return JSON.stringify({
      run_id: outcome.session_id,
      ...(outcome.state ? { state: outcome.state } : {}),
      run_url: agentRunUrl(outcome.session_id),
      next_step: submittedRunNextStep({
        reportsToThread: outcome.reports_to_thread === true,
      }),
    });
  }
  const text = RUNTIME_LAUNCH_FAILURE_TEXT[outcome.reason];
  return outcome.reason === "credentials_needed" && outcome.setup_url
    ? `${text} Put this link in your reply text, never inside a question form, so the user can add them, then start the run again: ${outcome.setup_url}`
    : text;
}

/** One entry for each reason, so a new reason does not compile without text. */
const RUNTIME_LAUNCH_FAILURE_TEXT: Record<RuntimeLaunchFailureReason, string> =
  {
    agent_not_found: "No runtime was started. The Agent was not found.",
    credentials_needed:
      "No runtime was started. This Agent's Agent Runtime needs credentials that are not set up yet.",
    credentials_misconfigured:
      "No runtime was started. This Agent is missing shared Agent Runtime credentials that an administrator must configure.",
    refused: "No runtime was started. OpenAPPA refused this launch.",
    failed:
      "No runtime was started. An internal error occurred while starting the run.",
  };

async function approveChildReturnCarriers(params: {
  binding: AppaPluginBinding;
  results: LlmProxyToolResultsContext["toolResults"];
}): Promise<{
  updates: Record<string, string>;
  /** Results of children that ran while enforcement was off, with no crossing. */
  ignored: Set<string>;
  /** Spawn results that carry no return: the child failed before it returned. */
  failedSpawns: Set<string>;
}> {
  const completions = params.binding.request.childReturns?.completions ?? [];
  const adapter = params.binding.adapter;
  const completionResults = params.results.filter(
    (result) =>
      params.binding.request.restoredNoticeCallIds?.has(result.id) !== true &&
      adapter?.isChildCompletionResult?.(result) === true,
  );
  const ignored = new Set<string>();
  const failedSpawns = new Set<string>();
  if (completions.length === 0 && completionResults.length === 0) {
    return { updates: {}, ignored, failedSpawns };
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
  )
    // The runtime lists the newest return first, so the lowest rank is the
    // newest.
    .map((record, rank) => ({
      ...record,
      rank,
      ...(record.spawnCallId
        ? { spawnCallId: withoutTrajectoryStamp(record.spawnCallId) }
        : {}),
    }));
  // A child that answered a follow-up has more than one return, all under one
  // spawn call.
  const crossedByChild = new Map<string, Set<string>>();
  for (const record of available) {
    const crossed = crossedByChild.get(record.childSessionId) ?? new Set();
    crossed.add(record.value);
    crossedByChild.set(record.childSessionId, crossed);
  }
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
  // The returns of children that ended with no text, by the result that
  // carries them.
  const emptyByEnvelope = new Map<string, AppaChildReturnCompletion[]>();
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
    record: AppaChildReturnRecord & { rank: number };
  }> = [];
  for (const completion of completions) {
    // Display-only echoes never consume a child's crossing.
    if (completion.assistantOrigin) continue;
    // A child turn that ended with no text returned nothing. No bytes of it
    // reach the parent, so there is no crossing to find.
    if (completion.value === "") {
      if (completion.envelopeId) {
        const envelopeId = withoutTrajectoryStamp(completion.envelopeId);
        emptyByEnvelope.set(envelopeId, [
          ...(emptyByEnvelope.get(envelopeId) ?? []),
          completion,
        ]);
      }
      continue;
    }
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
    const exact = candidates.filter(
      ({ record }) =>
        (expectedSpawn === undefined || record.spawnCallId === expectedSpawn) &&
        (completion.childNativeId === undefined ||
          record.childNativeId === completion.childNativeId),
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
  // The newest return each child carries into this request, by spawn call.
  const arrived = new Map<
    string,
    AppaChildReturnRecord & { spawnCallId: string; rank: number }
  >();
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
    const child = JSON.stringify([spawnCallId, record.childSessionId]);
    const newest = arrived.get(child);
    if (!newest || record.rank < newest.rank) {
      arrived.set(child, { ...record, spawnCallId });
    }
  }
  // A child's return always reaches the parent framed or marked. So when this
  // session released a spawn, its child crossed nothing, and no collected
  // return names the spawn's result, the result is the client's own text
  // about a child that failed before it returned, for example on a provider
  // error before its first request. The runtime closes that spawn and
  // withholds the text, so the parent can go on and spawn again. A spawn this
  // session never released, or one a fork carries, is still refused below.
  const released = new Set(params.binding.request.releasedSpawnCalls);
  // Display-only echoes name no return, as in the matching above.
  const named = new Set(
    completions
      .filter((completion) => !completion.assistantOrigin)
      .flatMap((completion) =>
        [completion.envelopeId, completion.spawnCallId].flatMap((id) =>
          id ? [withoutTrajectoryStamp(id)] : [],
        ),
      ),
  );
  for (const result of completionResults) {
    const id = withoutTrajectoryStamp(result.id);
    if (
      !params.binding.session.fork_of &&
      directSpawnResults.has(id) &&
      released.has(id) &&
      !crossedSpawns.has(id) &&
      !named.has(id) &&
      !unenforcedReturn({ spawnCallId: id })
    )
      failedSpawns.add(result.id);
  }
  const returnResults = completionResults.filter(
    (result) => !failedSpawns.has(result.id),
  );
  const unrecordedResult = returnResults.find(
    (result) =>
      (byEnvelope.get(withoutTrajectoryStamp(result.id)) ?? []).length === 0 &&
      !ignoredByEnvelope.has(withoutTrajectoryStamp(result.id)) &&
      !emptyByEnvelope.has(withoutTrajectoryStamp(result.id)) &&
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
  // The runtime replays only a child's latest return and keeps one approved
  // return for each spawn call. So a child that returned more than once is
  // approved once, with its newest return here, and its older returns stand on
  // their own crossings.
  for (const record of arrived.values()) {
    await approveSpawnReturn({
      session: params.binding.session,
      toolCallId: record.spawnCallId,
      childId: record.childSessionId,
      value: record.value,
      crossedReturns: crossedByChild.get(record.childSessionId),
    });
  }
  // Strips unverified text and metadata beside valid returns.
  // Reconstructs result content solely from crossed values.
  const updates: Record<string, string> = Object.create(null);
  for (const result of returnResults) {
    const envelopeId = withoutTrajectoryStamp(result.id);
    const verified = byEnvelope.get(envelopeId) ?? [];
    const ignoredHere = ignoredByEnvelope.get(envelopeId) ?? [];
    const emptyHere = emptyByEnvelope.get(envelopeId) ?? [];
    if (
      verified.length === 0 &&
      emptyHere.length === 0 &&
      (ignoredHere.length > 0 || unenforcedReturn({ spawnCallId: envelopeId }))
    ) {
      ignored.add(result.id);
      continue;
    }
    if (verified.length === 0 && emptyHere.length === 0) {
      throw childReturnRefusal({ ...unrecorded, callId: envelopeId });
    }
    // A return OpenAPPA ignores stays beside the crossed ones, as it came.
    updates[result.id] =
      verified.length + emptyHere.length === 1 &&
      ignoredHere.length === 0 &&
      adapter?.isSpawnTool(result.name, result.namespace)
        ? (verified[0]?.value ?? "")
        : JSON.stringify({
            status: Object.fromEntries([
              ...matched
                .filter(({ record }) => verified.includes(record))
                .map(({ completion, record }) => [
                  completion.childNativeId ?? record.childNativeId,
                  { completed: record.value },
                ]),
              ...emptyHere.flatMap((completion) =>
                completion.childNativeId
                  ? [[completion.childNativeId, { completed: "" }]]
                  : [],
              ),
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
  return { updates, ignored, failedSpawns };
}

/**
 * Refuses a child return carried in the conversation history. The client
 * re-sends that history with every later request, so a retry fails the same
 * way: the SDK is told not to retry, and the user is told how to continue.
 */
class ChildReturnRefusal extends ApiError {}

/**
 * The refusal without its offer to report the failure, for a request whose
 * reporting turn cannot run.
 */
function withoutReportingRecovery(error: unknown): unknown {
  if (
    !(error instanceof ChildReturnRefusal) ||
    !error.message.includes(CHILD_RETURN_RECOVERY)
  )
    return error;
  const refusal = new ChildReturnRefusal(
    error.statusCode,
    error.message.replace(
      CHILD_RETURN_RECOVERY,
      CHILD_RETURN_CONTINUE_RECOVERY,
    ),
  );
  refusal.shouldRetry = error.shouldRetry;
  return refusal;
}

function isReportingReviewTool(tool: string | undefined): boolean {
  // The native intrinsic is unprefixed; gateway tools have branded names.
  return (
    tool === "yell" ||
    isYellToolShortName(archestraMcpBranding.getToolShortName(tool ?? ""))
  );
}

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
  const error = new ChildReturnRefusal(
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

const CHILD_RETURN_CONTINUE_RECOVERY =
  "To continue other work, start a new session, or rewind the conversation to a message you sent before this subagent started.";
const CHILD_RETURN_RECOVERY = `You can ask your agent to report this failure, or to report it and turn OpenAPPA off for this session. ${CHILD_RETURN_CONTINUE_RECOVERY}`;
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
): Promise<boolean> {
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
    return true;
  } catch (error) {
    logger.warn(
      { err: error },
      "OpenAPPA could not record tool calls made while enforcement was off",
    );
    return false;
  }
}

/**
 * Signs the runtime reads of a governed session while enforcement is off.
 * Nothing rules them now, but a read can reach the gateway after enforcement
 * turns on, and without a proof the gateway cannot tell this session from a
 * stranger and refuses it. With one, what it reads crosses into this session
 * as for a ruled call. Anything else stays unsigned (see `isObservedRead`).
 * Signing never fails the request; an unsigned call behaves as before. When
 * the calls could not be recorded nothing is signed, and the reads are
 * counted as unsigned.
 */
async function signObservedRuntimeCalls(
  observer: AppaPluginObserver,
  calls: readonly ToolCall[],
  recorded: boolean,
): Promise<LlmProxyToolCallsOutcome | undefined> {
  const secret = config.openappa.offerSigningSecret;
  if (!secret) return undefined;
  try {
    const runtimeCalls = await resolveRuntimeCalls({
      organizationId: observer.session.organization_id,
      calls,
      resolution: toolNameResolution(observer),
    });
    const toolCalls: ToolCall[] = [];
    const runtimeProofs: LlmProxyRuntimeToolProof[] = [];
    let unsigned = 0;
    for (const call of calls) {
      const runtime = runtimeCalls.get(call.id);
      // A proof the model wrote itself is left for the gateway to refuse.
      const read =
        runtime !== undefined &&
        !runtime.spawn &&
        isObservedRead({ action: runtime.action, args: runtime.args }) &&
        !Object.hasOwn(runtime.args, RUNTIME_TOOL_PROOF_ARGUMENT);
      if (read && !recorded) unsigned++;
      const proof =
        runtime && read && recorded
          ? signRuntimeToolProof({
              session: observer.session,
              toolCallId: withoutTrajectoryStamp(call.id),
              action: runtime.action,
              arguments: runtime.args,
              spawn: false,
              observed: true,
              secret,
            })
          : undefined;
      if (!runtime || !proof) {
        toolCalls.push(call);
        continue;
      }
      runtimeProofs.push({
        id: call.id,
        name: call.name,
        action: runtime.action,
        session: observer.session,
        spawn: false,
        wrapped: runtime.wrapper !== undefined,
      });
      toolCalls.push(signedCall({ call, runtime, proof }));
    }
    reportAgentRuntimeObservedReads("signed", runtimeProofs.length);
    reportAgentRuntimeObservedReads("unsigned", unsigned);
    return runtimeProofs.length > 0
      ? { decision: "allow", toolCalls, runtimeProofs }
      : undefined;
  } catch (error) {
    logger.warn(
      { err: error },
      "OpenAPPA could not sign runtime calls made while enforcement was off",
    );
    return undefined;
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
  return (
    (id.startsWith(`${name}@`) && !id.slice(name.length + 1).includes("@")) ||
    (!id.includes("@") &&
      name.startsWith(`${id}@`) &&
      !name.slice(id.length + 1).includes("@"))
  );
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
  return archestraMcpBranding.getToolShortName(
    binding.identity.canonicalize(name, namespace),
  );
}

function isPeerInboxCall(
  binding: AppaPluginBinding,
  name: string,
  namespace?: string,
): boolean {
  const short = peerShortName(binding, name, namespace);
  return (
    short === TOOL_LIST_PEER_MESSAGES_SHORT_NAME ||
    short === TOOL_READ_PEER_MESSAGE_SHORT_NAME
  );
}

function isPeerInboxResult(
  binding: AppaPluginBinding,
  name: string,
  namespace?: string,
): boolean {
  return isPeerInboxCall(
    binding,
    name,
    namespace ?? binding.request.tools?.namespaces?.get(name),
  );
}

function stampPeerInboxCall(params: {
  binding: AppaPluginBinding;
  call: ToolCall;
  session: OpenAppaSession;
}): RelayOutcome {
  const short = peerShortName(
    params.binding,
    params.call.name,
    params.call.namespace,
  );
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
    if (!isPeerInboxResult(params.binding, result.name, result.namespace))
      continue;
    if (isPeerReadResult(params.binding, result.name, result.namespace)) {
      const receipt = await OpenAppaSessionModel.retainedPeerReadReceipt({
        organizationId: params.session.organization_id,
        sessionId: params.session.session_id,
        callerId: params.session.caller_id,
        toolCallId: result.id,
      });
      params.updates[result.id] = receipt
        ? restoredPeerRead(receipt)
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

function restoredPeerRead(
  receipt: Awaited<
    ReturnType<typeof OpenAppaSessionModel.retainedPeerReadReceipt>
  >,
): string {
  if (!receipt) return WITHHELD_PEER_READ;
  if (receipt.kind === "admitted") {
    return escapeRelayMarkup(receipt.approvedOutput);
  }
  // Offer ids remain presentation data. Remedy execution uses this request's
  // current trajectory rather than routing claims recovered from history.
  return JSON.stringify({
    ruling: receipt.feedback,
    ...(receipt.offers.length > 0 ? { offers: receipt.offers } : {}),
  });
}

function isPeerReadResult(
  binding: AppaPluginBinding,
  name: string,
  namespace?: string,
): boolean {
  return (
    peerShortName(
      binding,
      name,
      namespace ?? binding.request.tools?.namespaces?.get(name),
    ) === TOOL_READ_PEER_MESSAGE_SHORT_NAME
  );
}

function stringArgument(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

const PEER_INBOX_UNBOUND =
  "OpenAPPA cannot bind this peer-message call to the authenticated session, so it was not sent. Connect the MCP gateway and retry.";

async function admitChildHandback(params: {
  binding: AppaPluginBinding;
  call: ToolCall;
}): Promise<{ call: ToolCall; returnText: string }> {
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
  const marker = mintChildReturnMarker({
    organizationId: binding.session.organization_id,
    callerId: binding.session.caller_id,
    parentId: binding.session.parent_id,
    childId: binding.session.session_id,
    ...(childNativeId ? { childNativeId } : {}),
    spawnCallId,
    value: admitted,
    ...(binding.adapter?.id === "codex" ? { format: "inline" as const } : {}),
  });
  const returnText = `${admitted}\n\n${marker}`;
  const rewritten = adapter?.rewriteChildHandback?.(call.arguments, returnText);
  return {
    call: {
      ...call,
      arguments: rewritten === undefined ? returnText : rewritten,
    },
    returnText,
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
  const trustedContext = getTrustedContext(context.resources);
  const runtimeSessionId = trustedContext?.runtimeSessionId;
  const footer = mintChildTrajectoryReceipt({
    organizationId: session.organization_id,
    callerId: session.caller_id,
    parentId: child.parentId,
    childId: child.sessionId,
    ...(lineage.childNativeId ? { childNativeId: lineage.childNativeId } : {}),
    spawnerNativeId: lineage.nativeParentId,
    spawnCallId: lineage.spawnCallId,
    nativeConversationId: lineage.nativeConversationId,
    ...(runtimeSessionId ? { runtimeSessionId } : {}),
  });
  if (!footer) return;
  context.resources.set(APPA_CHILD_TRAJECTORY_RECEIPT, {
    footer,
    inHistory: lineage.source === "receipt",
  });
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

function unsupportedNativeSpawn(
  binding: AppaPluginBinding,
  calls: readonly ToolCall[],
):
  | { id: string; name: string; namespace?: string; fields: string[] }
  | undefined {
  const report = binding.adapter?.unsupportedSpawnFields;
  if (!report) return undefined;
  for (const call of calls) {
    const fields = report.call(binding.adapter, {
      requestBody: binding.requestBody,
      name: call.name,
      namespace: call.namespace,
      arguments: call.arguments,
    });
    if (!fields || fields.length === 0) continue;
    return {
      id: call.id,
      name: call.name,
      ...(call.namespace ? { namespace: call.namespace } : {}),
      fields,
    };
  }
  return undefined;
}

function illegalSpawnFeedback(params: {
  name: string;
  namespace?: string;
  fields: readonly string[];
}): string {
  const tool = params.namespace
    ? `${params.namespace}.${params.name}`
    : params.name;
  const fields = params.fields.map((field) => `\`${field}\``).join(", ");
  return [
    `OpenAPPA refused this spawn before any return-contract offer. ${tool} does not accept ${fields}.`,
    "An APPA return plan is selected with execute_remedy_plan, not by adding a field to the native spawn arguments.",
    "Re-propose the spawn with only the arguments its declaration accepts. Do not repeat the rejected field.",
  ].join(" ");
}

/**
 * Restore at most one accepted spawn per batch. Different options or tasks
 * still need their own runtime ruling; acceptance never authorizes fan-out.
 *
 * The `[appa] Authorized.` blob is parsed from client-carried history, so the
 * text alone is not proof of authorization. A forged blob cannot widen the
 * retried call: the marker prefix and shape are exact (parseAuthorizedRetry),
 * the call must be one of the adapter's spawn tools whose local name matches
 * the blob's tool, and every non-prompt argument must byte-match the blob
 * while the prompt may only narrow toward the authorized value
 * (sameAuthorizedSpawn, spawnArgumentsCovered). The restored call still goes
 * through the runtime's own ruling afterward. A journal cross-check is not
 * added: the blob carries no call id, so a lookup could only re-run this same
 * name+arguments comparison, and the runtime — not this text — is what
 * authorized the retry.
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
  session: OpenAppaSession,
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
  // Replace model-written transport fields, including old signed envelopes.
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
  return {
    ...call,
    arguments: JSON.stringify({
      ...clientArguments,
      execution,
      trajectory: currentTrajectory(session),
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
 * Attaches the current run to an ask_user call. Pending server-held reviews,
 * not copied offers or model text, decide which approvals it may collect.
 */
function stampAskUserTrajectory(
  call: LlmProxyToolCallsContext["toolCalls"][number],
  session: OpenAppaSession,
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
  const validBinding =
    requested.size > 0 &&
    requested.size <= 12 &&
    requestedOfferIds.length === requestedOfferIdValues.length &&
    requested.size === requestedOfferIds.length &&
    requestedOfferIds.every((id) => !claimedOfferIds.has(id));
  if (!validBinding) {
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
        trajectory: currentTrajectory(session),
      }),
    },
    offerIds: requestedOfferIds,
  };
}

// SPDX-SnippetBegin
// SPDX-SnippetCopyrightText: 2026 Archestra Inc.
// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
async function canonicalizeHitlAskUserCall(params: {
  binding: AppaPluginBinding;
  call: LlmProxyToolCallsContext["toolCalls"][number];
  offerIds: readonly string[];
  /** Offer the review on the client's native card with Inspect. */
  inspectable?: boolean;
}): Promise<{
  call: LlmProxyToolCallsContext["toolCalls"][number];
  invalidOfferCount: boolean;
  reviewUnavailable?: boolean;
  offerIds: string[];
  /** The card offers Inspect; its answers resolve inspection state. */
  inspectable?: boolean;
  /** The exact staged payload the issued card is bound to. */
  digest?: string;
  /** The complete review carried in the native input or preceding assistant text. */
  reviewText?: string;
  askedQuestion?: string;
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
      offerIds: [],
    };
  }
  if (params.inspectable) {
    const inspectable = await getHitlInspectableAskUserArguments({
      session: params.binding.session,
      offerIds: params.offerIds,
    });
    if (inspectable) {
      const family =
        params.binding.adapter?.id === "opencode" ||
        params.binding.adapter?.id === "kilo";
      const askedQuestion = family
        ? openCodeReviewQuestion(inspectable.card, inspectable.reviewText)
        : undefined;
      return {
        call: {
          ...params.call,
          arguments: JSON.stringify({
            ...inspectable.card,
            ...(askedQuestion ? { question: askedQuestion } : {}),
            trajectory: currentTrajectory(params.binding.session),
          }),
        },
        invalidOfferCount: false,
        offerIds: [...params.offerIds],
        inspectable: true,
        digest: inspectable.digest,
        ...(askedQuestion ? { askedQuestion } : {}),
        ...(inspectable.reviewText
          ? { reviewText: inspectable.reviewText }
          : {}),
      };
    }
    // A missing snapshot here can be a concurrent replacement, not an absent
    // feature. Never downgrade it to the old, potentially unreadable card.
    if (params.offerIds.length > 0)
      return {
        call: params.call,
        invalidOfferCount: false,
        reviewUnavailable: true,
        offerIds: [],
      };
  }
  const hitl = await getHitlAskUserArguments({
    session: params.binding.session,
    offerIds: params.offerIds,
  });
  if (!hitl)
    return { call: params.call, invalidOfferCount: false, offerIds: [] };
  const raw =
    typeof params.call.arguments === "string"
      ? params.call.arguments
      : JSON.stringify(params.call.arguments);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { call: params.call, invalidOfferCount: false, offerIds: [] };
  }
  if (!isRecord(parsed))
    return { call: params.call, invalidOfferCount: false, offerIds: [] };
  return {
    call: {
      ...params.call,
      arguments: JSON.stringify({
        ...hitl,
        trajectory: currentTrajectory(params.binding.session),
      }),
    },
    invalidOfferCount: false,
    offerIds: [...params.offerIds],
  };
}

// SPDX-SnippetEnd

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

const REMEDY_OFFER_CONTINUATION_GUIDANCE = [
  "The ruling above offers a remedy plan for the blocked call.",
  "If the plan fits the user's request, continue the task and apply the plan with execute_remedy_plan.",
  "Use the offer_id and plan from the ruling.",
  "execute_remedy_plan asks the user for approval when the policy requires it.",
].join(" ");

const NATIVE_DELEGATION_GUIDANCE_MARKER =
  "collaboration.spawn_agent is declared.";

function nativeDelegationGuidance(waitDeclared: boolean): string {
  const wait = waitDeclared
    ? " Then call collaboration.wait_agent for its result."
    : "";
  return [
    NATIVE_DELEGATION_GUIDANCE_MARKER,
    `A request for a native subagent is a direct function call with namespace collaboration and name spawn_agent.${wait}`,
    "Do not run a nested Codex CLI as that subagent, and do not report a nested CLI result as a subagent result.",
    "An explicit user request to run a shell command stays a shell command. Do not rewrite it into spawn_agent.",
  ].join(" ");
}

function appendNativeDelegationGuidance(
  context: LlmProxyBeforeModelContext,
): void {
  if (context.interactionType !== "openai:responses") return;
  if (!isRecord(context.request)) return;
  if (Array.isArray(context.request.input)) {
    // Replace our marked guidance, including stale variants for removed tools.
    context.request.input = context.request.input.flatMap((item) => {
      if (
        !isRecord(item) ||
        item.role !== "developer" ||
        !Array.isArray(item.content)
      ) {
        return [item];
      }
      const content = item.content.filter(
        (block) =>
          !(
            isRecord(block) &&
            block.type === "input_text" &&
            typeof block.text === "string" &&
            block.text.startsWith(NATIVE_DELEGATION_GUIDANCE_MARKER)
          ),
      );
      if (content.length === item.content.length) return [item];
      return content.length > 0 ? [{ ...item, content }] : [];
    });
  }
  const declared = collectDeclaredToolNames(context.request);
  const spawnDeclared = declared.some(
    (tool) => tool.namespace === "collaboration" && tool.name === "spawn_agent",
  );
  if (!spawnDeclared) return;
  const waitDeclared = declared.some(
    (tool) => tool.namespace === "collaboration" && tool.name === "wait_agent",
  );
  insertRequestGuidance({
    request: context.request,
    interactionType: context.interactionType,
    guidance: nativeDelegationGuidance(waitDeclared),
  });
}

const EXTERNAL_REMEDY_WORKFLOW_GUIDANCE = [
  "The organization's guardrails policy can block a tool call and offer remedy plans in its ruling.",
  "A remedy plan is the policy's own way to continue, and execute_remedy_plan applies the plan through the policy.",
  "A plan fits unless the narrower session could no longer do what the user asked for or will clearly ask next.",
  "Apply a fitting plan with execute_remedy_plan.",
  "Use the offer_id and plan from the ruling.",
  "The policy decides when the user must approve a plan.",
  "In that case, execute_remedy_plan returns review_required.",
  "Then ask the user with the declared ask_user tool.",
  "Put the offer ID in remedy_offer_ids, and use the header Approval and the options Approve and Deny.",
  "The platform shows the user the exact review.",
  "Retry the blocked call only after execute_remedy_plan reports that the plan is authorized.",
  "If a plan makes no sense, you keep getting blocked, the user keeps being asked to approve similar calls, or the user is frustrated, call yell.",
].join(" ");

const LEGACY_NATIVE_QUESTION_ID_PATTERN =
  /^(toolu|call|aq)_aq1_([A-Za-z0-9_-]{16})_([A-Za-z0-9_-]{22})$/;

function isSpecialToolMember(
  binding: AppaPluginBinding,
  call: { name: string; namespace?: string },
  role: "control" | "notice" | "askUser",
): boolean {
  const tools = binding.request.tools;
  if (!tools) return false;
  const selected = tools[role];
  const members = tools[`${role}Aliases`] ?? (selected ? [selected] : []);
  return members.some(
    (member) =>
      member.name === call.name && member.namespace === call.namespace,
  );
}

function isUserQuestionCall(binding: AppaPluginBinding, name: string): boolean {
  return (
    nativeQuestionName(binding, name) !== undefined ||
    isSpecialToolMember(binding, { name }, "askUser")
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
    return isSpecialToolMember(binding, call, "askUser");
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
 * Gives a pending review a unique cache key only when the call is an actual
 * native question. Ordinary questions keep their original identifiers.
 */
function withNativeQuestionId(
  binding: AppaPluginBinding,
  call: ToolCall,
): { call: ToolCall; question: { id: string; name: string } } | undefined {
  const name = nativeQuestionName(binding, call.name);
  if (!name || !releasesUserQuestion(binding, call)) return undefined;
  const id = issueNativeQuestionId({
    currentId: call.id,
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
          ...(question.inspectable ? { inspectable: true } : {}),
          ...(question.reviewText ? { reviewText: true } : {}),
          ...(question.digest ? { digest: question.digest } : {}),
          ...(question.askedQuestion
            ? { askedQuestion: question.askedQuestion }
            : {}),
        },
        HITL_QUESTION_TTL_MS,
      ),
    ),
  );
  // The review a question asks about must outlive the question: an answer
  // that still binds to its question is read against that review, and a
  // review gone by then would turn the answer into no ruling.
  for (const question of questions) {
    for (const offerId of question.offerIds) {
      if (await renewHitlReview({ session: binding.session, offerId }))
        continue;
      logger.warn(
        { client: binding.adapter?.id, offerId },
        "OpenAPPA asked a native approval question about a review that is not staged",
      );
    }
  }
}

function isUserQuestionResult(params: {
  binding: AppaPluginBinding;
  answer: { id: string; name: string; namespace?: string };
}): boolean {
  if (!releasesUserQuestion(params.binding, params.answer)) return false;
  if (
    params.binding.request.tools?.platformToolNames?.has(params.answer.name) ===
    true
  )
    return true;
  // Adapters pair answers with real client tool-call frames, not tool text.
  // Approval recording still requires the separate, one-use cache binding.
  return nativeQuestionName(params.binding, params.answer.name) !== undefined;
}

async function claimNativeQuestionResults(params: {
  binding: AppaPluginBinding;
  results: ReadonlyArray<{ id: string; name: string; namespace?: string }>;
}): Promise<Map<object, NativeQuestionClaim>> {
  const candidates = params.results.flatMap((result) => {
    // An answer without its own string id names no issued question: it is
    // dropped before any claim key is built or looked up, never conflated
    // with other unidentifiable answers under a placeholder id.
    if (typeof result.id !== "string" || result.id.length === 0) return [];
    const name = nativeQuestionName(params.binding, result.name);
    if (!name || !releasesUserQuestion(params.binding, result)) return [];
    const scope = { session: params.binding.session, id: result.id };
    const legacyKey = legacyNativeQuestionCacheKey(scope);
    return [
      {
        result,
        name,
        keys: [
          nativeQuestionCacheKey(scope),
          ...(legacyKey ? [legacyKey] : []),
        ],
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
        inspectable?: unknown;
        reviewText?: unknown;
        digest?: unknown;
        askedQuestion?: unknown;
        /** A pre-upgrade page card's binding; those cards are gone. */
        page?: unknown;
      }>(candidates.flatMap((candidate) => candidate.keys))
    ).map((entry) => [entry.key, entry.value]),
  );
  for (const candidate of candidates) {
    const entry = candidate.keys
      .map((key) => claimed.get(key))
      .find((value) => value?.name === candidate.name);
    if (entry?.name === candidate.name) {
      // A card issued by the removed paged review never grants anything:
      // its answer is unverified, and the review re-asks or stays open.
      if (entry.page !== undefined) continue;
      const offerIds = Array.isArray(entry.offerIds)
        ? entry.offerIds.filter(
            (offerId): offerId is string =>
              typeof offerId === "string" && offerId.length > 0,
          )
        : undefined;
      verified.set(candidate.result, {
        ...(offerIds && offerIds.length > 0 ? { offerIds } : {}),
        ...(entry.inspectable === true ? { inspectable: true } : {}),
        ...(entry.reviewText === true ? { reviewText: true } : {}),
        ...(typeof entry.askedQuestion === "string"
          ? { askedQuestion: entry.askedQuestion }
          : {}),
        ...(typeof entry.digest === "string" && entry.digest.length > 0
          ? { digest: entry.digest }
          : {}),
      });
    }
  }
  return verified;
}

async function recordNativeHitlRulings(params: {
  binding: AppaPluginBinding;
  verifiedNativeQuestionResults: ReadonlyMap<object, NativeQuestionClaim>;
}): Promise<{
  rulings: RecordedNativeHitlRuling[];
  unreadOfferIds: string[];
  continued: HitlReviewContinuation[];
  expiredOfferIds: string[];
}> {
  const native = params.binding.adapter?.nativeQuestion;
  const parse = native?.rulingFromResult;
  if (!parse)
    return {
      rulings: [],
      unreadOfferIds: [],
      continued: [],
      expiredOfferIds: [],
    };
  const recorded: RecordedNativeHitlRuling[] = [];
  const unreadOfferIds: string[] = [];
  const continued: HitlReviewContinuation[] = [];
  const expiredOfferIds: string[] = [];
  for (const [answer, claim] of params.verifiedNativeQuestionResults) {
    if (!claim.offerIds || claim.offerIds.length === 0 || !isRecord(answer))
      continue;
    if (claim.inspectable) {
      // An inspectable card's answer rules the review or opens its complete
      // text, read against the card as issued and the inspection state.
      if (claim.offerIds.length !== 1) continue;
      const outcome = await recordInspectableHitlAnswer({
        binding: params.binding,
        answer,
        offerId: claim.offerIds[0],
        carriedReviewText: claim.reviewText === true,
        // An inspectable claim without its payload digest matches nothing.
        claimDigest: claim.digest ?? "",
        askedQuestion: claim.askedQuestion,
      });
      if (outcome.kind === "ruling") recorded.push(outcome.ruling);
      // A dropped answer records nothing and advances nothing.
      else if (outcome.kind === "continued")
        continued.push(outcome.continuation);
      continue;
    }
    // The question the answer is read against comes from the review this
    // server holds, the same source the question was issued from.
    const asked = await getHitlAskUserArguments({
      session: params.binding.session,
      offerIds: claim.offerIds,
    });
    if (!asked) {
      // Without the review the answer cannot be read. A decision the review
      // already reached stands. Otherwise the review expired, and no closure
      // is sealed: a person who answered must not read as a refusal, and the
      // next remedy call stages the review again.
      for (const offerId of claim.offerIds) {
        const decision = await peekHitlDecision({
          session: params.binding.session,
          offerId,
        });
        if (
          decision?.ruling === "deny" ||
          (decision?.ruling === "none" && decision.closure)
        ) {
          recorded.push({ offerId, ruling: decision.ruling });
          continue;
        }
        logger.warn(
          {
            client: params.binding.adapter?.id,
            userAgent: params.binding.requestHeaders["user-agent"],
            offerId,
          },
          "OpenAPPA native approval answer arrived after its review expired",
        );
        expiredOfferIds.push(offerId);
      }
      continue;
    }
    const reading = parse(
      {
        content:
          typeof answer.content === "string"
            ? answer.content
            : JSON.stringify(answer.content ?? null),
        ...(typeof answer.isError === "boolean"
          ? { isError: answer.isError }
          : {}),
      },
      asked,
    );
    if (reading === "unrecognized") {
      // A client version may word its answer differently. Nothing is read
      // from it; a client with forms is asked again there. A known no-answer
      // does not take this path.
      logger.warn(
        {
          client: params.binding.adapter?.id,
          userAgent: params.binding.requestHeaders["user-agent"],
          offerIds: claim.offerIds,
          askedAgainInForm: native.formFallback === true,
        },
        "OpenAPPA could not read the answer to a native approval question",
      );
      if (native.formFallback) {
        for (const offerId of claim.offerIds) {
          await askHitlReviewInForm({
            session: params.binding.session,
            offerId,
          });
          unreadOfferIds.push(offerId);
        }
        continue;
      }
    }
    if (
      isNativeNoAnswer(reading) ||
      reading === "unrecognized" ||
      reading === "none"
    ) {
      for (const offerId of claim.offerIds) {
        const review = await getHitlReview({
          session: params.binding.session,
          offerId,
        });
        const sealed = await sealHitlClosure({
          session: params.binding.session,
          offerId,
          ...(isNativeNoAnswer(reading) ? { closure: reading } : {}),
        });
        const ruling =
          sealed === "approve" || sealed === "deny" ? sealed : "none";
        recorded.push({
          offerId,
          ruling,
          ...(review?.tool ? { reviewedTool: review.tool } : {}),
          ...(review?.arguments ? { reviewedArguments: review.arguments } : {}),
        });
      }
      continue;
    }
    const ruling = reading;
    logger.debug(
      {
        ruling,
        offerIds: claim.offerIds,
        contentType: Array.isArray(answer.content)
          ? "array"
          : typeof answer.content,
      },
      "OpenAPPA recorded a native HITL answer",
    );
    for (const offerId of claim.offerIds) {
      const review = await getHitlReview({
        session: params.binding.session,
        offerId,
      });
      if (
        await recordHitlRuling({
          session: params.binding.session,
          offerId,
          ruling,
        })
      ) {
        recorded.push({
          offerId,
          ruling,
          ...(review?.tool ? { reviewedTool: review.tool } : {}),
          ...(review?.arguments ? { reviewedArguments: review.arguments } : {}),
        });
      }
    }
  }
  return { rulings: recorded, unreadOfferIds, continued, expiredOfferIds };
}

/**
 * An inspect answer that asks for the complete review text (or a card answer
 * that cannot rule): the model must re-ask for the same review. Neither is a
 * ruling, and neither closes the review.
 */
type HitlReviewContinuation = {
  offerId: string;
  resultId: string;
  selection: "inspect" | "shown" | "stale";
};

type InspectableHitlAnswerOutcome =
  | { kind: "ruling"; ruling: RecordedNativeHitlRuling }
  | { kind: "continued"; continuation: HitlReviewContinuation }
  | { kind: "drop" };

/**
 * Reads the answer to a card that offered Inspect. Allow and Deny record the
 * ruling; Inspect asks for the complete review as conversation text. An
 * answer to a previous-layout card counts the same, except that its Approve
 * shows the current card again. A known no-answer seals the review as
 * before; an unreadable answer fails closed without the form. A stale
 * answer — a card superseded before its inspection text was delivered, a
 * forged marker — changes nothing. An
 * answer without its own string id is dropped: it rules nothing, and no
 * placeholder id may stand in for it.
 */
async function recordInspectableHitlAnswer(params: {
  askedQuestion?: string;
  binding: AppaPluginBinding;
  answer: Record<string, unknown>;
  offerId: string;
  carriedReviewText: boolean;
  claimDigest: string;
}): Promise<InspectableHitlAnswerOutcome> {
  const { binding, offerId } = params;
  const session = binding.session;
  if (typeof params.answer.id !== "string" || params.answer.id.length === 0) {
    // An unidentifiable answer claims nothing: no ruling, no continuation,
    // and nothing cached under a placeholder id it would share with every
    // other unidentifiable answer.
    logger.warn(
      { client: binding.adapter?.id, offerId },
      "OpenAPPA dropped an unidentifiable answer to a review card",
    );
    return { kind: "drop" };
  }
  const resultId = params.answer.id;
  const stale: InspectableHitlAnswerOutcome = {
    kind: "continued",
    continuation: { offerId, resultId, selection: "stale" },
  };
  const asked = await getHitlInspectableAskUserArguments({
    session,
    offerIds: [offerId],
    emit: false,
    carriedReviewText: params.carriedReviewText,
  });
  if (!asked) {
    // The review may have closed while the card was out. Then the answer is
    // late, not stale, and the recorded ruling stands in for it.
    if (await peekHitlDecision({ session, offerId })) {
      return { kind: "ruling", ruling: await sealInspectableClosure(params) };
    }
    logger.warn(
      { client: binding.adapter?.id, offerId },
      "OpenAPPA refused an answer to a superseded review card",
    );
    return stale;
  }
  const result = {
    content:
      typeof params.answer.content === "string"
        ? params.answer.content
        : JSON.stringify(params.answer.content ?? null),
    ...(typeof params.answer.isError === "boolean"
      ? { isError: params.answer.isError }
      : {}),
  };
  let reading = labeledQuestionRuling(
    result,
    params.askedQuestion ?? asked.card.shortQuestion ?? asked.card.question,
    asked.card.options.map((option) => option.label),
  );
  let answer =
    typeof reading === "object"
      ? hitlReviewCardAnswer(reading.label)
      : undefined;
  if (reading === "unrecognized" && !params.askedQuestion) {
    // A card of the previous layout, issued before a deploy, can still be open.
    for (const question of asked.previousQuestions) {
      const previous = labeledQuestionRuling(
        result,
        question,
        PREVIOUS_HITL_CARD_LABELS,
      );
      if (typeof previous !== "object") continue;
      const choice = previousHitlCardAnswer(previous.label);
      if (choice === "ask-again") {
        logger.warn(
          { client: binding.adapter?.id, offerId },
          "OpenAPPA asked again for an approval given on a previous card layout",
        );
        return stale;
      }
      reading = previous;
      answer = choice;
      break;
    }
  }
  if (typeof reading === "object") {
    if (answer) {
      const resolved = await resolveHitlInspectableAnswer({
        session,
        offerId,
        answer,
        carriedReviewText: params.carriedReviewText,
        claimDigest: params.claimDigest,
      });
      switch (resolved.status) {
        case "inspect-pending":
          return {
            kind: "continued",
            continuation: { offerId, resultId, selection: "inspect" },
          };
        case "inspect-shown":
          return {
            kind: "continued",
            continuation: { offerId, resultId, selection: "shown" },
          };
        case "stale":
          // A pending inspection withholds approval until its text is delivered.
          logger.warn(
            { client: binding.adapter?.id, offerId },
            "OpenAPPA refused an approval ahead of the requested review text",
          );
          return stale;
        case "closed":
          // A concurrent ruling won; the stored decision stands in.
          return {
            kind: "ruling",
            ruling: await sealInspectableClosure(params),
          };
        case "recorded": {
          const review = await getHitlReview({ session, offerId });
          return {
            kind: "ruling",
            ruling: {
              offerId,
              ruling: resolved.ruling,
              ...(review?.tool ? { reviewedTool: review.tool } : {}),
              ...(review?.arguments
                ? { reviewedArguments: review.arguments }
                : {}),
            },
          };
        }
      }
    }
    // A label this card never offered is no answer at all.
    return { kind: "ruling", ruling: await sealInspectableClosure(params) };
  }
  // An answer the adapter cannot read closes the review without a ruling:
  // the gateway form would show the whole question again, and a form
  // approval must not skip the inspection the reviewer requested.
  return {
    kind: "ruling",
    ruling: await sealInspectableClosure({
      ...params,
      ...(reading === "unrecognized" ? {} : { closure: reading }),
    }),
  };
}

/** The stored decision after an inspectable review ended, as the existing path reads it. */
async function sealInspectableClosure(params: {
  binding: AppaPluginBinding;
  offerId: string;
  closure?: "declined" | "cancelled" | "unanswered" | "unavailable";
}): Promise<RecordedNativeHitlRuling> {
  const { binding, offerId } = params;
  const review = await getHitlReview({ session: binding.session, offerId });
  const sealed = await sealHitlClosure({
    session: binding.session,
    offerId,
    ...(params.closure ? { closure: params.closure } : {}),
  });
  return {
    offerId,
    ruling: sealed === "approve" || sealed === "deny" ? sealed : "none",
    ...(review?.tool ? { reviewedTool: review.tool } : {}),
    ...(review?.arguments ? { reviewedArguments: review.arguments } : {}),
  };
}

/**
 * Whether an offer-backed ask_user call becomes an inspectable native card:
 * Claude needs transport support for review text. OpenCode-family questions
 * carry it in the native input, including on transports with no text injection.
 * Their connection plugin enhances presentation; native surfaces remain usable.
 */
// SPDX-SnippetBegin
// SPDX-SnippetCopyrightText: 2026 Archestra Inc.
// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
function inspectsNatively(
  binding: AppaPluginBinding,
  canShowToolCallReview: boolean,
): boolean {
  const native = binding.adapter?.nativeQuestion;
  return (
    !!native?.fromAskUser &&
    native.isAvailable?.(binding.requestHeaders) !== false &&
    declaresNativeQuestion(binding, native.toolName) &&
    ((binding.adapter?.id === "claude-code" && canShowToolCallReview) ||
      ((binding.adapter?.id === "opencode" || binding.adapter?.id === "kilo") &&
        binding.requestHeaders["x-archestra-question-cards"] === "1"))
  );
}

// SPDX-SnippetEnd

function assertUniqueNativeQuestionResultIds(params: {
  binding: AppaPluginBinding;
  results: ReadonlyArray<{ id: string; name: string; namespace?: string }>;
}): void {
  const questionIds = new Set<string>();
  for (const result of params.results) {
    const name = nativeQuestionName(params.binding, result.name);
    if (name && releasesUserQuestion(params.binding, result)) {
      questionIds.add(result.id);
    }
  }
  const seen = new Set<string>();
  for (const result of params.results) {
    if (seen.has(result.id) && questionIds.has(result.id)) {
      throw new ApiError(
        400,
        "OpenAPPA does not allow duplicate native question result IDs",
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

function issueNativeQuestionId(params: { currentId: string }): string {
  const nonce = randomBytes(12).toString("base64url");
  const prefix = params.currentId.startsWith("toolu_")
    ? "toolu"
    : params.currentId.startsWith("call_")
      ? "call"
      : "aq";
  return `${prefix}_aq2_${nonce}`;
}

function nativeQuestionCacheKey(params: {
  session: OpenAppaSession;
  id: string;
}): AllowedCacheKey {
  const scope = createHash("sha256")
    .update(
      JSON.stringify([
        params.session.organization_id,
        params.session.caller_id ?? "",
        params.session.session_id,
        params.session.parent_id ?? "",
        params.id,
      ]),
    )
    .digest("base64url");
  return `${CacheKey.OpenAppaNativeQuestion}-${scope}`;
}

/**
 * Where the canonical result text of an answered review card lives, scoped
 * like the one-use claim it stands in for: this session's answer to this
 * result id. Another session's or caller's history can never name the same
 * entry.
 */
function hitlReviewContinuationKey(params: {
  session: OpenAppaSession;
  resultId: string;
}): AllowedCacheKey {
  const scope = createHash("sha256")
    .update(
      JSON.stringify([
        params.session.organization_id,
        params.session.caller_id ?? "",
        params.session.session_id,
        params.session.parent_id ?? "",
        params.resultId,
      ]),
    )
    .digest("base64url");
  return `${CacheKey.OpenAppaHitlReviewContinuation}-${scope}`;
}

/**
 * The review-card instructions this request's re-sent history answers already
 * read. Reading is not claiming: nothing here records a ruling, opens an
 * inspection, or expires with the review, and the stored text has authority
 * over whatever content the client carries now. A hit refreshes its lease, so
 * a conversation that outlives a day keeps its history stable.
 */
async function replayedReviewContinuations(params: {
  binding: AppaPluginBinding;
  results: ReadonlyArray<{ id: string; name: string; namespace?: string }>;
  answered: Readonly<Record<string, string>>;
}): Promise<Record<string, string>> {
  const { binding } = params;
  const keys = new Map<string, AllowedCacheKey>();
  for (const result of params.results) {
    // An answer without its own string id names no continuation and looks
    // nothing up.
    if (typeof result.id !== "string" || result.id.length === 0) continue;
    if (params.answered[result.id] !== undefined) continue;
    if (!nativeQuestionName(binding, result.name)) continue;
    if (!releasesUserQuestion(binding, result)) continue;
    keys.set(
      result.id,
      hitlReviewContinuationKey({
        session: binding.session,
        resultId: result.id,
      }),
    );
  }
  const updates: Record<string, string> = Object.create(null);
  if (keys.size === 0) return updates;
  const stored = await cacheManager.getMany<string>([...keys.values()]);
  const renewals: Promise<void>[] = [];
  for (const [resultId, key] of keys) {
    const instruction = stored.get(key);
    if (instruction === undefined) continue;
    updates[resultId] = instruction;
    renewals.push(renewContinuationLease(key, instruction));
  }
  // Each renewal rewrites only its own row, so the independent keys renew
  // together; the fan-out is bounded by this request's own result count.
  await Promise.all(renewals);
  return updates;
}

/** A lease renewal loses only itself on failure, never the request. */
async function renewContinuationLease(
  key: AllowedCacheKey,
  instruction: string,
): Promise<void> {
  try {
    await cacheManager.set(key, instruction, TimeInMs.Day);
  } catch {
    logger.warn("OpenAPPA could not refresh a review continuation");
  }
}

/** Pending pre-upgrade questions expire after ten minutes. New IDs use no MAC. */
function legacyNativeQuestionCacheKey(params: {
  session: OpenAppaSession;
  id: string;
}): AllowedCacheKey | undefined {
  if (
    !config.openappa.offerSigningSecret ||
    !LEGACY_NATIVE_QUESTION_ID_PATTERN.test(params.id)
  )
    return undefined;
  const scope = createHmac("sha256", config.openappa.offerSigningSecret)
    .update("archestra-native-question-v1\0")
    .update(
      JSON.stringify([
        params.session.organization_id,
        params.session.caller_id ?? "",
        params.session.session_id,
        params.session.parent_id ?? "",
        "cache",
        params.id,
      ]),
    )
    .digest()
    .subarray(0, 16)
    .toString("base64url");
  return `${CacheKey.OpenAppaNativeQuestion}-${scope}`;
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
  const namespace =
    result.namespace ?? binding.request.tools?.namespaces?.get(result.name);
  if (
    !isSpecialToolMember(binding, { name: result.name, namespace }, "control")
  )
    return false;
  return reviewResultStatus(result.content, 0) === null;
}

async function pendingReviewResult(
  binding: AppaPluginBinding,
  result: LlmProxyToolResultsContext["toolResults"][number],
): Promise<string | undefined> {
  const namespace =
    result.namespace ?? binding.request.tools?.namespaces?.get(result.name);
  if (
    result.isError ||
    !isSpecialToolMember(binding, { name: result.name, namespace }, "control")
  )
    return undefined;
  const status = reviewResultStatus(result.content, 0);
  if (!status) return undefined;
  const { offerId, outcome } = status;
  const pending =
    outcome === "review_required"
      ? await getHitlReview({ session: binding.session, offerId })
      : undefined;
  const recordedOutcome = await getHitlReviewResult({
    session: binding.session,
    callId: result.id,
    offerId,
  });
  if (recordedOutcome !== undefined ? recordedOutcome !== outcome : !pending)
    return undefined;
  // Only a server-staged review may produce this status. Never forward arbitrary
  // client instruction text or treat the status itself as an approval receipt.
  return JSON.stringify({
    ok: false,
    outcome,
    offer_id: offerId,
    instruction: reviewStatusInstruction(outcome),
  });
}

function isClaudeProgressLabelRequest(
  request: unknown,
  spawnPromptDigest: string | undefined,
): boolean {
  if (!isRecord(request) || !Array.isArray(request.messages)) return false;
  const last = request.messages.at(-1);
  if (!isRecord(last) || last.role !== "user") return false;
  const prompt =
    typeof last.content === "string"
      ? last.content
      : Array.isArray(last.content)
        ? last.content
            .filter((block) => isRecord(block) && block.type === "text")
            .map((block) => block.text)
            .join("\n")
        : "";
  // An admitted opening task can use the same prefix as a progress-label frame.
  if (spawnPromptDigest && isDelegatedPrompt(prompt, spawnPromptDigest))
    return false;
  // Claude appends this dedicated user frame for a UI label, not a task result.
  // Do not match tool_result text or historical task instructions.
  return prompt.startsWith(
    "Describe your most recent action in 3-5 words using present tense (-ing). Name the file or function, not the branch. Do not use tools.\n\n",
  );
}

async function pendingNativeHitlOfferIds(params: {
  binding: AppaPluginBinding;
  results: LlmProxyToolResultsContext["toolResults"];
  resolvedOfferIds: ReadonlySet<string>;
}): Promise<string[]> {
  const control = params.binding.request.tools?.control;
  if (!control) return [];
  // The newest result that asked for this review, per offer: the history is
  // in order, so a later execute_remedy_plan call replaces an earlier one.
  const offerIds = new Map<string, string>();
  for (const result of params.results) {
    if (result.isError) continue;
    if (
      !isSpecialToolMember(
        params.binding,
        {
          name: result.name,
          namespace:
            result.namespace ??
            params.binding.request.tools?.namespaces?.get(result.name),
        },
        "control",
      )
    )
      continue;
    const offerId = reviewRequiredOfferId(result, 0);
    if (offerId && !params.resolvedOfferIds.has(offerId)) {
      offerIds.set(offerId, result.id);
    }
  }
  const pending = await Promise.all(
    [...offerIds].map(async ([offerId, resultId]) => ({
      offerId,
      resultId,
      review: await getHitlReview({
        session: params.binding.session,
        offerId,
      }),
    })),
  );
  const asked: string[] = [];
  for (const entry of pending) {
    if (entry.review === undefined) continue;
    // A client that resends the whole conversation (Codex) carries this
    // result in every later request. The question is asked once per result:
    // asking again for a review the client cannot show forces Codex into
    // another ask_user call on every turn, with no way to end its turn.
    if (
      await reviewQuestionAskedBefore({
        session: params.binding.session,
        resultId: entry.resultId,
      })
    ) {
      continue;
    }
    asked.push(entry.offerId);
  }
  return asked;
}

/**
 * Whether the proxy already asked for the user's approval after this
 * review_required result. Records the current ask so the next one counts.
 * Not atomic: a client sends a session's requests one after another, and two
 * parallel requests could at worst ask once more, never skip the question.
 */
async function reviewQuestionAskedBefore(params: {
  session: OpenAppaSession;
  resultId: string;
}): Promise<boolean> {
  const key: AllowedCacheKey = `${CacheKey.OpenAppaHitlQuestionAsked}-${Buffer.from(
    `${params.session.organization_id}:${params.session.session_id}:${withoutTrajectoryStamp(params.resultId)}`,
  ).toString("base64url")}`;
  if (await cacheManager.get<boolean>(key)) return true;
  // Outlives the review it asked about, which expires after ten minutes.
  await cacheManager.set(key, true, TimeInMs.Hour);
  return false;
}

async function hasRemedyOfferResult(params: {
  binding: AppaPluginBinding;
  results: LlmProxyToolResultsContext["toolResults"];
  toolResultUpdates: Awaited<
    ReturnType<typeof processProxyResults>
  >["toolResultUpdates"];
  verifiedNativeQuestionResults: ReadonlyMap<object, NativeQuestionClaim>;
}): Promise<boolean> {
  // Restored notice IDs are client-carried structure, not proof of issuance.
  // The runtime must supply the ruling and this session must own its call.
  const session = params.binding.session;
  const recorded = await OpenAppaSessionModel.recordedToolCallDecisions({
    organizationId: session.organization_id,
    sessionId: session.session_id,
    callerId: session.caller_id,
    parentId: session.parent_id,
    toolCallIds: params.results.map((result) =>
      withoutTrajectoryStamp(result.id),
    ),
  });
  const blocked = params.results.flatMap((result, index) => {
    const id = withoutTrajectoryStamp(result.id);
    if (!recorded.has(id)) return [];
    const decision = recorded.get(id);
    const offeredRuling =
      isRecord(decision) &&
      decision.decision === "deny_call" &&
      typeof decision.feedback === "string" &&
      Array.isArray(decision.offers) &&
      decision.offers.some(
        (offer) =>
          isRecord(offer) &&
          typeof offer.offer_id === "string" &&
          offer.offer_id.length > 0,
      )
        ? decision.feedback
        : undefined;
    if (
      params.toolResultUpdates[result.id] === undefined &&
      offeredRuling !== undefined
    ) {
      // Restored spawn notices stay pending, so the service correctly skips
      // execution results. Their ruling still comes from the runtime journal.
      params.toolResultUpdates[result.id] = {
        content: offeredRuling,
        outputSource: "runtime",
      };
    }
    const approved = params.toolResultUpdates[result.id];
    if (
      approved?.outputSource !== "runtime" ||
      approved.code === "unreleased_call"
    )
      return [];
    if (
      approved.denied &&
      (approved.offers !== undefined || approved.review?.length)
    ) {
      // Current denial metadata outranks both the original journal offer and
      // generic remedy hints. Unknown metadata still uses the scoped fallback.
      return approved.offers?.length || approved.review?.length ? [index] : [];
    }
    if (
      offeredRuling === undefined &&
      (!approved.content.includes("[appa] Blocked") ||
        !approved.content.includes("execute_remedy_plan") ||
        !approved.content.includes("offer_id"))
    )
      return [];
    return [index];
  });
  const latestBlockedResult = blocked.at(-1) ?? -1;
  if (latestBlockedResult < 0) return false;

  const control = params.binding.request.tools?.control;
  for (
    let index = latestBlockedResult + 1;
    index < params.results.length;
    index++
  ) {
    const result = params.results[index];
    if (
      params.verifiedNativeQuestionResults.has(result) ||
      isUserQuestionResult({ binding: params.binding, answer: result })
    )
      return false;
    if (!control) continue;
    if (
      isSpecialToolMember(
        params.binding,
        {
          name: result.name,
          namespace:
            result.namespace ??
            params.binding.request.tools?.namespaces?.get(result.name),
        },
        "control",
      )
    ) {
      return false;
    }
  }
  return true;
}

function reviewStatusInstruction(outcome: HitlReviewOutcome): string {
  const instructions = {
    review_required:
      "Ask the user with the declared ask_user tool and this offer ID in remedy_offer_ids. The platform shows the exact review with Approve and Deny choices. Call execute_remedy_plan again only after the user approves.",
    review_declined:
      "The client declined the approval review. That is not a human denial. The protected call remains blocked; no ruling was granted. Do not reopen this review.",
    review_unanswered:
      "The approval review expired without an answer. The protected call remains blocked; no ruling was granted. Do not retry this expired review.",
    review_cancelled:
      "The client canceled the approval review. That does not show a person saw it. The protected call remains blocked; no ruling was granted. Do not reopen this review.",
    review_unavailable:
      "The approval review could not be delivered in this session. The protected call remains blocked; no ruling was granted.",
    review_invalid:
      "The approval review did not receive a valid decision. The protected call remains blocked; no ruling was granted.",
  } satisfies Record<HitlReviewOutcome, string>;
  return instructions[outcome];
}

function isNativeNoAnswer(
  reading: NativeQuestionReading,
): reading is NativeQuestionNoAnswer {
  return (
    reading === "declined" ||
    reading === "cancelled" ||
    reading === "unanswered" ||
    reading === "unavailable"
  );
}

function reviewRequiredOfferId(value: unknown, depth: number): string | null {
  const status = reviewResultStatus(value, depth);
  return status?.outcome === "review_required" ? status.offerId : null;
}

function reviewResultStatus(
  value: unknown,
  depth: number,
): { offerId: string; outcome: HitlReviewOutcome } | null {
  if (depth > 4 || value === null || value === undefined) return null;
  if (typeof value === "string") {
    try {
      return reviewResultStatus(JSON.parse(value), depth + 1);
    } catch {
      for (const line of value.split(/\r?\n/)) {
        const candidate = line.trim();
        if (!candidate.startsWith("{") && !candidate.startsWith("[")) continue;
        try {
          const status = reviewResultStatus(JSON.parse(candidate), depth + 1);
          if (status) return status;
        } catch {
          // Continue past non-JSON log lines and bounded metadata.
        }
      }
      return null;
    }
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const status = reviewResultStatus(item, depth + 1);
      if (status) return status;
    }
    return null;
  }
  if (!isRecord(value)) return null;
  if (
    isHitlReviewOutcome(value.outcome) &&
    typeof value.offer_id === "string" &&
    value.offer_id.length > 0
  ) {
    return { offerId: value.offer_id, outcome: value.outcome };
  }
  for (const nested of [value.structuredContent, value.content, value.text]) {
    const status = reviewResultStatus(nested, depth + 1);
    if (status) return status;
  }
  return null;
}

function unreadNativeAnswerGuidance(offerIds: readonly string[]): string {
  return [
    "The platform could not read the answer to the last approval question, so it recorded nothing and the call stays blocked.",
    "Ask once more with the declared ask_user tool, one call for each offer ID below.",
    HITL_ASK_USER_CALL,
    "The platform replaces the question text with the exact review. This time it opens as a form.",
    `Offer IDs: ${JSON.stringify(offerIds)}.`,
  ].join(" ");
}

function expiredNativeQuestionGuidance(offerIds: readonly string[]): string {
  return [
    "The last approval question was answered after its OpenAPPA review expired, so the platform recorded no ruling and the call stays blocked.",
    "Call execute_remedy_plan again with the plan shown earlier in the conversation; the platform then asks the user again.",
    "Retry the blocked call only after execute_remedy_plan reports that the plan is authorized.",
    `Offer IDs: ${JSON.stringify(offerIds)}.`,
  ].join(" ");
}

function hitlQuestionGuidance(offerIds: readonly string[]): string {
  return [
    "The policy needs the user's approval for the last execute_remedy_plan result.",
    "Ask the user with the declared ask_user tool, one call for each offer ID below.",
    HITL_ASK_USER_CALL,
    "The platform replaces the question text with the exact review, and shows it in the client's question interface when one is available.",
    `Offer IDs: ${JSON.stringify(offerIds)}.`,
  ].join(" ");
}

/** What the model reads as the result of an inspectable card's answer. */
function continuedReviewInstruction(params: {
  binding: AppaPluginBinding;
  continuation: HitlReviewContinuation;
}): string {
  const { continuation } = params;
  const askUser =
    params.binding.request.tools?.askUser?.name ?? "the declared ask_user tool";
  const reAsk = `Call ${askUser} once more with remedy_offer_ids [${JSON.stringify(continuation.offerId)}] to show the same review's card again.`;
  const noRuling =
    "This is not an approval and not a denial; the review stays open. Do not call execute_remedy_plan and do not retry the blocked call until the platform reports that the user approved.";
  const platformRendered =
    "The platform renders the review card and its review text itself; do not reconstruct, quote, or narrate their contents.";
  if (continuation.selection === "stale") {
    return `[appa] That review card was superseded, so its answer was not recorded. ${reAsk} ${noRuling} ${platformRendered}`;
  }
  if (continuation.selection === "shown") {
    return `[appa] The reviewer opened "${HITL_INSPECT_LABEL}" again; the complete review is already in the conversation above, so it is not repeated. ${reAsk} ${noRuling} ${platformRendered}`;
  }
  return `[appa] The reviewer chose "${HITL_INSPECT_LABEL}" on the review card; the platform will place the complete, authoritative review as its own message immediately above the same approval card. ${reAsk} ${noRuling} ${platformRendered}`;
}

// Only remedy_offer_ids decides what is asked: the platform puts the review it
// holds in place of the rest.
const HITL_ASK_USER_CALL =
  "In each call, use the question 'Open the pending HITL review.', the header 'Approval', the options Approve and Deny, and remedy_offer_ids with only that offer ID.";

function hitlDecisionGuidance(
  rulings: readonly RecordedNativeHitlRuling[],
): string {
  const approved = rulings
    .filter((entry) => entry.ruling === "approve")
    .map((entry) => entry.offerId);
  if (approved.length > 0) {
    return [
      `The user approved OpenAPPA offer IDs ${JSON.stringify(approved)} in the question tool.`,
      "In your next response, call only execute_remedy_plan, once for each approved offer, with the plan shown earlier in the conversation.",
      "Retry the blocked call in a later response, after execute_remedy_plan reports that the plan is authorized.",
      "The user already answered, so do not ask about the same plan again.",
    ].join(" ");
  }
  return [
    "The user did not approve the pending OpenAPPA review.",
    "Do not call execute_remedy_plan for it, and do not retry the blocked call.",
    "Tell the user briefly that the action stays blocked, and stop that action.",
  ].join(" ");
}

function deliverReturnContract(params: {
  request: unknown;
  interactionType: string;
  contract: string;
}): void {
  const { request, contract } = params;
  const family = appaWireFamily(params.interactionType);
  switch (family) {
    case "openai:chatCompletions":
      mergeLeadingSystemMessage(request, contract);
      break;
    case "openai:responses":
    case "anthropic:messages":
      appendQuestionContinuation({
        request,
        interactionType: family,
        guidance: contract,
        scope: "request",
      });
      break;
  }
  if (!family || !requestCarriesContract({ request, family, contract })) {
    throw new ApiError(409, UNDELIVERABLE_RETURN_CONTRACT);
  }
}

/**
 * Chat Completions templates of many providers (vLLM, Mistral, Ollama, …)
 * accept a single system message only, and only first.
 */
function mergeLeadingSystemMessage(request: unknown, contract: string): void {
  if (!isRecord(request) || !Array.isArray(request.messages)) return;
  if (leadingSystemCarries(request.messages, contract)) return;
  const first = leadingSystemMessage(request.messages);
  if (!first) {
    request.messages.unshift({ role: "system", content: contract });
    return;
  }
  if (typeof first.content === "string" && first.content.length > 0) {
    first.content = `${first.content}\n\n${contract}`;
  } else if (Array.isArray(first.content)) {
    first.content.push({ type: "text", text: contract });
  } else {
    first.content = contract;
  }
}

function leadingSystemMessage(
  messages: unknown[],
): Record<string, unknown> | undefined {
  const [first] = messages;
  return isRecord(first) &&
    (first.role === "system" || first.role === "developer")
    ? first
    : undefined;
}

function leadingSystemCarries(messages: unknown[], contract: string): boolean {
  const first = leadingSystemMessage(messages);
  if (typeof first?.content === "string")
    return first.content.includes(contract);
  return (
    Array.isArray(first?.content) &&
    first.content.some(
      (part) =>
        isRecord(part) && part.type === "text" && part.text === contract,
    )
  );
}

function requestCarriesContract(params: {
  request: unknown;
  family: AppaWireFamily;
  contract: string;
}): boolean {
  const { request, family, contract } = params;
  switch (family) {
    case "openai:chatCompletions":
      return (
        isRecord(request) &&
        Array.isArray(request.messages) &&
        leadingSystemCarries(request.messages, contract)
      );
    case "openai:responses":
    case "anthropic:messages":
      return requestCarriesInstruction({
        request,
        interactionType: family,
        text: contract,
      });
  }
}

function requestCarriesInstruction(params: {
  request: unknown;
  interactionType: string;
  text: string;
}): boolean {
  const { request, interactionType, text } = params;
  if (!isRecord(request)) return false;
  if (interactionType === "openai:responses") {
    return (
      Array.isArray(request.input) &&
      request.input.some(
        (item) =>
          isRecord(item) &&
          item.role === "developer" &&
          Array.isArray(item.content) &&
          item.content.some(
            (block) =>
              isRecord(block) &&
              block.type === "input_text" &&
              block.text === text,
          ),
      )
    );
  }
  if (interactionType === "anthropic:messages") {
    if (Array.isArray(request.system)) {
      return request.system.some(
        (block) =>
          isRecord(block) && block.type === "text" && block.text === text,
      );
    }
    return typeof request.system === "string" && request.system.includes(text);
  }
  return false;
}

/**
 * Adds guidance for the whole request before the conversation, next to the
 * client's own developer instructions. After the user's message, such guidance
 * made the model answer a Codex greeting twice: once as commentary and again
 * as the final answer. Codex showed both. A continuation for one turn follows
 * a tool result, so it still goes last through appendQuestionContinuation.
 */
function insertRequestGuidance(params: {
  request: unknown;
  interactionType: string;
  guidance: string;
  /** A provider-thread continue: the thread already holds this guidance. */
  onContinue?: "skip";
}): void {
  const { request, interactionType, guidance } = params;
  if (
    interactionType !== "openai:responses" ||
    !isRecord(request) ||
    !Array.isArray(request.input)
  ) {
    appendQuestionContinuation({ ...params, scope: "request" });
    return;
  }
  if (requestCarriesInstruction({ request, interactionType, text: guidance })) {
    return;
  }
  const input = request.input;
  const conversationStart = input.findIndex(
    (item) =>
      !(
        isRecord(item) &&
        (item.type === "additional_tools" ||
          ((item.type === undefined || item.type === "message") &&
            (item.role === "developer" || item.role === "system")))
      ),
  );
  input.splice(conversationStart === -1 ? input.length : conversationStart, 0, {
    type: "message",
    role: "developer",
    content: [{ type: "input_text", text: guidance }],
  });
}

function appendQuestionContinuation(params: {
  request: unknown;
  interactionType: string;
  guidance?: string;
  /** Fixed request instructions precede history; turn guidance follows it. */
  scope?: "request" | "turn";
  /**
   * On a provider-thread continue: `skip` guidance the thread already holds
   * (fixed for the session), or deliver `turn` guidance in the new user turn,
   * which the thread keeps, instead of the system prompt it owns.
   */
  onContinue?: "skip" | "turn";
}): void {
  const guidance = params.guidance ?? QUESTION_CONTINUATION_GUIDANCE;
  if (!isRecord(params.request)) return;
  if (params.onContinue === "skip") return;
  if (params.onContinue === "turn") {
    appendToLastUserTurn(params.request, guidance);
    return;
  }
  if (params.interactionType === "openai:responses") {
    let input: unknown[];
    if (typeof params.request.input === "string") {
      input = [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: params.request.input }],
        },
      ];
      params.request.input = input;
    } else if (Array.isArray(params.request.input)) {
      input = params.request.input;
    } else {
      input = [];
      params.request.input = input;
    }
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
              block.text === guidance,
          ),
      )
    ) {
      input.push({
        type: "message",
        role: "developer",
        content: [{ type: "input_text", text: guidance }],
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
          message.content === guidance,
      )
    ) {
      return;
    }
    messages.push({
      role: "developer",
      content: guidance,
    });
    return;
  }
  if (params.interactionType === "anthropic:messages") {
    // Keep transient guidance after the cached prefix. Changing system would
    // invalidate all cached messages, including signed thinking blocks.
    if (params.scope !== "request") {
      appendToLastUserTurn(params.request, guidance);
      return;
    }
    if (Array.isArray(params.request.system)) {
      if (
        !params.request.system.some(
          (block) =>
            isRecord(block) && block.type === "text" && block.text === guidance,
        )
      ) {
        params.request.system.push({
          type: "text",
          text: guidance,
        });
      }
      return;
    }
    appendInstruction(params.request, "system", guidance);
  }
}

/** Adds turn guidance without placing user text after native SDK control frames. */
function appendToLastUserTurn(
  request: Record<string, unknown>,
  text: string,
): void {
  const messages = request.messages;
  if (!Array.isArray(messages)) return;
  let index = messages.length - 1;
  // Native SDKs can end a turn with system control messages. They must remain
  // last (or immediately before an assistant); they are not conversation turns.
  while (
    index >= 0 &&
    isRecord(messages[index]) &&
    messages[index].role === "system"
  )
    index--;
  const last = messages[index];
  if (!isRecord(last) || last.role !== "user") {
    messages.splice(index + 1, 0, {
      role: "user",
      content: [{ type: "text", text }],
    });
    return;
  }
  if (last.content === text) return;
  if (typeof last.content === "string")
    last.content = [
      { type: "text", text: last.content },
      { type: "text", text },
    ];
  else if (Array.isArray(last.content)) {
    if (
      !last.content.some(
        (block) =>
          isRecord(block) && block.type === "text" && block.text === text,
      )
    )
      last.content.push({ type: "text", text });
  } else last.content = [{ type: "text", text }];
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
    throw new ApiError(
      503,
      "OpenAPPA could not confirm Guardrails availability",
    );
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
