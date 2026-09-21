import {
  APPA_PARENT_HEADER,
  APPA_SESSION_HEADER,
  extractMcpToolError,
  isSeededAppRenderToolResult,
  TOOL_ASK_USER_SHORT_NAME,
  TOOL_EXECUTE_REMEDY_PLAN_SHORT_NAME,
} from "@archestra/shared";
import {
  type CallToolResult,
  CallToolResultSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { archestraMcpBranding } from "@/archestra-mcp-server/branding";
import config from "@/config";
import { getDatabaseConnectionString } from "@/database";
import logger from "@/logging";
import { openappaBatteriesService } from "@/openappa/batteries";
import { normalizeToolCallsForPolicy } from "@/routes/proxy/llm-proxy-helpers";
import type { ToolNameCanonicalizer } from "@/routes/proxy/utils/gateway-tool-names";
import { isGuardrailsV2Active } from "@/services/guardrails-deployment";
import { guardrailsPolicyService } from "@/services/guardrails-policy";
import { ApiError, type CommonToolResult } from "@/types";
import type { DeclaredToolSpelling } from "./wire";

export { APPA_PARENT_HEADER, APPA_SESSION_HEADER };
export const APPA_CHAT_SOURCES = [
  "chat",
  "chat:tool_call_repair",
  "chat:compaction",
] as const;
export type AppaChatSource = (typeof APPA_CHAT_SOURCES)[number];
type ExecutionOutcome = "success" | "failure" | "unknown";
type OutputSource = "tool" | "runtime";
type RuntimeReason = string;
export type OpenAppaSession = {
  organization_id: string;
  caller_id?: string;
  session_id: string;
  parent_id?: string;
  /**
   * The session this one forks, on a new session whose history the proxy
   * traced to it: its first event opens a root of its own seeded from that
   * session's labels.
   */
  fork_of?: string;
};

const ResultDecisionFields = {
  approved_output: z.string().optional(),
  output_source: z.enum(["tool", "runtime"]).optional(),
  reason: z.string().optional(),
};

/** Structured remedy offers from the native runtime. */
const NativeOfferSchema = z
  .object({ offer_id: z.string().min(1) })
  .passthrough();

/** Validation schema for decisions returned by the native runtime. */
const NativeDecisionSchema = z
  .discriminatedUnion("decision", [
    z.object({ decision: z.literal("ack"), ...ResultDecisionFields }),
    z.object({ decision: z.literal("allow_call") }),
    z.object({ decision: z.literal("pass_control") }),
    z.object({
      decision: z.literal("deny_call"),
      feedback: z.string(),
      offers: z.array(NativeOfferSchema).optional(),
      review: z
        .array(
          z.object({
            offer_id: z.string(),
            text: z.string(),
          }),
        )
        .optional(),
      ...ResultDecisionFields,
    }),
    z.object({
      decision: z.literal("block"),
      feedback: z.string().optional(),
      ...ResultDecisionFields,
    }),
    z.object({
      decision: z.literal("replace_output"),
      ...ResultDecisionFields,
    }),
    z.object({
      decision: z.literal("deliver_value"),
      value: z.string(),
      ...ResultDecisionFields,
    }),
    z.object({
      decision: z.literal("child_return"),
      value: z.string(),
      ...ResultDecisionFields,
    }),
    z.object({ decision: z.literal("context") }),
    z.object({ decision: z.literal("refuse"), detail: z.string() }),
    z.object({
      decision: z.literal("mcp_result"),
      result: CallToolResultSchema.optional(),
      offer: z
        .object({ status: z.enum(["known", "unknown"]) })
        .strict()
        .optional(),
      ...ResultDecisionFields,
    }),
  ])
  .superRefine((decision, context) => {
    if (!isOutputDecision(decision)) return;
    const hasOutput =
      decision.approved_output !== undefined ||
      ("value" in decision && decision.value !== undefined) ||
      decision.decision === "block";
    const outputSource = decision.output_source;
    if (!hasOutput && outputSource !== undefined) {
      context.addIssue({
        code: "custom",
        message: "Native output source requires approved output",
      });
    }
    const reason = decision.reason;
    if (
      reason !== undefined &&
      (!hasOutput || (outputSource !== undefined && outputSource !== "runtime"))
    ) {
      context.addIssue({
        code: "custom",
        message: "Native runtime reason requires runtime output source",
      });
    }
  });

type NativeDecision = z.infer<typeof NativeDecisionSchema>;
type NativeOutputDecision = Extract<
  NativeDecision,
  {
    decision:
      | "ack"
      | "deny_call"
      | "replace_output"
      | "deliver_value"
      | "child_return"
      | "mcp_result"
      | "block";
  }
>;
type ProcessedToolResult = {
  content: string;
  outputSource: OutputSource;
  reason?: RuntimeReason;
};

let native: Promise<typeof import("@archestra/openappa-rs")> | undefined;
export function openappaYellEnabled(): boolean {
  return config.openappa.enabled && config.openappa.yellEnabled;
}

export function openappaEnabled(): boolean {
  return config.openappa.enabled;
}

export async function executeYell(params: {
  session: OpenAppaSession;
  toolCallId: string;
  args: { message: string; with_trajectory: boolean };
}): Promise<CallToolResult> {
  if (!openappaYellEnabled())
    throw new ApiError(404, "OpenAPPA reporting is disabled");
  return runtimeToolResult(
    await dispatch(params.session, {
      event: "yell",
      operation_id: `yell:${params.toolCallId}`,
      arguments: params.args,
    }),
  );
}

/** The A2A executor identifies nested runs with a chain of agent UUIDs. */
export function isAppaDelegatedRun(
  agentId: string,
  delegationChain: string | undefined,
): boolean {
  const chain = delegationChain?.split(":") ?? [];
  return (
    chain.length > 1 &&
    chain.at(-1) === agentId &&
    chain.every((id) => z.uuid().safeParse(id).success)
  );
}

export function isAppaChatSource(
  source: string | undefined,
): source is AppaChatSource {
  return (APPA_CHAT_SOURCES as readonly string[]).includes(source ?? "");
}

async function binding(content: string) {
  if (!openappaEnabled()) {
    throw new Error("OpenAPPA is disabled");
  }
  // The addon compiles `content` before it serves it, and a composed document
  // names the helper bridge bearer as a `token_env` the runtime resolves from
  // this process's environment. Publish it on every crossing, not once at
  // import time, so opening and reloading never depend on module order.
  openappaBatteriesService.publishBridgeToken();
  native ??= (async () => {
    const module = await import("@archestra/openappa-rs");
    const url = new URL(getDatabaseConnectionString());
    // pg ignores Prisma's legacy schema parameter; rust-postgres rejects it.
    url.searchParams.delete("schema");
    await module.initializeOpenappa(
      url.toString(),
      config.openappa.postgresMaxConnections,
      content,
      openappaYellEnabled()
        ? {
            endpoint: "https://appa-yell-wkjbuewj5a-ew.a.run.app",
            hostname: new URL(config.frontendBaseUrl).hostname,
          }
        : undefined,
    );
    return module;
  })().catch((error) => {
    native = undefined;
    throw error;
  });
  return native;
}

async function dispatch(
  session: OpenAppaSession,
  event: Record<string, unknown>,
  /** A policy the caller already read, shared across a batch of dispatches. */
  policyContent?: string,
) {
  return withRuntime(
    session.organization_id,
    (module, policy) =>
      module.dispatchHook(JSON.stringify({ ...session, ...event }), policy),
    policyContent,
  );
}

/** Executes a callback with the loaded native runtime and organization policy. */
async function withRuntime(
  organizationId: string,
  call: (
    module: Awaited<ReturnType<typeof binding>>,
    policyContent: string,
  ) => Promise<string>,
  policyContent?: string,
) {
  const policy = policyContent ?? (await effectivePolicy(organizationId));
  try {
    const module = await binding(policy);
    const rawResult = await call(module, policy);
    return NativeDecisionSchema.parse(JSON.parse(rawResult));
  } catch (error) {
    throw unsafeToProceed(error);
  }
}

/** The organization's effective policy content, or the refusal every dispatch shares. */
async function effectivePolicy(organizationId: string): Promise<string> {
  try {
    if (!(await isGuardrailsV2Active()))
      throw new Error("Guardrails v2 is disabled");
    return (await openappaBatteriesService.getEffectivePolicy(organizationId))
      .content;
  } catch (error) {
    throw unsafeToProceed(error);
  }
}

/** Do not forward internal diagnostics or credentials to clients. */
function unsafeToProceed(error: unknown): ApiError {
  const failure = new ApiError(
    503,
    "OpenAPPA could not safely complete this operation",
  );
  failure.cause = error;
  return failure;
}

export function chatOpenAppaSession(
  organizationId: string,
  userId: string,
  sessionId: string,
): OpenAppaSession {
  return {
    organization_id: organizationId,
    caller_id: `user:${userId}`,
    session_id: sessionId,
  };
}

/** Validates that a session or parent ID is non-empty and within byte limits. */
export function isWellFormedAppaId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= 512 &&
    !/\p{Cc}/u.test(value)
  );
}

