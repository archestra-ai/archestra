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
import OpenAppaSpawnCorrelationModel from "@/models/openappa-spawn-correlation";
import { clientSessionId } from "@/openappa/actor";
import {
  type AppaChildReturnCompletion,
  childReturnMarkersConfigured,
  mintChildReturnMarker,
} from "@/openappa/child-return";
import { mintChildTrajectoryReceipt } from "@/openappa/child-trajectory-receipt";
import { recordOpenAppaClientFailure } from "@/openappa/client-failure-report";
import { delegationEnabled, mintDelegationMarker } from "@/openappa/delegation";
import {
  getHitlAskUserArguments,
  getHitlReview,
  recordHitlRuling,
} from "@/openappa/hitl-review";
import {
  buildNoticeArguments,
  type RemedyExecution,
  readRemedyExecution,
} from "@/openappa/notice";
import type { OfferJws } from "@/openappa/offer-claims";
import {
  offerIdFromJws,
  offerSessionFromJws,
  signOfferClaims,
  unsignedOfferClaims,
} from "@/openappa/offer-claims";
import { underscoreLabeledPlatformToolName } from "@/openappa/request";
import {
  type AppaChildReturnRecord,
  approveSpawnReturn,
  cancelCalls,
  endChild,
  endTurn,
  evaluateHostedToolCalls,
  evaluateToolCalls,
  loadChildReturns,
  notePrompt,
  type OpenAppaSession,
  processProxyResults,
  sharedPolicy,
} from "@/openappa/service";
import {
  codexExecClientDeclined,
  issueShellExecutionTicket,
  readCodexExecOutput,
  SHELL_EXECUTION_HISTORY_TTL_MS,
  SHELL_EXECUTION_TTL_MS,
  shellExecutionCacheKey,
  shellExecutionCallCacheKey,
  shellExecutionCommand,
  ticketFromShellExecutionCommand,
  verifyShellExecutionResponse,
} from "@/openappa/shell-execution";
import {
  buildShellRemedyCommand,
  readShellRemedyCommand,
  SHELL_REMEDY_TOOL_NAME,
} from "@/openappa/shell-remedy";
import {
  parseTrajectoryStamp,
  stampToolCallId,
} from "@/openappa/trajectory-stamp";
import {
  appaWireFamily,
  restoreAppaShellExecutions,
  restoreAppaShellRemedies,
} from "@/openappa/wire";
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
   * EXPERIMENTAL shell remedy: call IDs whose shell-carried ruling was
   * verified and restored in this request's history.
   */
  restoredShellRemedyCallIds: ReadonlySet<string>;
  /**
   * Signature-verified issued notices the client declined. Omitted from
   * runtime result processing so the native stdout is not replaced.
   */
  declinedShellNoticeCallIds: Set<string>;
  /**
   * EXPERIMENTAL shell remedy: count of freshly returned shell rulings whose
   * single-use claim this request consumed; drives the one-time guidance.
   */
  freshShellRemedyRulings: number;
  /** Proxy-only coding clients use native shell/review tools instead of an MCP gateway. */
  proxyOnlyShell: boolean;
  /** Exact staged offer whose native review must be shown in this turn. */
  requiredHitlOfferId?: string;
  reviewUnavailable: boolean;
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
      completedHandbackReturn: undefined,
      chat,
      compaction: trustedContext.compaction === true,
      requestHeaders: context.headers,
      requiresQuestionContinuation: false,
      requiresRemedyContinuation: false,
      pendingHitlReviewOfferIds: [],
      nativeHitlRulings: [],
      restoredShellRemedyCallIds: new Set(),
      declinedShellNoticeCallIds: new Set(),
      freshShellRemedyRulings: 0,
      proxyOnlyShell: false,
      reviewUnavailable: false,
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
    binding.restoredShellRemedyCallIds = this.restoreShellRemedies(
      binding,
      context,
    );
    await this.restoreShellExecutions(binding, context);
    this.prepareProxyOnlyShellTools(binding, context);
  }

  /**
   * EXPERIMENTAL (ARCHESTRA_OPENAPPA_OPENCODE_SHELL_REMEDY, dev only): swaps
   * verified proxy-issued shell remedy calls in history back to the denied
   * call and its bound ruling before the provider request and the tool
   * results are built from the body. Runs on every request so replays restore
   * identically; unverified scripts stay ordinary shell calls.
   */
  private restoreShellRemedies(
    binding: AppaPluginBinding,
    context: LlmProxyRequestContext,
  ): ReadonlySet<string> {
    const adapter = binding.adapter;
    const secret = config.openappa.offerSigningSecret;
    const family = appaWireFamily(context.interactionType);
    if (
      !config.openappa.opencodeShellRemedy ||
      !shellRemedyAdapter(adapter) ||
      !family ||
      secret.length === 0
    ) {
      return new Set();
    }
    return restoreAppaShellRemedies({
      family,
      body: context.requestBody,
      isShellTool: (name, namespace) =>
        matchesNativeShell(binding, name, namespace),
      readShellRemedy: ({ callId, arguments: args }) =>
        readShellRemedyCommand({
          session: binding.session,
          callId,
          arguments: args,
          secret,
          argument: shellArgumentName(adapter),
        }),
      clientDeclined:
        adapter.id === "codex"
          ? ({ output }) => codexExecClientDeclined(output)
          : undefined,
      onDeclinedIssuedNotice: (callId) => {
        binding.declinedShellNoticeCallIds.add(callId);
        const inner = parseTrajectoryStamp(callId)?.callId;
        if (inner) binding.declinedShellNoticeCallIds.add(inner);
      },
      onRestoredOffers: (offers) => {
        binding.request.offerClaims = [
          ...(binding.request.offerClaims ?? []),
          ...offers,
        ];
        binding.request.askUserOfferClaims = [
          ...(binding.request.askUserOfferClaims ?? []),
          ...offers,
        ];
      },
    });
  }

  private async restoreShellExecutions(
    binding: AppaPluginBinding,
    context: LlmProxyRequestContext,
  ): Promise<void> {
    const endpoint = config.openappa.shellExecutionEndpoint;
    const secret = config.openappa.offerSigningSecret;
    const family = appaWireFamily(context.interactionType);
    if (
      !config.openappa.opencodeShellRemedy ||
      !endpoint ||
      !secret ||
      (family !== "openai:chatCompletions" &&
        family !== "anthropic:messages" &&
        family !== "openai:responses") ||
      !shellRemedyAdapter(binding.adapter)
    )
      return;
    const adapter = binding.adapter;
    await restoreAppaShellExecutions({
      family,
      body: context.requestBody,
      isShellTool: (name, namespace) =>
        matchesNativeShell(binding, name, namespace),
      readExecution: async ({ callId, arguments: args, output, isError }) => {
        const issued = await cacheManager.get<{ token: string }>(
          shellExecutionCallCacheKey({
            organizationId: binding.session.organization_id,
            sessionId: binding.session.session_id,
            callId,
          }),
          { throwOnError: true },
        );
        let input: unknown = args;
        if (typeof args === "string") {
          try {
            input = JSON.parse(args);
          } catch {
            if (issued)
              throw new ApiError(
                409,
                "OpenAPPA shell execution command changed",
              );
            return;
          }
        }
        const command = isRecord(input)
          ? input[shellArgumentName(adapter)]
          : undefined;
        if (typeof command !== "string") {
          if (issued)
            throw new ApiError(409, "OpenAPPA shell execution command changed");
          return;
        }
        const ticket = ticketFromShellExecutionCommand({
          command,
          endpoint,
          secret,
        });
        if (
          issued &&
          shellExecutionCommand({ token: issued.token, endpoint }) !== command
        ) {
          throw new ApiError(409, "OpenAPPA shell execution command changed");
        }
        if (!ticket) return;
        if (
          ticket.callId !== callId ||
          ticket.organizationId !== binding.session.organization_id ||
          ticket.callerId !== binding.session.caller_id ||
          ticket.sessionId !== binding.session.session_id ||
          ticket.parentId !== binding.session.parent_id ||
          ticket.agentId !== context.profileId
        ) {
          throw new ApiError(
            409,
            "OpenAPPA shell execution ticket belongs to another call or session",
          );
        }
        const wrapped =
          adapter.id === "codex" ? readCodexExecOutput(output) : undefined;
        const declined =
          isError ||
          (adapter.id === "codex" &&
            (!wrapped || wrapped.running || wrapped.exitCode !== 0));
        if (declined) {
          return {
            toolName: ticket.execution.tool_name,
            originalArguments: ticket.execution.original_arguments,
            isError: true,
            result: JSON.stringify({
              isError: true,
              content: [
                {
                  type: "text",
                  text: "[appa] The client declined or failed to execute the local remedy request. No verified execution result is available; the dependent call remains blocked. Do not retry the same shell request.",
                },
              ],
            }),
          };
        }
        const result = verifyShellExecutionResponse({
          ticket,
          content: wrapped ? wrapped.stdout : output,
          secret,
        });
        if (!result) {
          throw new ApiError(
            409,
            "OpenAPPA did not verify the shell execution response; the remedy remains blocked",
          );
        }
        return {
          toolName: ticket.execution.tool_name,
          originalArguments: ticket.execution.original_arguments,
          result: JSON.stringify(result),
          isError: result.isError === true,
        };
      },
    });
  }

  private prepareProxyOnlyShellTools(
    binding: AppaPluginBinding,
    context: LlmProxyRequestContext,
  ): void {
    if (
      !config.openappa.opencodeShellRemedy ||
      !config.openappa.shellExecutionEndpoint ||
      binding.chat ||
      binding.identity.gatewayConnected !== false ||
      !shellRemedyAdapter(binding.adapter) ||
      !binding.session.caller_id ||
      !config.openappa.offerSigningSecret
    )
      return;
    const body = isRecord(context.requestBody)
      ? context.requestBody
      : undefined;
    const tools = shellToolContainer(body);
    if (
      !tools ||
      !binding.request.declaredTools.some((tool) =>
        matchesNativeShell(binding, tool.name, tool.namespace),
      )
    )
      return;
    const control = "archestra__execute_remedy_plan";
    const askUser = "archestra__ask_user";
    const family = appaWireFamily(context.interactionType);
    if (
      family !== "openai:chatCompletions" &&
      family !== "anthropic:messages" &&
      family !== "openai:responses"
    )
      return;
    const appendTool = (definition: {
      name: string;
      description: string;
      parameters: Record<string, unknown>;
    }) => {
      tools.push(
        family === "anthropic:messages"
          ? {
              name: definition.name,
              description: definition.description,
              input_schema: definition.parameters,
            }
          : family === "openai:responses"
            ? {
                type: "function",
                name: definition.name,
                description: definition.description,
                parameters: definition.parameters,
              }
            : { type: "function", function: definition },
      );
    };
    const nativeQuestion = binding.adapter.nativeQuestion;
    const hasNativeQuestion =
      !!nativeQuestion &&
      nativeQuestion.isAvailable?.(binding.requestHeaders) !== false &&
      declaresNativeQuestion(binding, nativeQuestion.toolName);
    if (
      binding.request.declaredTools.some(
        (tool) => tool.name === control || tool.name === askUser,
      )
    )
      return;
    appendTool({
      name: control,
      description:
        "Execute a signed OpenAPPA remedy offer through the proxy. Pass the exact offer_id and plan. A subagent return-contract plan also requires label: the lowest trust and audience this session accepts from the return; omit a dimension to retain its current value. Schema-attested return plans also use return_schema. Follow review_required with ask_user before executing again.",
      parameters: {
        type: "object",
        properties: {
          offer_id: { type: "string" },
          plan: { type: "string" },
          label: {
            type: "object",
            description:
              "Required for subagent return-contract plans. State the lowest accepted trust and audience; omit a dimension to keep its current value.",
            properties: {
              trust: { type: "string" },
              audience: { type: "array", items: { type: "string" } },
            },
          },
          return_schema: {
            type: "object",
            description:
              "JSON schema required only for schema-attested subagent returns.",
            additionalProperties: true,
          },
        },
        required: ["offer_id", "plan"],
      },
    });
    if (hasNativeQuestion) {
      appendTool({
        name: askUser,
        description:
          "Ask the user to approve or deny a staged OpenAPPA review. The proxy displays it using the client's native question tool.",
        parameters: {
          type: "object",
          properties: {
            question: { type: "string" },
            header: { type: "string" },
            options: { type: "array", items: { type: "object" } },
            remedy_offer_ids: { type: "array", items: { type: "string" } },
          },
          required: ["question", "header", "options", "remedy_offer_ids"],
        },
      });
    }
    binding.request.tools = {
      control: { name: control },
      notice: { name: "archestra__get_remedy_plans" },
      askUser: hasNativeQuestion ? { name: askUser } : undefined,
      platformToolNames: new Set(
        hasNativeQuestion ? [control, askUser] : [control],
      ),
      namespaces: new Map(),
    };
    binding.proxyOnlyShell = true;
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
    // Requests with results submit them to runtime even if current request
    // declares no tools. Proxy-only sessions declared local tools, so their
    // session still starts; a session that declared nothing has nothing to do.
    if (
      !binding.request.tools &&
      context.toolResults.length === 0 &&
      binding.request.declaredTools.length === 0
    ) {
      return;
    }
    assertUniqueNativeQuestionResultIds({
      binding,
      results: context.toolResults,
    });
    const verifiedNativeQuestionResults = await claimNativeQuestionResults({
      binding,
      results: context.toolResults,
    });
    // Consume review authority once, but keep the client's answer in history.
    // Historical answers must not be submitted to APPA as fresh rulings.
    const historicalQuestionIds = new Set<string>();
    for (const answer of results) {
      const name = nativeQuestionName(binding, answer.name);
      if (
        name &&
        verifyNativeQuestionId({
          session: binding.session,
          name,
          id: answer.id,
        }) &&
        !verifiedNativeQuestionResults.has(answer)
      ) {
        historicalQuestionIds.add(answer.id);
      }
    }
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
    if (
      binding.proxyOnlyShell &&
      !binding.request.tools?.askUser &&
      binding.pendingHitlReviewOfferIds.length > 0
    ) {
      binding.reviewUnavailable = true;
      binding.pendingHitlReviewOfferIds = [];
    }
    binding.freshShellRemedyRulings = await claimShellRemedyResults({
      binding,
      results: context.toolResults,
    });
    binding.requiresRemedyContinuation = hasRemedyOfferResult({
      binding,
      results: context.toolResults,
      verifiedNativeQuestionResults,
    });
    const nonHandbackResults = results
      .filter(
        (result) =>
          !binding.adapter?.isChildHandbackTool?.(result.name) &&
          !historicalQuestionIds.has(result.id) &&
          !binding.declinedShellNoticeCallIds.has(result.id),
      )
      .map((result) =>
        Object.hasOwn(childResultUpdates, result.id)
          ? { ...result, content: childResultUpdates[result.id] }
          : result,
      );
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
    if (binding?.adapter?.id === "codex") {
      appendNativeDelegationGuidance(context);
    }
    const approvedReview =
      binding?.nativeHitlRulings.some((entry) => entry.ruling === "approve") ??
      false;
    if (binding?.proxyOnlyShell) {
      binding.requiredHitlOfferId =
        !approvedReview && binding.pendingHitlReviewOfferIds.length > 0
          ? binding.pendingHitlReviewOfferIds[0]
          : undefined;
      // Do not advertise a synthetic review tool without a staged offer.
      // The client's own native question tool remains available.
      if (!binding.requiredHitlOfferId && isRecord(context.request)) {
        const declared = context.request.tools;
        if (Array.isArray(declared)) {
          context.request.tools = declared.filter(
            (tool) =>
              !isRecord(tool) ||
              (isRecord(tool.function) ? tool.function.name : tool.name) !==
                binding.request.tools?.askUser?.name,
          );
        }
      }
    }
    if (binding && binding.adapter?.id !== "archestra-chat") {
      if (binding.request.tools?.control) {
        appendQuestionContinuation({
          request: context.request,
          interactionType: context.interactionType,
          guidance:
            binding.proxyOnlyShell && binding.adapter?.id === "codex"
              ? CODEX_PROXY_ONLY_REMEDY_WORKFLOW_GUIDANCE
              : binding.proxyOnlyShell
                ? PROXY_ONLY_REMEDY_WORKFLOW_GUIDANCE
                : EXTERNAL_REMEDY_WORKFLOW_GUIDANCE,
        });
      }
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
    // Complete an already-approved offer before opening another review.
    if (
      binding &&
      binding.pendingHitlReviewOfferIds.length > 0 &&
      !approvedReview
    ) {
      const offerIds = binding.pendingHitlReviewOfferIds;
      binding.pendingHitlReviewOfferIds = [];
      appendQuestionContinuation({
        request: context.request,
        interactionType: context.interactionType,
        guidance: hitlQuestionGuidance(offerIds),
      });
      requireProxyOnlyWorkflowTool({ binding, context, tool: "askUser" });
      requireCodexToolCall({ binding, context });
    }
    if (binding?.reviewUnavailable) {
      binding.reviewUnavailable = false;
      appendQuestionContinuation({
        request: context.request,
        interactionType: context.interactionType,
        guidance:
          "The OpenAPPA remedy requires human approval, but this client did not declare a native question tool. Keep the blocked call denied; do not retry or claim approval. Tell the user this client cannot complete the review.",
      });
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
    if (binding && binding.freshShellRemedyRulings > 0) {
      binding.freshShellRemedyRulings = 0;
      appendQuestionContinuation({
        request: context.request,
        interactionType: context.interactionType,
        guidance: shellRemedyResultGuidance(
          binding.adapter?.id,
          binding.proxyOnlyShell,
        ),
      });
    }
    if (binding && binding.nativeHitlRulings.length > 0) {
      const rulings = binding.nativeHitlRulings;
      binding.requiresQuestionContinuation = false;
      appendQuestionContinuation({
        request: context.request,
        interactionType: context.interactionType,
        guidance: hitlDecisionGuidance(rulings, binding.proxyOnlyShell),
      });
      if (rulings.some((entry) => entry.ruling === "approve")) {
        requireProxyOnlyWorkflowTool({ binding, context, tool: "control" });
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
    const tools = binding?.request.tools;
    if (!binding || !tools) return;
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
        const deniedOffers = new Set(
          binding.nativeHitlRulings
            .filter((entry) => entry.ruling !== "approve")
            .map((entry) => entry.offerId),
        );
        const deniedControl = context.toolCalls.find(
          (call) =>
            call.name === tools.control.name &&
            call.namespace === tools.control.namespace &&
            deniedOffers.has(String(toolInputOf(call.arguments).offer_id)),
        );
        if (!binding.proxyOnlyShell || deniedControl) {
          const refused = deniedControl ?? blocked;
          const message = binding.nativeHitlRulings.some(
            (entry) => entry.ruling === "none",
          )
            ? "The native review returned no verified human decision. The dependent call remains blocked."
            : "The human did not approve this OpenAPPA review. Keep the dependent tool call blocked.";
          return {
            decision: "refuse",
            refusal: {
              refusalMessage: message,
              contentMessage: message,
              reason: "openappa_hitl_not_approved",
              blockedToolName: refused.name,
              blockedToolId: refused.id,
              toolInput: toolInputOf(refused.arguments),
              allToolCallNames: context.toolCalls.map((call) => call.name),
            },
          };
        }
      } else {
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
    }
    const claimedOfferIds = new Set<string>();
    const issuedNativeQuestions: Array<{
      id: string;
      name: string;
      offerIds: string[];
    }> = [];
    const toolCalls: Array<(typeof context.toolCalls)[number]> = [];
    for (const call of incomingToolCalls) {
      const nativeReview =
        binding.proxyOnlyShell &&
        binding.requiredHitlOfferId &&
        tools.askUser &&
        call.name === binding.adapter?.nativeQuestion?.toolName &&
        nativeQuestionNamespaceMatches(binding, call.namespace) &&
        declaresNativeQuestion(binding, call.name)
          ? {
              ...call,
              name: tools.askUser.name,
              namespace: tools.askUser.namespace,
              arguments: JSON.stringify({
                remedy_offer_ids: [binding.requiredHitlOfferId],
              }),
            }
          : call;
      if (
        binding.proxyOnlyShell &&
        nativeReview.name === tools.askUser?.name &&
        issuedNativeQuestions.some((question) => question.offerIds.length > 0)
      ) {
        // Providers can ignore parallel_tool_calls=false. Never release a
        // second synthetic review call under its undeclared platform name.
        changed = true;
        continue;
      }
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
      let prepared = nativeReview;
      changed ||= prepared !== call;
      let offerIds: string[] = [];
      if (
        prepared.name === tools.askUser?.name &&
        prepared.namespace === tools.askUser.namespace &&
        archestraMcpBranding.getToolShortName(
          this.canonicalize(binding, prepared),
        ) === TOOL_ASK_USER_SHORT_NAME
      ) {
        let reviewCall = prepared;
        if (binding.proxyOnlyShell) {
          const offerId = binding.requiredHitlOfferId;
          if (!offerId) {
            return {
              decision: "refuse",
              refusal: {
                refusalMessage: "No staged OpenAPPA review is pending.",
                contentMessage: "No staged OpenAPPA review is pending.",
                reason: "openappa_hitl_review_missing",
                blockedToolName: call.name,
                blockedToolId: call.id,
                toolInput: toolInputOf(call.arguments),
                allToolCallNames: context.toolCalls.map((item) => item.name),
              },
            };
          }
          reviewCall = {
            ...prepared,
            arguments: JSON.stringify({ remedy_offer_ids: [offerId] }),
          };
        }
        const stamped = stampAskUserOffers(
          reviewCall,
          binding.request.askUserOfferClaims,
          claimedOfferIds,
        );
        prepared = stamped.call;
        offerIds = stamped.offerIds;
        if (
          binding.proxyOnlyShell &&
          offerIds[0] !== binding.requiredHitlOfferId
        ) {
          const message =
            "The staged OpenAPPA review offer is unavailable; no question was issued.";
          return {
            decision: "refuse",
            refusal: {
              refusalMessage: message,
              contentMessage: message,
              reason: "openappa_hitl_review_missing",
              blockedToolName: call.name,
              blockedToolId: call.id,
              toolInput: toolInputOf(call.arguments),
              allToolCallNames: context.toolCalls.map((item) => item.name),
            },
          };
        }
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
      if (
        binding.proxyOnlyShell &&
        offerIds.length > 0 &&
        issuedNativeQuestions.some((question) => question.offerIds.length > 0)
      ) {
        // Some providers ignore parallel_tool_calls=false. Keep the other
        // staged offer pending rather than asking two questions at once.
        changed = true;
        continue;
      }
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
        lineage: binding.child?.lineage,
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
    const rest = calls.filter(
      (call) =>
        !handbackIds.has(call.id) && !blockedTranscriptCalls.has(call.id),
    );
    const policy = sharedPolicy(session.organization_id);
    const decisions = rest.length
      ? await evaluateToolCalls(
          session,
          rest,
          {
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
            isSpawn: (name, namespace) =>
              binding.adapter?.isSpawnTool(name, namespace) === true,
            lineage: binding.child?.lineage,
            supportsDelegation: binding.adapter !== undefined && !binding.chat,
            ...(binding.request.tools
              ? {
                  control: binding.request.tools.control,
                  notice: binding.request.tools.notice,
                }
              : {}),
          },
          policy,
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
        }
        continue;
      }
      const decision = decisionById.get(call.id);
      if (!decision) continue;
      if (decision.kind === "control") {
        if (binding.proxyOnlyShell) {
          const args = toolInputOf(call.arguments);
          const receipt = readRemedyExecution({
            callId: call.id,
            toolName: call.name,
            namespace: call.namespace,
            arguments: args,
          });
          const issued =
            receipt &&
            binding.session.caller_id &&
            issueShellExecutionTicket({
              session: {
                organizationId: binding.session.organization_id,
                callerId: binding.session.caller_id,
                sessionId: binding.session.session_id,
                parentId: binding.session.parent_id,
                agentId: context.profileId,
              },
              callId: call.id,
              arguments: args,
              secret: config.openappa.offerSigningSecret,
            });
          const command =
            issued &&
            config.openappa.shellExecutionEndpoint &&
            shellExecutionCommand({
              token: issued.token,
              endpoint: config.openappa.shellExecutionEndpoint,
            });
          const shell = declaredShellTool(binding);
          if (!issued || !command || !shell) {
            const message =
              "OpenAPPA refused an unverified remedy request. Only a signed offer from this session can be executed; no tool ran.";
            return {
              decision: "refuse",
              refusal: {
                refusalMessage: message,
                contentMessage: message,
                reason: "openappa_invalid_proxy_only_offer",
                blockedToolName: call.name,
                blockedToolId: call.id,
                toolInput: toolInputOf(call.arguments),
                allToolCallNames: context.toolCalls.map((item) => item.name),
              },
            };
          }
          await cacheManager.set(
            shellExecutionCacheKey(issued.token),
            { nonce: issued.ticket.nonce },
            SHELL_EXECUTION_TTL_MS,
          );
          await cacheManager.set(
            shellExecutionCallCacheKey({
              organizationId: issued.ticket.organizationId,
              sessionId: issued.ticket.sessionId,
              callId: issued.ticket.callId,
            }),
            { token: issued.token },
            SHELL_EXECUTION_HISTORY_TTL_MS,
          );
          blocked.push({
            id: call.id,
            name: call.name,
            reason: "OpenAPPA routed the control call to a native shell",
          });
          released.push({
            id: call.id,
            name: shell.name,
            namespace: shell.namespace,
            arguments: JSON.stringify(
              nativeShellArguments(
                binding.adapter?.id,
                command,
                "Execute the signed OpenAPPA remedy request (proxy-generated)",
                binding.adapter?.id === "codex"
                  ? { yieldTimeMs: 30_000 }
                  : undefined,
              ),
            ),
          });
          continue;
        }
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
      if (!notice || binding.proxyOnlyShell) {
        // EXPERIMENTAL shell remedy: an OpenCode client with a native shell
        // but no gateway receives the bound ruling as a proxy-generated bash
        // script under the denied call's own ID instead of a refusal.
        const shellRemedy = await this.asShellRemedyNotice({
          binding,
          call,
          identity,
          feedback: decision.feedback,
          offers: decision.offers ?? [],
          session,
        });
        if (shellRemedy) {
          blocked.push({
            id: call.id,
            name: call.name,
            reason: decision.feedback,
          });
          released.push(shellRemedy);
          continue;
        }
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
    if (binding?.completedHandbackReturn !== undefined && context.streaming) {
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
    // Check correlation data and the signing key before ChildEnd.
    // If the runtime admits a value, the value crosses the boundary.
    // Fail before dispatch if the marker cannot be created.
    const childNativeId = binding.child?.lineage?.childNativeId;
    const spawnCallId = await resolveSpawnCallId(binding);
    if (!spawnCallId) {
      throw new ApiError(
        503,
        "OpenAPPA cannot correlate the child return to its parent",
      );
    }
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
    if (!outcome.crossed) {
      return { decision: "replace", responseText: admitted };
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
    const declared = declaredLocalTool(binding, native.toolName);
    return {
      id: call.id,
      name: native.toolName,
      // An explicit namespace, including "", is this rewrite's own. Empty
      // keeps a local question from inheriting a gateway namespace. Codex
      // declares request_user_input in `functions`, and that namespace must
      // survive or the client cannot route the question.
      namespace: declared?.namespace ?? "",
      arguments: JSON.stringify(native.fromAskUser(args)),
    };
  }

  /**
   * EXPERIMENTAL (ARCHESTRA_OPENAPPA_OPENCODE_SHELL_REMEDY, dev only, not
   * production-ready): rewrites a denied call into the coding client's
   * native shell call running a proxy-generated script that prints the bound
   * ruling, keeping the denied call's ID. The script's payload is signed
   * against the session, call ID, and ruling bytes, and a single-use claim is
   * cached, so a later request can verify and restore the ruling instead of
   * trusting client shell output. Returns undefined — the caller then refuses
   * the turn as before — unless the flag, the adapter, a declared native
   * shell tool, and the signing secret all hold. Execution uses a separate,
   * single-use signed request and the existing runtime approval gates.
   */
  private async asShellRemedyNotice(params: {
    binding: AppaPluginBinding;
    call: ToolCall;
    identity: ReturnType<AppaPluginArchestra["policyIdentity"]>;
    feedback: string;
    offers: string[];
    session: OpenAppaSession;
  }): Promise<ToolCall | undefined> {
    const { binding, call, identity, session } = params;
    const adapter = binding.adapter;
    const secret = config.openappa.offerSigningSecret;
    if (
      !config.openappa.opencodeShellRemedy ||
      !shellRemedyAdapter(adapter) ||
      binding.chat ||
      secret.length === 0
    ) {
      return undefined;
    }
    const shell = declaredShellTool(binding);
    if (!shell) return undefined;
    const script = buildShellRemedyCommand({
      session,
      callId: call.id,
      notice: buildNoticeArguments({
        id: call.id,
        tool: identity.name,
        arguments: identity.arguments,
        result: params.feedback,
        custom: identity.custom,
        namespace: identity.namespace,
        offers: signedOffersForDenial(session, {
          offerIds: params.offers,
          tool: identity.name,
          spelling: identity.name,
          ...(identity.dispatch ? { dispatch: identity.dispatch } : {}),
        }),
      }),
      secret,
    });
    if (!script) return undefined;
    await cacheManager.set(
      shellRemedyCacheKey({ session, id: call.id }),
      { nonce: script.nonce },
      TimeInMs.Minute * 10,
    );
    return {
      id: call.id,
      name: shell.name,
      namespace: shell.namespace,
      arguments: JSON.stringify(
        nativeShellArguments(
          adapter.id,
          script.command,
          "Print the OpenAPPA ruling for the blocked call (proxy-generated)",
        ),
      ),
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
  const completions = params.binding.request.childReturns?.completions ?? [];
  const adapter = params.binding.adapter;
  const envelopeIdOf = (id: string) => parseTrajectoryStamp(id)?.callId ?? id;
  const completionResults = params.results.filter(
    (result) =>
      params.binding.request.restoredNoticeCallIds?.has(result.id) !== true &&
      !params.binding.restoredShellRemedyCallIds.has(result.id) &&
      adapter?.isChildCompletionResult?.(result) === true,
  );
  if (completions.length === 0 && completionResults.length === 0) {
    return {};
  }
  // Display markers carry no authority. Assistant quotes are stripped from
  // the request but never treated as parent-bound completions.
  // The durable authority: the child returns this family crossed, retained by
  // the runtime at ChildEnd. Nothing the client carries proves a return.
  const available = (
    await loadChildReturns({
      organizationId: params.binding.session.organization_id,
      parentSessionId: params.binding.session.session_id,
    })
  ).map((record) => ({
    ...record,
    ...(record.spawnCallId
      ? { spawnCallId: envelopeIdOf(record.spawnCallId) }
      : {}),
  }));
  const directSpawnResults = new Set(
    params.results
      .filter((result) => adapter?.isSpawnTool(result.name, result.namespace))
      .map((result) => envelopeIdOf(result.id)),
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
      ? envelopeIdOf(completion.spawnCallId)
      : completion.envelopeId &&
          directSpawnResults.has(envelopeIdOf(completion.envelopeId))
        ? envelopeIdOf(completion.envelopeId)
        : undefined;
    const candidates = available.flatMap((record, index) =>
      record.value === completion.value ? [{ record, index }] : [],
    );
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
      throw new ApiError(
        400,
        "OpenAPPA rejected a child return for another spawn call",
      );
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
      throw new ApiError(
        409,
        "OpenAPPA withheld an unverified child completion",
      );
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
        ? envelopeIdOf(completion.spawnCallId)
        : undefined) ??
      (completion.envelopeId &&
      directSpawnResults.has(envelopeIdOf(completion.envelopeId))
        ? envelopeIdOf(completion.envelopeId)
        : undefined);
    if (!spawnCallId) {
      throw new ApiError(
        409,
        "OpenAPPA cannot bind the child completion to its spawn call",
      );
    }
    if (completion.envelopeId) {
      const envelopeId = envelopeIdOf(completion.envelopeId);
      if (directSpawnResults.has(envelopeId) && envelopeId !== spawnCallId) {
        throw new ApiError(
          400,
          "OpenAPPA rejected a child return for another spawn call",
        );
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
  if (
    completionResults.some(
      (result) => (byEnvelope.get(envelopeIdOf(result.id)) ?? []).length === 0,
    )
  ) {
    throw new ApiError(
      409,
      "OpenAPPA withheld an unverified child completion from the parent",
    );
  }
  // Records every verified crossing with the runtime. The runtime re-checks
  // each value against the return its fork bound, so a client-named spawn
  // call cannot stand for a child it never opened.
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
    const envelopeId = envelopeIdOf(result.id);
    const verified = byEnvelope.get(envelopeId) ?? [];
    if (verified.length === 0) {
      throw new ApiError(
        409,
        "OpenAPPA withheld an unverified child completion",
      );
    }
    updates[result.id] =
      verified.length === 1 &&
      adapter?.isSpawnTool(result.name, result.namespace)
        ? verified[0].value
        : JSON.stringify({
            status: Object.fromEntries(
              matched
                .filter(({ record }) => verified.includes(record))
                .map(({ completion, record }) => [
                  completion.childNativeId ?? record.childNativeId,
                  { completed: record.value },
                ]),
            ),
          });
  }
  return updates;
}

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
  if (!binding.session.parent_id || !spawnCallId) {
    throw new ApiError(
      503,
      "OpenAPPA cannot correlate the child return to its parent",
    );
  }
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
  };
}

/**
 * The spawn call a child return answers. Lineage carries it from the child's
 * first request. A later request may lose that marker, so the child's first
 * retained prompt recovers its signed spawn binding without guessing from
 * unrelated parent calls.
 */
async function resolveSpawnCallId(
  binding: AppaPluginBinding,
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
  appendQuestionContinuation({
    request: context.request,
    interactionType: context.interactionType,
    guidance: nativeDelegationGuidance(waitDeclared),
  });
}
const SHELL_REMEDY_RESULT_GUIDANCE =
  "The bash result immediately above is an OpenAPPA ruling delivered through the client's native shell because this session has no MCP gateway; the blocked call did not run. Do not retry the blocked call and do not call get_remedy_plans or execute_remedy_plan — no gateway is connected to run them. Explain the denial and its ruling to the user, then stop that action.";

const CODEX_SHELL_REMEDY_RESULT_GUIDANCE =
  "The exec_command result immediately above is an OpenAPPA ruling delivered through the client's native shell because this session has no MCP gateway; the blocked call did not run. Do not retry the blocked call and do not call get_remedy_plans or execute_remedy_plan — no gateway is connected to run them. Explain the denial and its ruling to the user, then stop that action.";

const PROXY_ONLY_SHELL_REMEDY_RESULT_GUIDANCE =
  "The bash result above carries a verified OpenAPPA ruling for a blocked call; the blocked call did not run. The ruling already includes remedy offers, so do not call get_remedy_plans. If it offers a plan, call the declared archestra__execute_remedy_plan with the exact offer_id and plan; the proxy converts that call into your native bash tool and enforces the runtime's authorization and review gates. Never invent an offer or treat a pending review as approval.";

const CODEX_PROXY_ONLY_SHELL_REMEDY_RESULT_GUIDANCE =
  "The exec_command result above carries a verified OpenAPPA ruling for a blocked call; the blocked call did not run. The ruling already includes remedy offers, so do not call get_remedy_plans. If it offers a plan, call the declared archestra__execute_remedy_plan with the exact offer_id and plan; the proxy converts that call into the declared functions.exec_command and enforces the runtime's authorization and review gates. Never invent an offer or treat a pending review as approval.";

const CODEX_PROXY_ONLY_REMEDY_WORKFLOW_GUIDANCE =
  "When a signed OpenAPPA ruling offers a remedy, call the declared archestra__execute_remedy_plan with its exact offer_id and plan. The proxy executes it using a single-use request through the declared functions.exec_command. If it returns review_required, use the declared archestra__ask_user only if that tool is available; otherwise tell the user review is unavailable in this client and stop. Do not retry a blocked tool until the remedy reports successful authorization or sanitization. A declined or unavailable review leaves the call blocked.";

const PROXY_ONLY_REMEDY_WORKFLOW_GUIDANCE =
  "When a signed OpenAPPA ruling offers a remedy, call the declared archestra__execute_remedy_plan with its exact offer_id and plan. The proxy executes it using a single-use request through the client's native bash tool. If it returns review_required, use the declared archestra__ask_user only if that tool is available; otherwise tell the user review is unavailable in this client and stop. Do not retry a blocked tool until the remedy reports successful authorization or sanitization. A declined or unavailable review leaves the call blocked.";

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

/**
 * EXPERIMENTAL shell remedy: claims the single-use cached markers of the
 * shell-carried rulings restored in this request. Only a fresh return (first
 * request carrying the result) consumes its marker and earns the guidance;
 * replayed history restores silently.
 */
async function claimShellRemedyResults(params: {
  binding: AppaPluginBinding;
  results: ReadonlyArray<{ id: string }>;
}): Promise<number> {
  const { binding } = params;
  if (binding.restoredShellRemedyCallIds.size === 0) return 0;
  const keys = params.results
    .filter((result) => binding.restoredShellRemedyCallIds.has(result.id))
    .map((result) =>
      shellRemedyCacheKey({ session: binding.session, id: result.id }),
    );
  if (keys.length === 0) return 0;
  const claimed = await cacheManager.getAndDeleteMany<{ nonce?: unknown }>(
    keys,
  );
  if (claimed.length > 0) {
    logger.debug(
      { count: claimed.length },
      "Recorded shell remedy ruling return",
    );
  }
  return claimed.length;
}

function shellRemedyCacheKey(params: {
  session: OpenAppaSession;
  id: string;
}): AllowedCacheKey {
  const scope = nativeQuestionTag({
    session: params.session,
    name: "shell-remedy",
    nonce: params.id,
  }).toString("base64url");
  return `${CacheKey.OpenAppaShellRemedy}-${scope}`;
}

function shellRemedyAdapter(
  adapter: AppaPluginBinding["adapter"],
): adapter is NonNullable<AppaPluginBinding["adapter"]> {
  return (
    adapter?.id === "opencode" ||
    adapter?.id === "claude-code" ||
    adapter?.id === "codex"
  );
}

function matchesNativeShell(
  binding: AppaPluginBinding,
  name: string,
  namespace?: string,
): boolean {
  const adapter = binding.adapter;
  if (!adapter) return false;
  if (binding.identity.attestationOf(name, namespace)) return false;
  if (adapter.classifyToolName(name, namespace) !== "local") return false;
  const normalized = adapter.normalizeLocalToolName(name).toLowerCase();
  return adapter.id === "codex"
    ? normalized === "exec_command"
    : normalized === SHELL_REMEDY_TOOL_NAME;
}

function shellArgumentName(
  adapter: NonNullable<AppaPluginBinding["adapter"]>,
): "command" | "cmd" {
  return adapter.id === "codex" ? "cmd" : "command";
}

function nativeShellArguments(
  adapterId: string | undefined,
  script: string,
  description: string,
  options?: { yieldTimeMs?: number },
): Record<string, string | number> {
  if (adapterId !== "codex") return { command: script, description };
  return {
    cmd: script,
    // Codex stops a still-running exec_command at its 10s default and reports
    // "Process running". The remedy curl must finish in this same client turn.
    ...(options?.yieldTimeMs ? { yield_time_ms: options.yieldTimeMs } : {}),
  };
}

function shellRemedyResultGuidance(
  adapterId: string | undefined,
  proxyOnly: boolean,
): string {
  if (adapterId === "codex") {
    return proxyOnly
      ? CODEX_PROXY_ONLY_SHELL_REMEDY_RESULT_GUIDANCE
      : CODEX_SHELL_REMEDY_RESULT_GUIDANCE;
  }
  return proxyOnly
    ? PROXY_ONLY_SHELL_REMEDY_RESULT_GUIDANCE
    : SHELL_REMEDY_RESULT_GUIDANCE;
}

function declaredLocalTool(
  binding: AppaPluginBinding,
  toolName: string,
): { name: string; namespace?: string } | undefined {
  const adapter = binding.adapter;
  if (!adapter) return undefined;
  const tool = (binding.request.declaredTools ?? []).find((item) => {
    if (binding.identity.attestationOf(item.name, item.namespace)) return false;
    if (adapter.classifyToolName(item.name, item.namespace) !== "local")
      return false;
    return adapter.normalizeLocalToolName(item.name) === toolName;
  });
  if (!tool) return undefined;
  return {
    name: adapter.normalizeLocalToolName(tool.name),
    ...(tool.namespace ? { namespace: tool.namespace } : {}),
  };
}

function nativeQuestionNamespaceMatches(
  binding: AppaPluginBinding,
  namespace: string | undefined,
): boolean {
  const declared = binding.adapter?.nativeQuestion
    ? declaredLocalTool(binding, binding.adapter.nativeQuestion.toolName)
    : undefined;
  if (!declared?.namespace) return !namespace;
  return !namespace || namespace === declared.namespace;
}

function shellToolContainer(
  body: Record<string, unknown> | undefined,
): unknown[] | undefined {
  if (!body) return undefined;
  if (Array.isArray(body.tools)) return body.tools;
  const input = body.input;
  if (!Array.isArray(input)) return undefined;
  const additional = input.find(
    (item) => isRecord(item) && item.type === "additional_tools",
  );
  return isRecord(additional) && Array.isArray(additional.tools)
    ? additional.tools
    : undefined;
}

/**
 * The declared spelling of the client's native shell tool, if any. An
 * attested or gateway-classified name is never the client's own shell.
 */
function declaredShellTool(
  binding: AppaPluginBinding,
): { name: string; namespace: string } | undefined {
  const adapter = binding.adapter;
  if (!adapter) return undefined;
  const tool = (binding.request.declaredTools ?? []).find((item) =>
    matchesNativeShell(binding, item.name, item.namespace),
  );
  if (!tool) return undefined;
  const dottedFunctions = tool.name.startsWith("functions.");
  return {
    name: dottedFunctions
      ? adapter.normalizeLocalToolName(tool.name)
      : tool.name,
    namespace: tool.namespace ?? (dottedFunctions ? "functions" : ""),
  };
}

function hasRemedyOfferResult(params: {
  binding: AppaPluginBinding;
  results: LlmProxyToolResultsContext["toolResults"];
  verifiedNativeQuestionResults: ReadonlyMap<object, NativeQuestionClaim>;
}): boolean {
  let latestBlockedResult = -1;
  for (const [index, result] of params.results.entries()) {
    if (result.isError) continue;
    // A shell-carried ruling has no execute path to continue with.
    // A declined issued notice keeps its native stdout and must not open a
    // fresh remedy continuation.
    if (
      params.binding.restoredShellRemedyCallIds.has(result.id) ||
      params.binding.declinedShellNoticeCallIds.has(result.id)
    )
      continue;
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
  proxyOnlyShell = false,
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
  if (rulings.some((entry) => entry.ruling === "none")) {
    return [
      "The native question returned no verified Approve or Deny answer. Selecting Dismiss leaves this offer unanswered; failure or cancellation also grants no authority.",
      "Do not claim that the human denied or approved it. The dependent call remains blocked.",
      "Continue other independent pending reviews and authorized work. Do not retry this offer or its dependent action without a new user request and review.",
    ].join(" ");
  }
  return [
    "The verified human answer did not approve the pending OpenAPPA review.",
    proxyOnlyShell
      ? "Only the denied offer and its exact blocked call remain blocked. Other calls authorized by independent offers may proceed, but must still pass OpenAPPA policy."
      : "Do not call execute_remedy_plan and do not retry the blocked tool.",
    proxyOnlyShell
      ? "Do not execute the denied offer again. Finish only independent authorized work."
      : "State briefly that the action remains blocked, then stop that action.",
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
  if (appaWireFamily(params.interactionType) === "openai:chatCompletions") {
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
  // tool_choice. A flat synthetic control can, and that choice must survive.
  const choice = params.context.request.tool_choice;
  if (
    !(
      isRecord(choice) &&
      choice.type === "function" &&
      typeof choice.name === "string"
    )
  ) {
    params.context.request.tool_choice = "required";
  }
  params.context.request.parallel_tool_calls = false;
}

/** A required native review/continuation must not become a prose-only turn. */
function requireProxyOnlyWorkflowTool(params: {
  binding: AppaPluginBinding;
  context: LlmProxyBeforeModelContext;
  tool: "askUser" | "control";
}): void {
  if (!params.binding.proxyOnlyShell || !isRecord(params.context.request)) {
    return;
  }
  const name = params.binding.request.tools?.[params.tool]?.name;
  if (
    !name ||
    !Array.isArray(params.context.request.tools) ||
    !params.context.request.tools.some(
      (tool) =>
        isRecord(tool) &&
        (isRecord(tool.function) ? tool.function.name : tool.name) === name,
    )
  ) {
    return;
  }
  const family = appaWireFamily(params.context.interactionType);
  if (family === "anthropic:messages") {
    // Anthropic disallows a forced named tool while extended thinking is on.
    // Restrict the available tools to the verified continuation in that mode.
    const thinking = params.context.request.thinking;
    if (isRecord(thinking) && thinking.type !== "disabled") {
      params.context.request.tools = params.context.request.tools.filter(
        (tool) => isRecord(tool) && tool.name === name,
      );
      params.context.request.tool_choice = {
        type: "auto",
        disable_parallel_tool_use: true,
      };
    } else {
      params.context.request.tool_choice = {
        type: "tool",
        name,
        disable_parallel_tool_use: true,
      };
    }
    return;
  }
  if (family === "openai:responses") {
    params.context.request.tool_choice = { type: "function", name };
    params.context.request.parallel_tool_calls = false;
    return;
  }
  if (family !== "openai:chatCompletions") return;
  params.context.request.tool_choice = {
    type: "function",
    function: { name },
  };
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
