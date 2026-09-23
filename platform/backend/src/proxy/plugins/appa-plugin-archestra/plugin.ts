import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import {
  buildElicitationMandateInstruction,
  PROXY_STAMPED_TOOL_ARGUMENTS,
  TimeInMs,
  TOOL_ASK_USER_SHORT_NAME,
  TOOL_EXECUTE_REMEDY_PLAN_SHORT_NAME,
} from "@archestra/shared";
import { archestraMcpBranding } from "@/archestra-mcp-server/branding";
import { type AllowedCacheKey, CacheKey, cacheManager } from "@/cache-manager";
import config from "@/config";
import logger from "@/logging";
import { clientSessionId } from "@/openappa/actor";
import {
  childReturnReceiptsConfigured,
  mintChildReturnReceipt,
  verifyChildReturnReceipt,
} from "@/openappa/child-return";
import { mintChildTrajectoryReceipt } from "@/openappa/child-trajectory-receipt";
import { delegationEnabled, mintDelegationMarker } from "@/openappa/delegation";
import {
  getHitlAskUserArguments,
  getHitlReview,
  recordHitlRuling,
} from "@/openappa/hitl-review";
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
  approveSpawnReturn,
  cancelCalls,
  endChild,
  endTurn,
  evaluateHostedToolCalls,
  evaluateToolCalls,
  notePrompt,
  type OpenAppaSession,
  processProxyResults,
} from "@/openappa/service";
import {
  parseTrajectoryStamp,
  stampToolCallId,
} from "@/openappa/trajectory-stamp";
import { appaWireFamily } from "@/openappa/wire";
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
import type { ToolNameResolution } from "@/routes/proxy/utils/gateway-tool-names";
import { ApiError } from "@/types";
import { referencesChildTranscriptPath } from "./adapters/trajectory";
import {
  APPA_CHILD_TRAJECTORY_RECEIPT,
  APPA_PLUGIN_TRUSTED_CONTEXT,
  type AppaChildTrajectory,
  type AppaClientAdapter,
  type AppaTrustedContext,
  type AskUserArguments,
} from "./types";
import { withCallerScope, withoutCallerScope } from "./utils";

type AppaPluginBinding = {
  session: OpenAppaSession;
  identity: AppaTrustedContext["toolIdentity"];
  adapter: AppaClientAdapter | undefined;
  request: AppaTrustedContext["request"];
  requestBody: unknown;
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
  /** The native id this request's children will report as their parent. */
  spawnerNativeId: string | undefined;
  /** Server-bound child metadata needed to correlate its terminal return. */
  child?: AppaChildTrajectory;
  /**
   * Unscoped client session id for trajectory stamps. Captured before child
   * overlay so stamps never encode a minted parent:child id.
   */
  stampSessionId: string | undefined;
};