/**
 * Resolves an OpenAPPA session from universal X-Appa-* headers.
 *
 * Headers:
 * - X-Appa-Session-ID: session trajectory ID
 * - X-Appa-Parent-ID: optional parent ID for child sessions
 */
export function sessionFromHeaders(params: {
  headers: Record<string, unknown>;
  organizationId: string;
  callerId?: string;
  /** Root to bind when no session header was provided. */
  fallbackSessionId?: string;
  /**
   * Prefix scoping this session to the authenticated principal to prevent
   * cross-user session collisions.
   */
  scope?: string;
}): OpenAppaSession | undefined {
  if (!openappaEnabled()) return undefined;
  const headerSessionId = params.headers[APPA_SESSION_HEADER.toLowerCase()];
  const headerParentId = params.headers[APPA_PARENT_HEADER.toLowerCase()];
  const valid = isWellFormedAppaId;
  if (
    (headerSessionId !== undefined && !valid(headerSessionId)) ||
    (headerParentId !== undefined && !valid(headerParentId))
  )
    throw new ApiError(
      400,
      "OpenAPPA requires valid X-Appa-Session-ID and optional X-Appa-Parent-ID headers",
    );
  const scoped = (id: string) => (params.scope ? `${params.scope}|${id}` : id);
  const sessionId = valid(headerSessionId)
    ? scoped(headerSessionId)
    : params.fallbackSessionId;
  if (sessionId === undefined) return undefined;
  return {
    organization_id: params.organizationId,
    ...(params.callerId ? { caller_id: params.callerId } : {}),
    session_id: sessionId,
    ...(valid(headerParentId) ? { parent_id: scoped(headerParentId) } : {}),
  };
}

