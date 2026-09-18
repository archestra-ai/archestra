import {
  APPA_PARENT_HEADER,
  APPA_SESSION_HEADER,
  extractMcpToolError,
  isSeededAppRenderToolResult,
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
import { normalizeToolCallsForPolicy } from "@/routes/proxy/llm-proxy-helpers";
import { isGuardrailsV2Active } from "@/services/guardrails-deployment";
import { guardrailsPolicyService } from "@/services/guardrails-policy";
import { ApiError, type CommonToolResult } from "@/types";

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
};

const ResultDecisionFields = {
  approved_output: z.string().optional(),
  output_source: z.enum(["tool", "runtime"]).optional(),
  reason: z.string().optional(),
};

/** Structured remedies are authoritative; feedback prose never creates one. */
const NativeOfferSchema = z
  .object({ offer_id: z.string().min(1) })
  .passthrough();

/**
 * Native's public API is JSON, so this is the complete validation boundary.
 * Output source and runtime cause are data, never inferred from presentation
 * text. Persisted decisions from before the field existed safely default to
 * tool output, which is never rewritten for a client.
 */
const NativeDecisionSchema = z
  .discriminatedUnion("decision", [
    z.object({ decision: z.literal("ack"), ...ResultDecisionFields }),
    z.object({ decision: z.literal("allow_call") }),
    z.object({ decision: z.literal("pass_control") }),
    z.object({
      decision: z.literal("deny_call"),
      feedback: z.string(),
      offers: z.array(NativeOfferSchema).optional(),
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
  native ??= (async () => {
    const module = await import("@archestra/openappa-rs");
    const url = new URL(getDatabaseConnectionString());
    // pg ignores Prisma's legacy schema parameter; rust-postgres rejects it.
    url.searchParams.delete("schema");
    await module.initializeOpenappa(
      url.toString(),
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
) {
  return withRuntime(session.organization_id, (module, policy) =>
    module.dispatchHook(JSON.stringify({ ...session, ...event }), policy),
  );
}

/**
 * One runtime call, with the policy the organization runs and the failure
 * shape every caller gets: a native or database fault is never forwarded.
 */
async function withRuntime(
  organizationId: string,
  call: (
    module: Awaited<ReturnType<typeof binding>>,
    policyContent: string,
  ) => Promise<string>,
) {
  try {
    if (!(await isGuardrailsV2Active()))
      throw new Error("Guardrails v2 is disabled");
    const policy = await guardrailsPolicyService.get(organizationId);
    const module = await binding(policy.content);
    const rawResult = await call(module, policy.content);
    return NativeDecisionSchema.parse(JSON.parse(rawResult));
  } catch (error) {
    // Do not forward native/database diagnostics or credentials to the client.
    // The cause is available to the existing server-side error logger.
    const failure = new ApiError(
      503,
      "OpenAPPA could not safely complete this operation",
    );
    failure.cause = error;
    throw failure;
  }
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

/** An OpenAPPA session or parent id as a header may carry it. */
export function isWellFormedAppaId(value: unknown): value is string {
  // Bytes, as the runtime counts them: a header of a few hundred multibyte
  // characters must be refused here, not by the runtime as a failure.
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
 * Operates on the uniform header contract:
 * - X-Appa-Session-ID: required trajectory ID
 * - X-Appa-Parent-ID: optional parent trajectory ID for child sessions
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

async function startSession(session: OpenAppaSession) {
  const decision = await dispatch(session, { event: "session_start" });
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
}): Promise<ProcessedToolResult> {
  const decision = await dispatch(params.session, {
    event: "tool_result",
    tool_call_id: params.toolCallId,
    output: params.output,
    outcome: params.outcome,
    ...(params.controlToolName
      ? { presentation: nativePresentation(params.controlToolName) }
      : {}),
  });
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
 * Submits this request's tool results to the runtime.
 *
 * Every result is submitted, including results the client recorded against a
 * denial notice or its own remedy call. Which calls were released, denied, or
 * never seen is the runtime's own record, keyed by the provider call id it was
 * given — never a claim read out of client-supplied history, which a client
 * could write to skip a real result's enforcement.
 */
export async function processProxyResults(params: {
  session: OpenAppaSession;
  results: CommonToolResult[];
  controlToolName?: string;
  trustedChat?: boolean;
}) {
  await startSession(params.session);
  const updates: Record<string, ProcessedToolResult> = {};
  for (const result of params.results) {
    // Opening an app seeds a platform-authored render, not an executed call.
    // It has no APPA admission to settle. Only trusted Chat can prove the
    // platform origin; an external client can copy a marker into its output.
    if (params.trustedChat && isSeededAppRenderToolResult(result.content))
      continue;
    // Like existing proxy guardrails, consume the client's reported result.
    // This is protocol-level completion, not independent proof of execution.
    // Explicit tool errors remain failures; a reported cancellation is unknown.
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

/**
 * What the proxy does with one call the model proposed.
 *
 * `control` is the model's own remedy call: the client executes it against this
 * runtime, so it is released without a second OpenAPPA event — the gateway
 * dispatches the one control `ToolCall` when the client actually runs it.
 */
type AppaCallDecision =
  | { kind: "allow" }
  | { kind: "control" }
  | { kind: "deny"; feedback: string };

export async function evaluateToolCalls(
  session: OpenAppaSession,
  calls: Array<{ id: string; name: string; arguments: string | object }>,
  options: {
    canonicalize: (name: string) => string;
    /** This session's declared spelling of the control tool. */
    controlToolName?: string;
  },
): Promise<AppaCallDecision[]> {
  const ids = new Set<string>();
  // Validate the whole response before any call acquires a native dispatch.
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
  const normalized = normalizeToolCallsForPolicy(calls, options.canonicalize);
  const decisions: AppaCallDecision[] = [];
  const admitted: string[] = [];
  let settled = false;
  try {
    for (const [index, call] of calls.entries()) {
      const target = normalized[index];
      // Origin-bound: only the tool this session declared through the platform's
      // own endpoint is the control tool. A lookalike on another MCP server
      // canonicalizes to that server's name and stays an ordinary checked call.
      //
      // This is also why the call never needs a canonical respelling before it
      // reaches the runtime: the genuine control call is answered here and is
      // never dispatched as a tool_call, and respelling anything else to
      // `appa/execute_remedy_plan` would hand a lookalike the control tool's
      // identity.
      if (options.controlToolName && call.name === options.controlToolName) {
        decisions.push({ kind: "control" });
        continue;
      }
      // Reporting is the one built-in the policy names canonically.
      const tool =
        archestraMcpBranding.getToolShortName(
          options.canonicalize(target.toolCallName),
        ) === "yell"
          ? "yell"
          : target.toolCallName;
      const event = {
        event: "tool_call",
        operation_id: `call:${call.id}`,
        tool,
        // The client's own name for a direct call, so a remedy result can name
        // the tool the way the client calls it. A dispatch through run_tool
        // names its target instead, and the wrapper's name would mislead.
        ...(tool !== call.name && options.canonicalize(call.name) === tool
          ? { spelling: call.name }
          : {}),
        // Native owns client-facing ruling text. It needs the control tool as
        // declared by this client; proxy code must not respell prose later.
        presentation: nativePresentation(options.controlToolName),
        arguments: JSON.parse(target.toolCallArgs),
        // Delegation is an ordinary tool until the child-return adapter exists.
        // Its request and output still pass through the parent's policy.
        spawn: false,
      };
      const decision = await dispatch(session, event);
      if (
        decision.decision === "allow_call" ||
        decision.decision === "pass_control"
      ) {
        admitted.push(call.id);
        decisions.push({ kind: "allow" });
        continue;
      }
      // A denial is this call's own ruling, delivered as a notice; the rest of
      // the batch stands, so nothing admitted so far is withdrawn.
      decisions.push({
        kind: "deny",
        feedback: decisionMessage(decision),
      });
    }
    settled = true;
    return decisions;
  } finally {
    if (!settled) {
      // A failure withholds the whole response, so the calls the runtime already
      // admitted from it will never run. Settle exactly those; other in-flight
      // calls must remain open.
      const results = await Promise.allSettled(
        admitted.map((id) =>
          dispatch(session, { event: "cancel_call", tool_call_id: id }),
        ),
      );
      for (const [index, result] of results.entries()) {
        if (result.status === "rejected") {
          logger.warn(
            {
              err: result.reason,
              toolCallId: admitted[index],
              sessionId: session.session_id,
            },
            "Failed to cancel OpenAPPA admitted call during batch failure cleanup",
          );
        }
      }
    }
  }
}

/**
 * Withdraws calls the runtime admitted that the client will never run, because
 * the response that carried them is withheld.
 */
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
 * Executes a remedy using only the offer ID.
 * Resolves the originating session from the in-memory offer map within the organization.
 */
export async function executeRemedyByOffer(params: {
  organizationId: string;
  /** The principal the gateway authenticated, in the proxy's `user:<id>` form. */
  callerId?: string;
  /** Provider or client-supplied logical execution identity, when available. */
  toolCallId?: string;
  controlToolName?: string;
  /** Exact validated client arguments, retained for durable receipt fingerprinting. */
  originalArguments: string;
  args: unknown;
}): Promise<{
  result: CallToolResult;
  /** Authorized owner lookup, not proof that the offer remains spendable. */
  known: boolean;
}> {
  const decision = await withRuntime(params.organizationId, (module, policy) =>
    module.executeRemedyByOffer(
      JSON.stringify({
        organization_id: params.organizationId,
        ...(params.callerId ? { caller_id: params.callerId } : {}),
        execution_mode: params.toolCallId ? "tracked" : "untracked",
        ...(params.toolCallId ? { tool_call_id: params.toolCallId } : {}),
        original_arguments: params.originalArguments,
        arguments: params.args,
        presentation: nativePresentation(params.controlToolName),
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