type NativeQuestionClaim = {
  offerIds?: string[];
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

  constructor(private readonly clientAdapters: readonly AppaClientAdapter[]) {}

  async onSessionInit(context: LlmProxyRequestContext): Promise<void> {
    this.bindings.delete(context.resources);
    const trustedContext = getTrustedContext(context.resources);
    if (!trustedContext) return;
    // Copy trusted context before adapter inspection to isolate plugin state.
    const chat = trustedContext.chatSource !== undefined;
    const binding: AppaPluginBinding = {
      session: trustedContext.session,
      identity: trustedContext.toolIdentity,
      adapter: undefined,
      request: trustedContext.request,
      requestBody: context.requestBody,
      turnOpen: false,
      chat,
      compaction: trustedContext.compaction === true,
      requestHeaders: context.headers,
      requiresQuestionContinuation: false,
      requiresRemedyContinuation: false,
      pendingHitlReviewOfferIds: [],
      nativeHitlRulings: [],
      spawnerNativeId: undefined,
      stampSessionId: tracesLineage(trustedContext.session, chat)
        ? clientSessionId(trustedContext.session.session_id)
        : undefined,
    };
    const matchContext = {
      headers: context.headers,
      requestBody: context.requestBody,
      trustedContext: cloneTrustedContext(trustedContext),
    };
    const adapter = this.clientAdapters.find((candidate) =>
      candidate.matches(matchContext),
    );
    binding.adapter = adapter;
    binding.spawnerNativeId = adapter?.nativeConversationId(matchContext);
    const child = adapter?.bindChildTrajectory(matchContext);
    if (child) {
      // A native child is not a client fork: `parent_id` and `fork_of` name
      // mutually exclusive runtime openings, so the child overlay drops any
      // fork source the generic history path derived first.
      const { fork_of: _forkOf, ...session } = binding.session;
      binding.session = {
        ...session,
        session_id: withCallerScope(binding.session, child.sessionId),
        parent_id: withCallerScope(binding.session, child.parentId),
      };
      binding.child = child;
      issueChildTrajectoryReceipt(context, binding.session, child);
    }
    this.bindings.set(context.resources, binding);
  }

  async onToolResults(
    context: LlmProxyToolResultsContext,
  ): Promise<LlmProxyToolResultsOutcome | undefined> {
    const binding = this.bindings.get(context.resources);
    if (!binding) return;
    const childResultUpdates: Record<string, string> = Object.create(null);
    const results = context.toolResults.map((result) => {
      const content = binding.adapter?.normalizeChildLaunchResult?.(result);
      if (content === undefined) return result;
      childResultUpdates[result.id] = content;
      return { ...result, content };
    });
    Object.assign(
      childResultUpdates,
      await approveChildReturnCarriers({
        binding,
        results,
      }),
    );
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
    binding.nativeHitlRulings = await recordNativeHitlRulings({
      binding,
      verifiedNativeQuestionResults,
    });
    binding.pendingHitlReviewOfferIds = await pendingNativeHitlOfferIds({
      binding,
      results: context.toolResults,
      resolvedOfferIds: new Set(
        binding.nativeHitlRulings.map((entry) => entry.offerId),
      ),
    });
    binding.requiresRemedyContinuation = hasRemedyOfferResult({
      binding,
      results: context.toolResults,
      verifiedNativeQuestionResults,
    });
    const nonHandbackResults = results
      .filter((result) => !binding.adapter?.isChildHandbackTool?.(result.name))
      .map((result) => ({
        ...result,
        content: childResultUpdates[result.id] ?? result.content,
      }));
    const result = await processProxyResults({
      session: this.governedSession(binding),
      results: nonHandbackResults,
      canonicalize: (name: string, namespace?: string) =>
        this.canonicalize(binding, { name, namespace }),
      isUserQuestion: (answer) =>
        isUserQuestionResult({
          binding,
          answer,
          verifiedNativeQuestionResults,
        }),
      classifySpawnResult: (answer) => {
        if (!binding.adapter?.isSpawnTool(answer.name)) return undefined;
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
    binding?.adapter?.stripCarrierMetadata(context.request);
    if (binding?.compaction) return;
    if (binding && binding.adapter?.id !== "archestra-chat") {
      appendQuestionContinuation({
        request: context.request,
        interactionType: context.interactionType,
        guidance: EXTERNAL_REMEDY_WORKFLOW_GUIDANCE,
      });
      const askUser = binding.request.tools?.askUser;
      const nativeQuestion =
        binding.adapter?.nativeQuestion &&
        declaresNativeQuestion(binding, binding.adapter.nativeQuestion.toolName)
          ? binding.adapter.nativeQuestion.toolName
          : undefined;
      const askUserTool = askUser?.name;
      if (askUserTool || nativeQuestion) {
        appendQuestionContinuation({
          request: context.request,
          interactionType: context.interactionType,
          guidance: buildElicitationMandateInstruction({
            askUserToolName: askUserTool,
            nativeQuestionToolName: nativeQuestion,
          }),
        });
      }
    }
    if (binding && binding.pendingHitlReviewOfferIds.length > 0) {
      const offerIds = binding.pendingHitlReviewOfferIds;
      binding.pendingHitlReviewOfferIds = [];
      appendQuestionContinuation({
        request: context.request,
        interactionType: context.interactionType,
        guidance: hitlQuestionGuidance(offerIds),
      });
      requireCodexToolCall({ binding, context });
    }
    if (binding?.requiresRemedyContinuation) {
      binding.requiresRemedyContinuation = false;
      appendQuestionContinuation({
        request: context.request,
        interactionType: context.interactionType,
        guidance: REMEDY_OFFER_CONTINUATION_GUIDANCE,
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
      });
      if (rulings.some((entry) => entry.ruling === "approve")) {
        requireCodexToolCall({ binding, context });
      }
    }
    if (binding?.requiresQuestionContinuation) {
      appendQuestionContinuation({
        request: context.request,
        interactionType: context.interactionType,
      });
    }
    if (!binding || (!binding.request.tools && !binding.session.parent_id))
      return;
    if (!binding.request.promptOperationId) {
      // Tool-result requests continue the active turn without a new prompt.
      return;
    }
    const session = this.governedSession(binding);
    await notePrompt(session, binding.request.promptOperationId);
  }

  async onPrepareToolCalls(
    context: LlmProxyToolCallsContext,
  ): Promise<LlmProxyToolCallsOutcome | undefined> {
    const binding = this.bindings.get(context.resources);
    const tools = binding?.request.tools;
    if (!binding || !tools) return;
    let changed = false;
    let incomingToolCalls = context.toolCalls;
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
    const issuedNativeQuestions: Array<{
      id: string;
      name: string;
      offerIds: string[];
    }> = [];
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
        tools.platformToolNames?.has(call.name) &&
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
      const issuedQuestionName = nativeQuestionName(binding, prepared.name);
      if (issuedQuestionName) {
        const issuedId = issueNativeQuestionId({
          session: binding.session,
          name: issuedQuestionName,
          currentId: prepared.id,
        });
        prepared = { ...prepared, wireId: issuedId };
        issuedNativeQuestions.push({
          id: issuedId,
          name: issuedQuestionName,
          offerIds,
        });
        changed = true;
      }
      toolCalls.push(prepared);
    }
    await Promise.all(
      issuedNativeQuestions.map((question) =>
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
    const decisions = await evaluateHostedToolCalls(
      this.governedSession(binding),
      calls,
      {
        ...this.resolution(binding),
        control: tools.control,
      },
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
    const binding = this.bindings.get(context.resources);
    if (!binding) return;
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
    if (binding.adapter) {
      for (const call of calls) {
        // Native transcript files contain unchecked intermediate output, not
        // the child's admitted return. A correctly prefixed id is not proof
        // that reading those bytes is safe.
        if (
          !binding.adapter.isSpawnTool(call.name) &&
          binding.adapter.childTranscriptPaths &&
          referencesChildTranscriptPath({
            arguments: call.arguments,
            pathPatterns: binding.adapter.childTranscriptPaths,
          })
        ) {
          throw new ApiError(
            409,
            "OpenAPPA withheld raw child transcript access; use the verified child completion instead",
          );
        }
        protectNamedChildren({
          children: binding.adapter.namesChildren({
            rootId,
            arguments: call.arguments,
          }),
          rootId,
          spawn: binding.adapter.isSpawnTool(call.name),
        });
      }
    }
    const rest = calls.filter((call) => !handbackIds.has(call.id));
    const decisions = rest.length
      ? await evaluateToolCalls(session, rest, {
          ...this.resolution(binding),
          isUserQuestion: (name, namespace) => {
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
          isSpawn: (name) => binding.adapter?.isSpawnTool(name) === true,
          supportsDelegation: binding.adapter !== undefined && !binding.chat,
          ...(binding.request.tools
            ? {
                control: binding.request.tools.control,
                notice: binding.request.tools.notice,
              }
            : {}),
        })
      : [];
    const decisionById = new Map(
      rest.map((call, index) => [call.id, decisions[index]]),
    );

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
        const admitted = await admitChildHandback({ binding, call });
        blocked.push({
          id: call.id,
          name: call.name,
          reason: "OpenAPPA replaced the child return with admitted bytes",
        });
        released.push(admitted);
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
          );
          throw new ApiError(
            400,
            "OpenAPPA cannot safely start a nested child because its delegation marker could not be attached",
          );
        }
        released.push(delegated?.call ?? call);
        if (delegated) annotated.push(delegated.annotation);
        continue;
      }
      // The registry pins `blocked` to the wire batch: the entry names the
      // call as given. The identity the runtime ruled on — the dispatch's
      // target — is what the notice and the refusal describe.
      const identity = this.policyIdentity(binding, call);
      if (!notice) {
        // Refuse call and cancel admitted calls if client declares no notice tool.
        await cancelCalls(
          session,
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
      handbackIds.size === 0
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
    if (!binding.request.turnEndOperationId) {
      throw new ApiError(503, "OpenAPPA could not safely end the child turn");
    }
    // Check correlation data and the signing key before ChildEnd.
    // If the runtime admits a value, the value crosses the boundary.
    // Fail before dispatch if the receipt cannot be created.
    const childNativeId = binding.child?.lineage?.childNativeId;
    const spawnCallId = binding.child?.lineage?.spawnCallId;
    if (!spawnCallId) {
      throw new ApiError(
        503,
        "OpenAPPA cannot correlate the child return to its parent",
      );
    }
    if (!childReturnReceiptsConfigured()) {
      throw new ApiError(503, "OpenAPPA could not protect the child return");
    }

    const outcome = await endChild({
      session: this.governedSession(binding),
      operationId: binding.request.turnEndOperationId.replace(
        /^turn_end:/,
        "child_end:",
      ),
      output: context.responseText,
    });
    const admitted =
      outcome.decision === "release" ? context.responseText : outcome.content;
    if (!outcome.crossed) {
      return { decision: "replace", responseText: admitted };
    }
    const receipt = mintChildReturnReceipt({
      organizationId: binding.session.organization_id,
      callerId: binding.session.caller_id,
      parentId: binding.session.parent_id,
      childId: binding.session.session_id,
      ...(childNativeId ? { childNativeId } : {}),
      spawnCallId,
      value: admitted,
      ...(binding.adapter?.id === "codex" ? { format: "inline" as const } : {}),
    });
    if (!receipt) {
      throw new ApiError(503, "OpenAPPA could not protect the child return");
    }
    return {
      decision: "replace",
      responseText: `${admitted}\n\n${receipt}`,
    };
  }

  async onCleanup(context: LlmProxyRequestContext): Promise<void> {
    this.bindings.delete(context.resources);
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
    if (
      !native?.fromAskUser ||
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
}): Promise<Record<string, string>> {
  const collected = params.binding.request.childReturns;
  const receipts = collected?.receipts ?? [];
  const envelopeIdOf = (id: string) => parseTrajectoryStamp(id)?.callId ?? id;
  const arrivingEnvelopes = new Set(
    receipts.flatMap((receipt) =>
      !receipt.assistantOrigin && receipt.envelopeId !== undefined
        ? [envelopeIdOf(receipt.envelopeId)]
        : [],
    ),
  );
  // One wait result can contain several children. Every completed leaf requires
  // its own receipt. Validating one substring does not authorize sibling returns.
  if (collected?.completions.some((completion) => !completion.receipt)) {
    throw new ApiError(409, "OpenAPPA withheld an unverified child completion");
  }
  const adapter = params.binding.adapter;
  const completionResults = params.results.filter(
    (result) =>
      params.binding.request.restoredNoticeCallIds?.has(result.id) !== true &&
      adapter?.isChildCompletionResult?.(result) === true,
  );
  if (
    completionResults.some(
      (result) => !arrivingEnvelopes.has(envelopeIdOf(result.id)),
    )
  ) {
    throw new ApiError(
      409,
      "OpenAPPA withheld an unverified child completion from the parent",
    );
  }
  // Authenticates every receipt before recording runtime results.
  // An assistant role does not bypass verification.
  const arrived = new Map<
    string,
    NonNullable<Awaited<ReturnType<typeof verifyChildReturnReceipt>>> & {
      spawnCallId: string;
    }
  >();
  const byEnvelope = new Map<
    string,
    Array<NonNullable<Awaited<ReturnType<typeof verifyChildReturnReceipt>>>>
  >();
  const directSpawnResults = new Set(
    params.results
      .filter((result) => adapter?.isSpawnTool(result.name))
      .map((result) => envelopeIdOf(result.id)),
  );
  for (const receipt of receipts) {
    const verified = verifyChildReturnReceipt({
      receipt,
      organizationId: params.binding.session.organization_id,
      callerId: params.binding.session.caller_id,
      parentId: params.binding.session.session_id,
    });
    if (!verified) {
      throw new ApiError(
        400,
        "OpenAPPA rejected a forged child-return receipt",
      );
    }
    if (verified.assistantOrigin) continue;
    if (!verified.spawnCallId) {
      throw new ApiError(
        409,
        "OpenAPPA cannot bind the child completion to its spawn call",
      );
    }
    if (receipt.envelopeId) {
      const envelopeId = envelopeIdOf(receipt.envelopeId);
      const spawnCallId = envelopeIdOf(verified.spawnCallId);
      if (directSpawnResults.has(envelopeId) && envelopeId !== spawnCallId) {
        throw new ApiError(
          400,
          "OpenAPPA rejected a child return for another spawn call",
        );
      }
      const envelope = byEnvelope.get(envelopeId) ?? [];
      envelope.push(verified);
      byEnvelope.set(envelopeId, envelope);
    }
    arrived.set(verified.token, {
      ...verified,
      spawnCallId: verified.spawnCallId,
    });
  }
  for (const receipt of arrived.values()) {
    await approveSpawnReturn({
      session: params.binding.session,
      toolCallId: receipt.spawnCallId,
      childId: receipt.childId,
      value: receipt.value,
    });
  }
  // Strips unverified text and metadata beside valid receipts.
  // Reconstructs result content solely from authenticated values.
  const updates: Record<string, string> = Object.create(null);
  for (const result of completionResults) {
    const envelopeId = envelopeIdOf(result.id);
    const verified = byEnvelope.get(envelopeId) ?? [];
    if (verified.length === 0) {
      throw new ApiError(
        409,
        "OpenAPPA withheld an unverified child completion",
      );
    }
    updates[result.id] =
      verified.length === 1 && adapter?.isSpawnTool(result.name)
        ? verified[0].value
        : JSON.stringify({
            status: Object.fromEntries(
              verified.map((receipt) => [
                receipt.childNativeId,
                { completed: receipt.value },
              ]),
            ),
          });
  }
  return updates;
}

async function admitChildHandback(params: {
  binding: AppaPluginBinding;
  call: ToolCall;
}): Promise<ToolCall> {
  const { binding, call } = params;
  const adapter = binding.adapter;
  const raw = adapter?.childHandbackValue?.(call.arguments);
  if (!raw) {
    throw new ApiError(400, "OpenAPPA child handback carried no return value");
  }
  const childNativeId = binding.child?.lineage?.childNativeId;
  const spawnCallId = binding.child?.lineage?.spawnCallId;
  if (!binding.session.parent_id || !spawnCallId) {
    throw new ApiError(
      503,
      "OpenAPPA cannot correlate the child return to its parent",
    );
  }
  if (!binding.request.turnEndOperationId) {
    throw new ApiError(503, "OpenAPPA could not safely end the child turn");
  }
  if (!childReturnReceiptsConfigured()) {
    throw new ApiError(503, "OpenAPPA could not protect the child return");
  }
  const outcome = await endChild({
    session: binding.session,
    operationId: binding.request.turnEndOperationId.replace(
      /^turn_end:/,
      "child_end:",
    ),
    output: raw,
  });
  const admitted =
    outcome.decision === "release" ? raw : (outcome.content ?? "");
  if (!outcome.crossed) {
    throw new ApiError(409, admitted || "OpenAPPA withheld the child return");
  }
  const receipt = mintChildReturnReceipt({
    organizationId: binding.session.organization_id,
    callerId: binding.session.caller_id,
    parentId: binding.session.parent_id,
    childId: binding.session.session_id,
    ...(childNativeId ? { childNativeId } : {}),
    spawnCallId,
    value: admitted,
    ...(binding.adapter?.id === "codex" ? { format: "inline" as const } : {}),
  });
  if (!receipt) {
    throw new ApiError(503, "OpenAPPA could not protect the child return");
  }
  const rewritten = adapter?.rewriteChildHandback?.(
    call.arguments,
    `${admitted}\n\n${receipt}`,
  );
  return {
    ...call,
    arguments:
      rewritten === undefined ? `${admitted}\n\n${receipt}` : rewritten,
  };
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

function cloneTrustedContext(context: AppaTrustedContext): AppaTrustedContext {
  return {
    ...context,
    session: { ...context.session },
  };
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
  const args = argumentRecordOf(call.arguments);
  if (args && adapter.spawnPromptField(call.name, args)) return true;
  return (
    adapter.isSpawnTool(call.name) &&
    adapter.spawnPromptField(call.name, {
      prompt: "probe",
      message: "probe",
      items: [{ type: "text", text: "probe" }],
    }) !== undefined
  );
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
  const hitl = await getHitlAskUserArguments({
    session: params.binding.session,
    offerIds: params.offerIds,
  });
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

const REMEDY_OFFER_CONTINUATION_GUIDANCE =
  "The get_remedy_plans result immediately above offers a remedy for the blocked call. Do not reply to the user and do not ask whether to continue. Immediately call execute_remedy_plan with the exact offer_id and plan from that result. The control call opens the human review when required.";

const EXTERNAL_REMEDY_WORKFLOW_GUIDANCE =
  "When get_remedy_plans offers a remedy for a blocked call, do not ask the user whether to submit it. Immediately call execute_remedy_plan with the exact offer_id and plan from that ruling. If execute_remedy_plan returns outcome review_required, do not reply that review is pending. Immediately call the declared ask_user tool with that offer ID in remedy_offer_ids, header Approval, and options Approve and Deny. The platform supplies the exact review text. Wait for successful authorization before retrying the blocked tool.";

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
  const scope = nativeQuestionTag({
    session: params.session,
    name: "cache",
    nonce: params.id,
  }).toString("base64url");
  return `${CacheKey.OpenAppaNativeQuestion}-${scope}`;
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

function hitlQuestionGuidance(offerIds: readonly string[]): string {
  return [
    "The last execute_remedy_plan result requires human review.",
    "Do not reply to the user and do not ask for approval in plain text.",
    "Immediately call the declared ask_user tool once for each offer ID below.",
    "For each call, use question 'Open the pending HITL review.', header 'Approval', options Approve and Deny, and remedy_offer_ids containing only that offer ID.",
    "The platform replaces that placeholder text with the reviewed tool call and displays the client native question UI when available.",
    `Offer IDs: ${JSON.stringify(offerIds)}.`,
  ].join(" ");
}

function hitlDecisionGuidance(
  rulings: readonly RecordedNativeHitlRuling[],
): string {
  const approved = rulings
    .filter((entry) => entry.ruling === "approve")
    .map((entry) => entry.offerId);
  if (approved.length > 0) {
    return [
      `The verified human answer approved OpenAPPA offer IDs ${JSON.stringify(approved)}.`,
      "Your next and only tool calls must be execute_remedy_plan calls for those offers, using the plan shown earlier in the conversation.",
      "Do not call or retry the blocked tool in the same response.",
      "Wait for execute_remedy_plan to report successful authorization. Only then retry the blocked tool in a new response.",
      "Do not ask another question and do not describe this step in prose.",
    ].join(" ");
  }
  return [
    "The verified human answer did not approve the pending OpenAPPA review.",
    "Do not call execute_remedy_plan and do not retry the blocked tool.",
    "State briefly that the action remains blocked, then stop that action.",
  ].join(" ");
}

function appendQuestionContinuation(params: {
  request: unknown;
  interactionType: string;
  guidance?: string;
}): void {
  const guidance = params.guidance ?? QUESTION_CONTINUATION_GUIDANCE;
  if (!isRecord(params.request)) return;
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

/** Returns true if this session is caller-scoped and eligible for lineage tracing. */
function tracesLineage(session: OpenAppaSession, chat: boolean): boolean {
  const callerId = session.caller_id;
  return (
    !chat &&
    callerId !== undefined &&
    session.session_id.startsWith(`${callerId}|`)
  );
}