async function startSession(session: OpenAppaSession, policyContent?: string) {
  const decision = await dispatch(
    session,
    { event: "session_start" },
    policyContent,
  );
  if (decision.decision === "context") {
    // The initial Chat adapter has no child-return lifecycle yet. Refuse
    // rather than silently discard a child's required return contract.
    throw new ApiError(
      409,
      "This child requires an OpenAPPA return contract; its adapter must deliver it before inference",
    );
  }
  if (decision.decision !== "ack")
    throw new ApiError(409, decisionMessage(decision));
}

function extractApprovedOutput(
  decision: NativeDecision,
  fallbackOutput: string,
): string {
  if ("approved_output" in decision && decision.approved_output !== undefined) {
    return decision.approved_output;
  }
  if ("feedback" in decision && typeof decision.feedback === "string") {
    return decision.feedback;
  }
  if ("reason" in decision && typeof decision.reason === "string") {
    return decision.reason;
  }
  if ("detail" in decision && typeof decision.detail === "string") {
    return decision.detail;
  }
  if ("value" in decision && typeof decision.value === "string") {
    return decision.value;
  }
  if (
    decision.decision === "mcp_result" &&
    decision.result?.content &&
    Array.isArray(decision.result.content)
  ) {
    const textBlock = decision.result.content.find(
      (c) => c.type === "text" && typeof c.text === "string",
    );
    if (textBlock && "text" in textBlock) {
      return textBlock.text;
    }
  }
  return fallbackOutput;
}

async function approveToolResult(params: {
  session: OpenAppaSession;
  toolCallId: string;
  output: string;
  outcome: ExecutionOutcome;
  controlToolName?: string;
  policyContent?: string;
}): Promise<ProcessedToolResult> {
  const decision = await dispatch(
    params.session,
    {
      event: "tool_result",
      tool_call_id: params.toolCallId,
      output: params.output,
      outcome: params.outcome,
      ...(params.controlToolName
        ? { presentation: nativePresentation(params.controlToolName) }
        : {}),
    },
    params.policyContent,
  );
  const content = extractApprovedOutput(decision, params.output);
  const outputSource =
    ("output_source" in decision ? decision.output_source : undefined) ??
    ("reason" in decision && decision.reason ? "runtime" : "tool");
  const reason =
    "reason" in decision && decision.reason ? decision.reason : undefined;
  return {
    content,
    outputSource,
    ...(reason ? { reason } : {}),
  };
}

function isOutputDecision(
  decision: NativeDecision,
): decision is NativeOutputDecision {
  return (
    decision.decision === "ack" ||
    decision.decision === "deny_call" ||
    decision.decision === "replace_output" ||
    decision.decision === "deliver_value" ||
    decision.decision === "child_return" ||
    decision.decision === "mcp_result" ||
    decision.decision === "block"
  );
}

/**
 * Submits tool results to the OpenAPPA runtime for evaluation and updates.
 */
export async function processProxyResults(params: {
  session: OpenAppaSession;
  results: CommonToolResult[];
  canonicalize: (name: string) => string;
  /** The proxy verifies that this exact result belongs to an issued question. */
  isUserQuestion?: (result: CommonToolResult) => boolean;
  controlToolName?: string;
  trustedChat?: boolean;
}) {
  // The results dispatch one after another; one policy read serves them all.
  const policyContent = await effectivePolicy(params.session.organization_id);
  await startSession(params.session, policyContent);
  const updates: Record<string, ProcessedToolResult> = {};
  for (const result of params.results) {
    if (params.trustedChat && isSeededAppRenderToolResult(result.content))
      continue;
    // The runtime released no question call, so it would withhold the answer.
    if (params.isUserQuestion?.(result) === true) continue;
    const error =
      extractMcpToolError(result) ?? extractMcpToolError(result.content);
    const outcome: ExecutionOutcome =
      error?.type === "cancelled"
        ? "unknown"
        : result.isError
          ? "failure"
          : "success";
    const approved = await approveToolResult({
      session: params.session,
      toolCallId: result.id,
      output:
        typeof result.content === "string"
          ? result.content
          : JSON.stringify(result.content),
      outcome,
      controlToolName: params.controlToolName,
      policyContent,
    });
    updates[result.id] = approved;
  }
  return {
    toolResultUpdates: updates,
    contextIsTrusted: true,
    dualLlmAnalyses: [],
    unsafeContextBoundary: undefined,
  };
}

/** Decision for a proposed tool call. */
type AppaCallDecision =
  | { kind: "allow" }
  | { kind: "control" }
  | {
      kind: "deny";
      feedback: string;
      offers?: string[];
      review?: Array<{ offer_id: string; text: string }>;
    };

export async function evaluateToolCalls(
  session: OpenAppaSession,
  calls: Array<{
    id: string;
    name: string;
    arguments: string | object;
    namespace?: string;
  }>,
  options: {
    canonicalize: ToolNameCanonicalizer;
    isUserQuestion?: (name: string) => boolean;
    /** Compat only: recognize a `run_tool` wrapper behind any client label. */
    looseRunToolDispatch?: boolean;
    /** This session's control tool declaration, as the client spells it. */
    control?: DeclaredToolSpelling;
  },
): Promise<AppaCallDecision[]> {
  const ids = new Set<string>();
  // Validate tool call IDs and arguments before dispatch.
  for (const call of calls) {
    if (!call.id || ids.has(call.id)) {
      throw new ApiError(400, "OpenAPPA requires distinct tool-call IDs");
    }
    ids.add(call.id);
    if (typeof call.arguments === "string") {
      try {
        JSON.parse(call.arguments);
      } catch {
        throw new ApiError(
          400,
          "OpenAPPA cannot release malformed tool arguments",
        );
      }
    }
  }
  const normalized = normalizeToolCallsForPolicy(calls, {
    canonicalize: options.canonicalize,
    looseRunToolDispatch: options.looseRunToolDispatch === true,
  });
  const admitted: string[] = [];
  const results = await Promise.allSettled(
    calls.map(async (call, index) => {
      const target = normalized[index];
      // Direct remedy control calls bypass evaluation and execute via gateway.
      // Only the declared control tool itself, in its own namespace: a
      // same-named tool elsewhere is someone else's and is evaluated.
      if (
        options.control &&
        call.name === options.control.name &&
        call.namespace === options.control.namespace
      ) {
        return { kind: "control" as const };
      }
      if (
        options.isUserQuestion?.(call.name) ??
        isPlatformUserQuestion(call.name, options.canonicalize)
      ) {
        return { kind: "allow" as const };
      }
      // The target is already canonical, so it is read, not re-canonicalized.
      const tool =
        archestraMcpBranding.getToolShortName(target.toolCallName) === "yell"
          ? "yell"
          : target.toolCallName;
      const event = {
        event: "tool_call",
        operation_id: `call:${call.id}`,
        tool,
        ...(tool !== call.name &&
        options.canonicalize(call.name, call.namespace) === tool
          ? { spelling: call.name }
          : {}),
        presentation: nativePresentation(options.control?.name),
        arguments: JSON.parse(target.toolCallArgs),
        // Delegation evaluates through the parent policy until child adapters exist.
        spawn: false,
      };
      const decision = await dispatch(session, event);
      if (
        decision.decision === "allow_call" ||
        decision.decision === "pass_control"
      ) {
        admitted.push(call.id);
        return { kind: "allow" as const };
      }
      // Denied calls return as notices; other calls in the batch stand.
      return {
        kind: "deny" as const,
        feedback: decisionMessage(decision),
        offers:
          decision.decision === "deny_call"
            ? (decision.offers ?? [])
                .map((offer) => offer.offer_id)
                .filter((id) => id.length > 0)
            : [],
        review:
          decision.decision === "deny_call"
            ? "review" in decision
              ? decision.review
              : undefined
            : undefined,
      };
    }),
  );

  const firstFailure = results.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (firstFailure) {
    if (admitted.length > 0) {
      // Cancel admitted calls from this batch if evaluation failed mid-batch.
      const cancelResults = await Promise.allSettled(
        admitted.map((id) =>
          dispatch(session, { event: "cancel_call", tool_call_id: id }),
        ),
      );
      for (const [index, cancelResult] of cancelResults.entries()) {
        if (cancelResult.status === "rejected") {
          logger.warn(
            {
              err: cancelResult.reason,
              toolCallId: admitted[index],
              sessionId: session.session_id,
            },
            "Failed to cancel OpenAPPA admitted call during batch failure cleanup",
          );
        }
      }
    }
    throw firstFailure.reason;
  }

  return results.map(
    (result) => (result as PromiseFulfilledResult<AppaCallDecision>).value,
  );
}

/** Verdict on a call the provider already ran. */
type AppaHostedCallDecision =
  | { kind: "release" }
  | { kind: "hold"; feedback: string };

/**
 * Rules on calls the provider ran inside the inference call. Nothing can stop
 * such a call, so the ruling is on what it brought in: a call the policy would
 * have denied, or a result it stages, is held behind the ruling's offers and
 * reaches the model only through a remedy. A policy that lists the tool under
 * `confined_results` stages the result itself, so accepting the offer returns
 * it; any other denial drops it, and the model searches again once allowed.
 */
export async function evaluateHostedToolCalls(
  session: OpenAppaSession,
  calls: ReadonlyArray<{
    id: string;
    name: string;
    arguments: Record<string, unknown>;
    output: string;
  }>,
  options: Parameters<typeof evaluateToolCalls>[2],
): Promise<AppaHostedCallDecision[]> {
  const decisions = await evaluateToolCalls(session, [...calls], options);
  if (decisions.some((decision) => decision.kind === "deny")) {
    await cancelCalls(
      session,
      calls.flatMap((call, index) =>
        decisions[index].kind === "allow" ? [call.id] : [],
      ),
    );
    return decisions.map((decision) =>
      decision.kind === "deny"
        ? { kind: "hold", feedback: decision.feedback }
        : { kind: "release" },
    );
  }
  const verdicts: AppaHostedCallDecision[] = [];
  for (const call of calls) {
    const approved = await approveToolResult({
      session,
      toolCallId: call.id,
      output: call.output,
      outcome: "success",
      controlToolName: options.control?.name,
    });
    verdicts.push(
      approved.outputSource === "tool" && approved.content === call.output
        ? { kind: "release" }
        : { kind: "hold", feedback: approved.content },
    );
  }
  return verdicts;
}

/** Cancels admitted tool calls when the carrier response is withheld. */
export async function cancelCalls(
  session: OpenAppaSession,
  ids: readonly string[],
): Promise<void> {
  const results = await Promise.allSettled(
    ids.map((id) =>
      dispatch(session, { event: "cancel_call", tool_call_id: id }),
    ),
  );
  for (const [index, result] of results.entries()) {
    if (result.status === "rejected") {
      logger.warn(
        {
          err: result.reason,
          toolCallId: ids[index],
          sessionId: session.session_id,
        },
        "Failed to cancel OpenAPPA admitted call",
      );
    }
  }
}

/** Reports the start of a user turn, before the model is called. */
export async function notePrompt(
  session: OpenAppaSession,
  operationId: string,
): Promise<void> {
  await dispatch(session, { event: "prompt", operation_id: operationId });
}

/**
 * Closes the turn once the model answers with no tool call left to run.
 *
 * A response carrying a call — an ordinary one, a denial notice, or the model's
 * own remedy call — leaves the turn open: the client still has work to do, and
 * closing here would release the remedy the client is about to execute.
 */
export async function endTurn(
  session: OpenAppaSession,
  operationId: string,
): Promise<void> {
  await dispatch(session, { event: "turn_end", operation_id: operationId });
}

function runtimeToolResult(decision: NativeDecision): CallToolResult {
  if (decision.decision !== "mcp_result")
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: decisionMessage(decision),
        },
      ],
    };
  if (decision.result) return decision.result;
  return {
    isError: false,
    content: [{ type: "text", text: decision.approved_output ?? "" }],
  };
}

function decisionMessage(decision: NativeDecision): string {
  switch (decision.decision) {
    case "deny_call":
      return decision.feedback;
    case "block":
      return (
        decision.reason ??
        decision.feedback ??
        decision.approved_output ??
        "OpenAPPA blocked this operation"
      );
    case "refuse":
      return decision.detail;
    default:
      return "OpenAPPA refused this operation";
  }
}

/**
 * Executes a remedy using a verified host routing claim.
 */
export async function executeRemedyByOffer(params: {
  organizationId: string;
  /** The principal the gateway authenticated, in the proxy's `user:<id>` form. */
  callerId?: string;
  /** Minted session the signed offer claims name. */
  sessionId: string;
  parentId?: string;
  /** Principal that minted the offer, from verified claims. */
  ownerCallerId?: string;
  tool?: string;
  spelling?: string;
  /** The client's dispatch tool the blocked call went through, from verified claims. */
  dispatch?: string;
  /** Provider or client-supplied logical execution identity, when available. */
  toolCallId?: string;
  controlToolName?: string;
  /** Exact validated client arguments, retained for durable receipt fingerprinting. */
  originalArguments: string;
  args: unknown;
  ruling?: "approve" | "deny";
  /**
   * Model-visible reason the host asked no one: the reviewed call could not
   * run even if approved. Recorded verbatim as the remedy's result; the offer
   * stays unspent. Only for a remedy without a ruling.
   */
  precheckRefusal?: string;
}): Promise<{
  result: CallToolResult;
  /** Authorized owner lookup, not proof that the offer remains spendable. */
  known: boolean;
}> {
  const decision = await withRuntime(params.organizationId, (module, policy) =>
    module.executeRemedyByOffer(
      JSON.stringify({
        organization_id: params.organizationId,
        session_id: params.sessionId,
        ...(params.callerId ? { caller_id: params.callerId } : {}),
        ...(params.parentId ? { parent_id: params.parentId } : {}),
        ...(params.ownerCallerId
          ? { owner_caller_id: params.ownerCallerId }
          : {}),
        ...(params.tool ? { tool: params.tool } : {}),
        ...(params.spelling ? { spelling: params.spelling } : {}),
        ...(params.dispatch ? { dispatch: params.dispatch } : {}),
        execution_mode: params.toolCallId ? "tracked" : "untracked",
        ...(params.toolCallId ? { tool_call_id: params.toolCallId } : {}),
        original_arguments: params.originalArguments,
        arguments: params.args,
        presentation: nativePresentation(params.controlToolName),
        ...(params.ruling ? { ruling: params.ruling } : {}),
        ...(params.precheckRefusal
          ? { precheck_refusal: params.precheckRefusal }
          : {}),
      }),
      policy,
    ),
  );
  if (decision.decision !== "mcp_result" || !decision.offer) {
    throw new ApiError(503, "OpenAPPA returned no offer lookup state");
  }
  return {
    result: runtimeToolResult(decision),
    known: decision.offer.status === "known",
  };
}

/**
 * Loads the review entry for an offer from the retained DenyCall in PostgreSQL.
 * Session routing comes from the verified offer claims.
 */
export async function loadOfferReview(params: {
  organizationId: string;
  sessionId: string;
  offerId: string;
}): Promise<{
  offer_id: string;
  text: string;
  session_id: string;
  /** The reviewed call's tool, as the proxy proposed it for ruling. */
  tool?: string;
  /** The reviewed call's arguments as JSON text. */
  arguments?: string;
} | null> {
  try {
    if (!(await isGuardrailsV2Active())) return null;
    const policy = await guardrailsPolicyService.get(params.organizationId);
    const module = await binding(policy.content);
    const result = await module.loadOfferReview(
      params.organizationId,
      params.sessionId,
      params.offerId,
    );
    if (!result) return null;
    return {
      offer_id: result.offerId,
      text: result.text,
      session_id: result.sessionId,
      ...(result.tool ? { tool: result.tool } : {}),
      ...(result.arguments ? { arguments: result.arguments } : {}),
    };
  } catch (error) {
    logger.warn(
      { err: error, offerId: params.offerId },
      "Failed to load OpenAPPA offer review",
    );
    throw unsafeToProceed(error);
  }
}

function nativePresentation(controlToolName?: string): {
  control_tool: string;
  supports_delegation: false;
} {
  return {
    control_tool:
      controlToolName ??
      archestraMcpBranding.getToolName(TOOL_EXECUTE_REMEDY_PLAN_SHORT_NAME),
    supports_delegation: false,
  };
}

/**
 * Checks whether a tool is the platform question tool (`ask_user`).
 * Client adapters supply native question exemptions separately.
 */
function isPlatformUserQuestion(
  name: string,
  canonicalize: (name: string) => string,
): boolean {
  const canonical = canonicalize(name);
  return (
    archestraMcpBranding.getToolShortName(canonical) ===
    TOOL_ASK_USER_SHORT_NAME
  );
}
