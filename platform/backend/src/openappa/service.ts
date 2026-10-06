import { AsyncLocalStorage } from "node:async_hooks";
import type { DispatchPolicy } from "@archestra/openappa-rs";
import {
  APPA_PARENT_HEADER,
  APPA_SESSION_HEADER,
  extractMcpToolError,
  isSeededAppRenderToolResult,
  TOOL_ASK_USER_SHORT_NAME,
  TOOL_EXECUTE_REMEDY_PLAN_SHORT_NAME,
  TOOL_LIST_PEER_MESSAGES_SHORT_NAME,
  TOOL_READ_PEER_MESSAGE_SHORT_NAME,
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
import MemberModel from "@/models/member";
import OpenAppaYellModel from "@/models/openappa-yell";
import { openappaBatteriesService } from "@/openappa/batteries";
import {
  expandCommandExecutionPolicyRules,
  normalizeCommandExecutionArguments,
} from "@/openappa/command-normalization";
import {
  controlEchoMatches,
  readControlReceipts,
} from "@/openappa/control-outcome";
import { openappaDeclarations } from "@/openappa/declarations";
import { declareExistingInstalls } from "@/openappa/declare-installs";
import { openappaFailure } from "@/openappa/failure";
import type { AppaRewriteReplay } from "@/openappa/rewrite-replay";
import { captureYellReport } from "@/openappa/yell-receiver";
import { normalizeToolCallsForPolicy } from "@/routes/proxy/llm-proxy-helpers";
import type { EncryptedChatAuditDisposition } from "@/routes/proxy/utils/encrypted-chat-session";
import type { ToolNameCanonicalizer } from "@/routes/proxy/utils/gateway-tool-names";
import {
  type GuardrailsV2Activation,
  isGuardrailsV2Active,
} from "@/services/guardrails-deployment";
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
  /** Machine-readable, never shown: why the runtime answered as it did. */
  code: z.string().optional(),
};

/** Structured remedy offers from the native runtime. */
const NativeOfferSchema = z
  .object({ offer_id: z.string().min(1) })
  .passthrough();

/** Validation schema for decisions returned by the native runtime. */
const NativeValueSchema = z
  .string()
  .refine(
    (value) => Buffer.byteLength(value, "utf8") <= 8 * 1024 * 1024,
    "Native value exceeds 8 MiB",
  );

const NativeDecisionSchema = z
  .discriminatedUnion("decision", [
    z.object({ decision: z.literal("ack"), ...ResultDecisionFields }),
    z.object({
      decision: z.literal("allow_call"),
      spawn_binding: z.string().min(1).optional(),
    }),
    z.object({ decision: z.literal("pass_control") }),
    z.object({
      decision: z.literal("replay_completed_results"),
      results: z
        .array(
          z.object({
            tool_call_id: z.string().min(1).max(1024),
            decision: z.unknown(),
          }),
        )
        .max(256),
    }),
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
      value: NativeValueSchema,
      ...ResultDecisionFields,
    }),
    z.object({
      decision: z.literal("child_return"),
      value: NativeValueSchema,
      ...ResultDecisionFields,
    }),
    z.object({
      decision: z.literal("context"),
      text: z.string().optional(),
    }),
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
  code?: string;
};
type ChildEndOutcome =
  | { decision: "release"; crossed: true }
  | {
      decision: "replace";
      content: string;
      crossed: boolean;
    };

let native: Promise<typeof import("@archestra/openappa-rs")> | undefined;
const capturedActivation = new AsyncLocalStorage<GuardrailsV2Activation>();

/** Keep one request's activation decision through later runtime calls. */
export function withCapturedGuardrailsActivation<T>(
  activation: GuardrailsV2Activation,
  run: () => Promise<T>,
): Promise<T> {
  return capturedActivation.run(activation, run);
}

/** The rest of this request phase keeps the activation captured at its start. */
export function enterCapturedGuardrailsActivation(
  activation: GuardrailsV2Activation,
): void {
  capturedActivation.enterWith(activation);
}
export function openappaYellEnabled(): boolean {
  return config.openappa.enabled && config.openappa.yellEnabled;
}

export function openappaEnabled(): boolean {
  return config.openappa.enabled;
}

/** Read the persisted label of a started session without dispatching a hook. */
export async function getOpenappaStatus(params: {
  organizationId: string;
  sessionId: string;
}) {
  if (!openappaEnabled()) return null;
  try {
    const module = await binding();
    return await module.getOpenappaStatus(
      params.organizationId,
      params.sessionId,
    );
  } catch (error) {
    throw openappaFailure(error);
  }
}

/**
 * Carry the legacy `openappa_battery_installs` rows into the policy text every
 * composition now reads from. Runs before the runtime opens and before the
 * periodic recompile is registered, because a recompose rewrites the rows from
 * the text and deletes every row the text does not declare.
 *
 * Idempotent on every boot, and a per-organization failure never stops the
 * others. A failure of the whole step does not stop the server either: the
 * installs of an organization the step did not reach are still readable in the
 * log it wrote, and the operator can run `pnpm db:openappa-declare-installs`.
 */
export async function declareOpenappaInstalls(): Promise<void> {
  if (!openappaEnabled()) return;
  try {
    const summary = await declareExistingInstalls();
    logger.info(summary, "Declared the legacy OpenAPPA battery installs");
  } catch (error) {
    logger.error(
      { err: error },
      "Declaring the legacy OpenAPPA battery installs failed; the periodic recompile will delete every install row the policy text does not declare",
    );
  }
}

export async function executeYell(params: {
  session: OpenAppaSession;
  toolCallId: string;
  args: { message: string; with_trajectory: boolean };
}): Promise<CallToolResult> {
  if (!openappaYellEnabled())
    throw new ApiError(404, "OpenAPPA reporting is disabled");
  const record = await OpenAppaYellModel.record({
    organizationId: params.session.organization_id,
    callerId: params.session.caller_id ?? "unknown",
    sessionId: params.session.session_id,
    toolCallId: params.toolCallId,
    message: params.args.message,
    withTrajectory: params.args.with_trajectory,
  });
  try {
    const result = await captureYellReport({
      id: record.id,
      organizationId: record.organizationId,
      send: async (receiver) =>
        runtimeToolResult(
          await dispatch(params.session, {
            event: "yell",
            operation_id: `yell:${params.toolCallId}`,
            arguments: params.args,
            yell_receiver: receiver,
          }),
        ),
    });
    if (config.analytics.enabled) {
      await OpenAppaYellModel.recordDelivery({
        id: record.id,
        organizationId: record.organizationId,
        failed: Boolean(result.isError),
      });
    }
    if (!result.isError) {
      return {
        ...result,
        content: [
          {
            type: "text",
            text: "Report saved. You can download it or investigate it in chat from Guardrails → Yells.",
          },
        ],
      };
    }
    return result;
  } catch (error) {
    await OpenAppaYellModel.recordDelivery({
      id: record.id,
      organizationId: record.organizationId,
      failed: true,
    });
    throw error;
  }
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

async function binding() {
  if (!openappaEnabled()) {
    throw new Error("OpenAPPA is disabled");
  }
  if (capturedActivation.getStore() === "inactive") {
    throw new Error("OpenAPPA is disabled");
  }
  // A composed document names the helper bridge bearer as a `token_env` the
  // addon resolves from this process's environment when it compiles the
  // document for a dispatch. Publish it on every crossing, not once at import
  // time, so no dispatch depends on module order.
  openappaDeclarations.publishBridgeToken();
  native ??= (async () => {
    const module = await import("@archestra/openappa-rs");
    const url = new URL(getDatabaseConnectionString());
    // pg ignores Prisma's legacy schema parameter; rust-postgres rejects it.
    url.searchParams.delete("schema");
    await module.initializeOpenappa(
      url.toString(),
      config.openappa.postgresMaxConnections,
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
  policy?: DispatchPolicy,
) {
  const principal = await sessionPrincipal(session);
  return withRuntime(
    session.organization_id,
    (module, policy) =>
      module.dispatchHook(
        JSON.stringify({ ...session, ...event, ...principal }),
        policy,
      ),
    policy,
  );
}

/**
 * The email of the user a session acts for, which the runtime reads as the
 * session's own audience. Sent on every event, since any of them may open the
 * session; an app or virtual-key caller, or a user outside the organization,
 * acts for no user.
 */
async function sessionPrincipal(
  session: OpenAppaSession,
): Promise<{ principal?: string }> {
  const userId = session.caller_id?.startsWith(USER_CALLER_PREFIX)
    ? session.caller_id.slice(USER_CALLER_PREFIX.length)
    : undefined;
  if (!userId) return {};
  const member = await MemberModel.findByIdOrEmail(
    userId,
    session.organization_id,
  );
  return member ? { principal: member.email } : {};
}

const USER_CALLER_PREFIX = "user:";

/** Executes a callback with the loaded native runtime and organization policy. */
async function withRuntime(
  organizationId: string,
  call: (
    module: Awaited<ReturnType<typeof binding>>,
    policy: DispatchPolicy,
  ) => Promise<string>,
  batchPolicy?: DispatchPolicy,
) {
  const policy = batchPolicy ?? (await effectivePolicy(organizationId));
  try {
    const module = await binding();
    const rawResult = await call(module, policy);
    return NativeDecisionSchema.parse(JSON.parse(rawResult));
  } catch (error) {
    throw openappaFailure(error);
  }
}

/**
 * The organization's effective policy with the credential values the runtime
 * reads for it, or the refusal every dispatch shares.
 *
 * The deployment switch is not read here. Each entry point reads it once at its
 * request boundary, so a turn that began governed finishes under its policy even
 * when the switch turns off mid-request.
 */
async function effectivePolicy(
  organizationId: string,
): Promise<DispatchPolicy> {
  try {
    const rawContent = (
      await openappaBatteriesService.getEffectivePolicy(organizationId)
    ).content;
    return await openappaDeclarations.dispatchPolicy({
      organizationId,
      content: expandCommandExecutionPolicyRules(rawContent),
    });
  } catch (error) {
    throw openappaFailure(error);
  }
}

/** One policy read shared by a batch of dispatches, taken by the first of them. */
type SharedPolicy = () => Promise<DispatchPolicy>;

export function sharedPolicy(organizationId: string): SharedPolicy {
  let read: Promise<DispatchPolicy> | undefined;
  return () => {
    read ??= effectivePolicy(organizationId);
    return read;
  };
}

export function chatOpenAppaSession(
  organizationId: string,
  userId: string,
  sessionId: string,
): OpenAppaSession {
  return {
    organization_id: organizationId,
    caller_id: `${USER_CALLER_PREFIX}${userId}`,
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

async function startSession(params: {
  session: OpenAppaSession;
  policy?: DispatchPolicy;
  deliverReturnContract?: (text: string) => void;
}): Promise<void> {
  const decision = await dispatch(
    params.session,
    { event: "session_start" },
    params.policy,
  );
  if (decision.decision === "context") {
    if (decision.text && params.deliverReturnContract) {
      validateReturnContract(decision.text);
      params.deliverReturnContract(decision.text);
      return;
    }
    throw new ApiError(
      409,
      "This session requires an OpenAPPA return contract the proxy cannot deliver before inference",
    );
  }
  if (decision.decision !== "ack")
    throw new ApiError(409, decisionMessage(decision));
}

/** Binds the prepared fork before a runtime receives any prompt or file. */
export async function startRuntimeChild(params: {
  session: OpenAppaSession;
  spawnCallId?: string;
}): Promise<{ contract?: string }> {
  if (!params.session.parent_id) {
    throw new ApiError(409, "A protected runtime requires its bound parent");
  }
  const decision = await dispatch(params.session, {
    event: "session_start",
    ...(params.spawnCallId ? { spawn_call_id: params.spawnCallId } : {}),
  });
  if (decision.decision === "ack") return {};
  if (decision.decision === "context" && decision.text) {
    validateReturnContract(decision.text);
    return { contract: decision.text };
  }
  throw new ApiError(409, decisionMessage(decision));
}

/** Refreshes a registered child's inherited label before new bytes arrive. */
export async function addressRuntimeChild(params: {
  session: OpenAppaSession;
  childSessionId: string;
  operationId: string;
}): Promise<void> {
  const decision = await dispatch(params.session, {
    event: "child_address",
    operation_id: params.operationId,
    spawned_id: params.childSessionId,
    output: "",
  });
  if (decision.decision !== "ack") {
    throw new ApiError(409, decisionMessage(decision));
  }
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
  policy?: DispatchPolicy;
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
    params.policy,
  );
  return processedToolResult(decision, params.output);
}

function processedToolResult(
  decision: NativeDecision,
  fallbackOutput: string,
): ProcessedToolResult {
  const content = extractApprovedOutput(decision, fallbackOutput);
  const outputSource =
    ("output_source" in decision ? decision.output_source : undefined) ??
    ("reason" in decision && decision.reason ? "runtime" : "tool");
  const reason =
    "reason" in decision && decision.reason ? decision.reason : undefined;
  const code = "code" in decision && decision.code ? decision.code : undefined;
  return {
    content,
    outputSource,
    ...(reason ? { reason } : {}),
    ...(code ? { code } : {}),
  };
}

/**
 * A remedy call whose remedy never ran: the client declined it (a permission
 * prompt the user rejected, an auto-mode classifier block), or the gateway
 * refused it before the remedy (no live offer). Only a remedy that runs leaves
 * a record, so the runtime would withhold this result, and the model would
 * lose what it says, such as the client's instruction to stop and let the
 * user decide. A client or the gateway wrote it, not a tool, so it goes
 * through after a line that says the plan is not applied.
 *
 * The closing line says how to ask when the user must decide. Claude Code's
 * auto-mode classifier accepts the plan only after the user, shown what was
 * blocked, approves it: a question that quotes the ruling gives the user
 * that, where a bare "approve" typed in chat did not.
 */
function unexecutedControlResult(content: unknown): ProcessedToolResult {
  const text = toolResultText(content);
  return {
    content: `[appa] The remedy did not run, so the plan is not applied. The result the client returned:\n\n${truncated(text, MAX_UNEXECUTED_RESULT_CHARS)}\n\n${UNEXECUTED_REMEDY_QUESTION_HINT}`,
    outputSource: "runtime",
  };
}

const UNEXECUTED_REMEDY_QUESTION_HINT =
  "[appa] If the user must decide, ask with a question tool, not in plain text: the client's own question tool if it has one, otherwise ask_user. Quote the ruling's reason and the plan in the ruling's own words, and offer Approve and Deny.";

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (content === null || content === undefined) return "";
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && "text" in part) {
          const text = (part as { text: unknown }).text;
          return typeof text === "string" ? text : JSON.stringify(text);
        }
        return "";
      })
      .filter((text) => text.length > 0)
      .join("\n");
  }
  return JSON.stringify(content);
}

/** Cuts at `limit` code units, never between the halves of a surrogate pair. */
function truncated(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const code = text.charCodeAt(limit - 1);
  const end = code >= 0xd800 && code <= 0xdbff ? limit - 1 : limit;
  return `${text.slice(0, end)}…`;
}

/** The runtime's code for a result that matches no released call. */
const UNRELEASED_CALL_CODE = "unreleased_call";
const UNRELEASED_CALL_TEXT =
  "[appa] Tool output withheld: this result has no record of releasing a call.";
const MAX_UNEXECUTED_RESULT_CHARS = 4000;
const MAX_COMPLETED_RESULT_BATCH = 256;

async function replayCompletedResults(params: {
  session: OpenAppaSession;
  toolCallIds: string[];
  policy: DispatchPolicy;
}): Promise<Map<string, NativeDecision>> {
  try {
    const replay = await dispatch(
      params.session,
      { event: "replay_completed_results", tool_call_ids: params.toolCallIds },
      params.policy,
    );
    if (replay.decision !== "replay_completed_results") {
      throw new Error("OpenAPPA returned an unexpected replay response");
    }
    const completed = new Map<string, NativeDecision>();
    let position = 0;
    for (const result of replay.results) {
      // A sparse batch must still be an ordered subset of this exact request.
      while (params.toolCallIds[position] !== result.tool_call_id) {
        if (position >= params.toolCallIds.length) {
          throw new Error("OpenAPPA returned an unrelated replay receipt");
        }
        position++;
      }
      position++;
      const decision = NativeDecisionSchema.parse(result.decision);
      if (
        !isOutputDecision(decision) ||
        decision.approved_output === undefined
      ) {
        throw new Error("OpenAPPA replay receipt lacks retained output");
      }
      completed.set(result.tool_call_id, decision);
    }
    return completed;
  } catch (error) {
    throw openappaFailure(error);
  }
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
  /**
   * Whether a result answers this request's own remedy call, and is not a
   * pending review. Without a retained execution result, the echo cannot
   * prove that its remedy ran.
   */
  isControlResult?: (result: CommonToolResult) => boolean;
  trustedChat?: boolean;
  /** The proxy must inject this host-authored contract before its provider call. */
  deliverReturnContract?: (text: string) => void;
  /** How a client-side spawn launch ended. */
  classifySpawnResult?: (
    result: CommonToolResult,
  ) => "pending" | "failed" | undefined;
  /** Already-opened rewrite facade for this request, when the proxy has one. */
  replay?: AppaRewriteReplay;
  /** Verified request key for reads before the main replay facade is opened. */
  encryptedChat?: EncryptedChatAuditDisposition;
}) {
  // The results dispatch one after another; one policy read serves them all.
  const policy = await effectivePolicy(params.session.organization_id);
  await startSession({
    session: params.session,
    policy,
    deliverReturnContract: params.deliverReturnContract,
  });
  const receipts = await readControlReceipts({
    session: params.session,
    toolCallIds: params.results.map((result) => result.id),
    ...(params.replay ? { replay: params.replay } : {}),
    encryptedChat: params.encryptedChat,
  });
  const updates: Record<string, ProcessedToolResult> = {};
  let completed = new Map<string, NativeDecision>();
  // Candidate IDs survive invalidation only as hints, never as release authority.
  let completedCandidates = new Set<string>();
  let batchEnd = 0;
  for (const [index, result] of params.results.entries()) {
    if (params.trustedChat && isSeededAppRenderToolResult(result.content))
      continue;
    // The runtime released no question call, so it would withhold the answer.
    if (params.isUserQuestion?.(result) === true) continue;
    const spawn = params.classifySpawnResult?.(result);
    if (spawn === "pending") continue;
    // A gateway-produced control result has no native release record. The
    // echo is shown only when it matches the stored bytes for this call.
    // A pending match is not a grant, and a forged echo is not dispatched.
    const receipt = receipts.get(result.id);
    if (receipt) {
      completed.clear();
      const echoed = toolResultText(result.content);
      if (controlEchoMatches(receipt.bytes, echoed) === "match") {
        updates[result.id] = {
          content: receipt.bytes,
          outputSource: "runtime",
          code: "control_outcome",
        };
        continue;
      }
      updates[result.id] = {
        content: UNRELEASED_CALL_TEXT,
        outputSource: "runtime",
        code: UNRELEASED_CALL_CODE,
      };
      continue;
    }
    if (
      index >= batchEnd ||
      (completedCandidates.has(result.id) && !completed.has(result.id))
    ) {
      if (index >= batchEnd) {
        batchEnd = Math.min(
          index + MAX_COMPLETED_RESULT_BATCH,
          params.results.length,
        );
      }
      completed = await replayCompletedResults({
        session: params.session,
        toolCallIds: params.results.slice(index, batchEnd).map(({ id }) => id),
        policy,
      });
      completedCandidates = new Set(completed.keys());
    }
    const retained = completed.get(result.id);
    if (retained) {
      const approved = processedToolResult(retained, "");
      const unexecutedControl =
        approved.code === UNRELEASED_CALL_CODE &&
        params.isControlResult?.(result) === true;
      updates[result.id] = unexecutedControl
        ? unexecutedControlResult(result.content)
        : approved;
      if (unexecutedControl) completed.clear();
      continue;
    }
    const error =
      extractMcpToolError(result) ?? extractMcpToolError(result.content);
    const outcome: ExecutionOutcome =
      error?.type === "cancelled"
        ? "unknown"
        : spawn === "failed" || result.isError
          ? "failure"
          : "success";
    // Keep window/miss knowledge, but discard every decision before awaited work.
    // The ordinary dispatch already performs its own fresh native guards.
    completed.clear();
    const approved = await approveToolResult({
      session: params.session,
      toolCallId: result.id,
      output:
        typeof result.content === "string"
          ? result.content
          : JSON.stringify(result.content),
      outcome,
      controlToolName: params.controlToolName,
      policy,
    });
    updates[result.id] =
      approved.code === UNRELEASED_CALL_CODE &&
      params.isControlResult?.(result) === true
        ? unexecutedControlResult(result.content)
        : approved;
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
    isUserQuestion?: (name: string, namespace?: string) => boolean;
    /** Compat only: recognize a `run_tool` wrapper behind any client label. */
    looseRunToolDispatch?: boolean;
    /** This session's control tool declaration, as the client spells it. */
    control?: DeclaredToolSpelling;
    /** This session's notice tool declaration, as the client spells it. */
    notice?: DeclaredToolSpelling;
    /** True for a call that names a child trajectory (Task, spawn_agent, task). */
    isSpawn?: (name: string, namespace?: string) => boolean;
    /** Runtime launches are resolved per call, including run_tool targets. */
    spawnCallIds?: ReadonlySet<string>;
    /** Whether this client can carry child-return declarations. */
    supportsDelegation?: boolean;
    /** Signed lineage retained with a child call for later turns. */
    lineage?: { spawnCallId?: string; childNativeId?: string };
  },
  policy: SharedPolicy = sharedPolicy(session.organization_id),
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
        options.notice &&
        call.name === options.notice.name &&
        call.namespace === options.notice.namespace
      ) {
        return { kind: "allow" as const };
      }
      const shortName = archestraMcpBranding.getToolShortName(
        target.toolCallName,
      );
      if (
        options.isUserQuestion?.(call.name, call.namespace) ??
        (call.namespace === undefined &&
          isPlatformUserQuestion(call.name, options.canonicalize))
      ) {
        return { kind: "allow" as const };
      }
      // The target is already canonical, so it is read, not re-canonicalized.
      const tool = shortName === "yell" ? "yell" : target.toolCallName;
      const spawn =
        options.spawnCallIds?.has(call.id) === true ||
        options.isSpawn?.(call.name, call.namespace) === true;
      const spelling = spawnRetrySpelling({
        call,
        tool,
        spawn,
        canonicalize: options.canonicalize,
      });
      const event = {
        event: "tool_call",
        operation_id: `call:${call.id}`,
        tool,
        ...(spelling ? { spelling } : {}),
        presentation: nativePresentation(
          options.control?.name,
          options.supportsDelegation,
        ),
        arguments: normalizeCommandExecutionArguments(
          tool,
          JSON.parse(target.toolCallArgs),
        ),
        spawn,
        ...(options.lineage?.spawnCallId
          ? { spawn_call_id: options.lineage.spawnCallId }
          : {}),
        ...(options.lineage?.childNativeId
          ? { child_native_id: options.lineage.childNativeId }
          : {}),
      };
      const decision = await dispatch(session, event, await policy());
      if (
        spawn &&
        (decision.decision === "pass_control" ||
          (decision.decision === "allow_call" && !decision.spawn_binding))
      ) {
        if (decision.decision === "allow_call")
          await dispatch(
            session,
            { event: "cancel_call", tool_call_id: call.id },
            await policy(),
          );
        return {
          kind: "deny" as const,
          feedback:
            "OpenAPPA did not prepare a child fork. Enable policy.deployment.context_control and approve a child return contract before spawning a subagent.",
        };
      }
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
        admitted.map(async (id) =>
          dispatch(
            session,
            { event: "cancel_call", tool_call_id: id },
            await policy(),
          ),
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
  const policy = sharedPolicy(session.organization_id);
  const decisions = await evaluateToolCalls(
    session,
    [...calls],
    options,
    policy,
  );
  if (decisions.some((decision) => decision.kind === "deny")) {
    await cancelCalls(
      session,
      calls.flatMap((call, index) =>
        decisions[index].kind === "allow" ? [call.id] : [],
      ),
      policy,
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
      policy: await policy(),
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
  policy: SharedPolicy = sharedPolicy(session.organization_id),
): Promise<void> {
  const results = await Promise.allSettled(
    ids.map(async (id) =>
      dispatch(
        session,
        { event: "cancel_call", tool_call_id: id },
        await policy(),
      ),
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
  lineage?: { spawnCallId?: string; childNativeId?: string },
): Promise<void> {
  await dispatch(session, {
    event: "prompt",
    operation_id: operationId,
    ...(lineage?.spawnCallId ? { spawn_call_id: lineage.spawnCallId } : {}),
    ...(lineage?.childNativeId
      ? { child_native_id: lineage.childNativeId }
      : {}),
  });
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

/**
 * Controls the return boundary where child trajectory output enters the parent session.
 * The runtime stages a ChildReturn until the harness echoes approved bytes through ChildEnd.
 * An Ack on the echo confirms the bytes crossed the trust boundary.
 * The spawn correlation rides the dispatch so the retained operation is the
 * durable authority the parent later verifies the returned bytes against.
 */
export async function endChild(params: {
  session: OpenAppaSession;
  operationId: string;
  output: string;
  spawnCallId?: string;
  childNativeId?: string;
}): Promise<ChildEndOutcome> {
  return crossChildValue({ ...params, event: "child_end" });
}

/** Cross a value without ending the runtime or settling its pending calls. */
export async function returnRuntimeValue(params: {
  session: OpenAppaSession;
  operationId: string;
  value: string;
}): Promise<
  { kind: "admitted"; value: string } | { kind: "held"; reason: string }
> {
  const outcome = await crossChildValue({
    session: params.session,
    operationId: params.operationId,
    output: params.value,
    event: "child_return",
  });
  if (outcome.decision === "release") {
    return { kind: "admitted", value: params.value };
  }
  return outcome.crossed
    ? { kind: "admitted", value: outcome.content }
    : { kind: "held", reason: outcome.content };
}

/** Verifies that a parent carrier contains bytes admitted through ChildEnd. */
export async function approveSpawnReturn(params: {
  session: OpenAppaSession;
  toolCallId: string;
  childId: string;
  value: string;
}): Promise<void> {
  const decision = await dispatch(params.session, {
    event: "tool_result",
    tool_call_id: params.toolCallId,
    spawned_id: params.childId,
    output: params.value,
    outcome: "success",
  });
  if (decision.decision === "block") {
    const msg = decisionMessage(decision);
    if (msg.includes("no open dispatch")) {
      logger.info(
        { toolCallId: params.toolCallId, childId: params.childId },
        "OpenAPPA spawn dispatch already closed; child return matches the retained crossing",
      );
      return;
    }
    throw new ApiError(409, msg);
  }
  if (decision.decision === "refuse") {
    throw openappaFailure(new Error("OpenAPPA refused the child spawn result"));
  }
  if (
    decision.decision !== "ack" &&
    decision.decision !== "replace_output" &&
    decision.decision !== "deliver_value" &&
    decision.decision !== "child_return"
  ) {
    throw openappaFailure(
      new Error(`Unexpected SpawnResult decision: ${decision.decision}`),
    );
  }
  const approved = extractApprovedOutput(decision, params.value);
  if (approved !== params.value) {
    throw openappaFailure(
      new Error("OpenAPPA changed an already crossed child return"),
    );
  }
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
  /** The authenticated user or exact workspace principal, not the signed owner. */
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

export type AppaChildReturnRecord = {
  /** Fully scoped session id of the child whose return crossed. */
  childSessionId: string;
  /** Host operation identity, including a runtime task when applicable. */
  operationId?: string;
  /** The spawn call the return answers, when the child named it at ChildEnd. */
  spawnCallId?: string;
  /** The client-native child identity, when the child named one. */
  childNativeId?: string;
  /** The exact bytes the runtime admitted across the child boundary. */
  value: string;
};

/**
 * Loads the child returns a parent's family durably crossed, from the retained
 * ChildEnd operations in PostgreSQL. This is the authority the parent side
 * verifies arriving completions against.
 *
 * The deployment switch is not read here. The request that verifies the
 * returns read it at its boundary; a switch turned off mid-request must not
 * empty the records and refuse returns the runtime did retain.
 */
export async function loadChildReturns(params: {
  organizationId: string;
  parentSessionId: string;
  childSessionId?: string;
  operationPrefix?: string;
}): Promise<AppaChildReturnRecord[]> {
  try {
    const module = await binding();
    const lookup =
      params.childSessionId !== undefined ||
      params.operationPrefix !== undefined
        ? {
            childSessionId: params.childSessionId,
            operationPrefix: params.operationPrefix,
          }
        : undefined;
    const records = lookup
      ? await module.loadChildReturns(
          params.organizationId,
          params.parentSessionId,
          lookup,
        )
      : await module.loadChildReturns(
          params.organizationId,
          params.parentSessionId,
        );
    return records.map((record) => ({
      childSessionId: record.childSessionId,
      ...(record.operationId ? { operationId: record.operationId } : {}),
      ...(record.spawnCallId ? { spawnCallId: record.spawnCallId } : {}),
      ...(record.childNativeId ? { childNativeId: record.childNativeId } : {}),
      value: record.value,
    }));
  } catch (error) {
    logger.warn(
      { err: error, parentSessionId: params.parentSessionId },
      "Failed to load OpenAPPA child returns",
    );
    throw openappaFailure(error);
  }
}

/**
 * Loads the messages a child's parent addressed to it, from the retained
 * ChildAddress operations in PostgreSQL. This is the authority the child side
 * verifies arriving messages against.
 *
 * The deployment switch is not read here, for the reason `loadChildReturns`
 * gives.
 */
export async function loadChildAddresses(params: {
  organizationId: string;
  childSessionId: string;
}): Promise<Array<{ parentSessionId: string; value: string }>> {
  try {
    const module = await binding();
    return await module.loadChildAddresses(
      params.organizationId,
      params.childSessionId,
    );
  } catch (error) {
    logger.warn(
      { err: error, childSessionId: params.childSessionId },
      "Failed to load OpenAPPA child addresses",
    );
    throw openappaFailure(error);
  }
}

/**
 * Sends one peer message. The runtime mints the id and captures the sender
 * label. `released` means the send was stored, not that the recipient may
 * read the body.
 */
export async function sendPeerMessage(params: {
  session: OpenAppaSession;
  operationId: string;
  recipientSessionId: string;
  recipientParentId?: string;
  recipientNativeId?: string;
  recipientSpawnCallId?: string;
  value: string;
}): Promise<
  { kind: "released"; messageId: string } | { kind: "denied"; feedback: string }
> {
  const parsed = await peerResponse(
    params.session,
    (module, policy) =>
      module.sendPeerMessage(
        JSON.stringify({
          ...peerActor(params.session),
          operation_id: params.operationId,
          recipient_session_id: params.recipientSessionId,
          ...(params.recipientParentId
            ? { recipient_parent_id: params.recipientParentId }
            : {}),
          ...(params.recipientNativeId
            ? { recipient_native_id: params.recipientNativeId }
            : {}),
          ...(params.recipientSpawnCallId
            ? { recipient_spawn_call_id: params.recipientSpawnCallId }
            : {}),
          value: params.value,
        }),
        policy,
      ),
    z.discriminatedUnion("kind", [
      z
        .object({ kind: z.literal("released"), message_id: z.string().min(1) })
        .strict(),
      z
        .object({ kind: z.literal("denied"), feedback: z.string().min(1) })
        .strict(),
    ]),
  );
  return parsed.kind === "released"
    ? { kind: "released", messageId: parsed.message_id }
    : { kind: "denied", feedback: parsed.feedback };
}

/**
 * Checks one arrival against the authenticated recipient. A direct body is the
 * runtime's retained bytes after a live label recheck. Missing or ambiguous
 * identity is unverified, never the earliest digest match.
 */
export async function admitPeerMessage(params: {
  session: OpenAppaSession;
  messageId?: string;
  senderSessionId?: string;
  value?: string;
  digest?: string;
  structured?: boolean;
}): Promise<
  | { kind: "admitted"; messageId: string; value: string }
  | { kind: "held"; notices: PeerNotice[] }
  | { kind: "unverified" }
> {
  const parsed = await peerResponse(
    params.session,
    (module, policy) =>
      module.admitPeerMessage(
        JSON.stringify({
          ...peerActor(params.session),
          ...(params.messageId ? { message_id: params.messageId } : {}),
          ...(params.senderSessionId
            ? { sender_session_id: params.senderSessionId }
            : {}),
          ...(params.value !== undefined ? { value: params.value } : {}),
          ...(params.digest ? { digest: params.digest } : {}),
          ...(params.structured !== undefined
            ? { structured: params.structured }
            : {}),
        }),
        policy,
      ),
    z.discriminatedUnion("kind", [
      z
        .object({
          kind: z.literal("admitted"),
          message_id: z.string().min(1),
          value: z.string().min(1),
        })
        .strict(),
      z
        .object({
          kind: z.literal("held"),
          notices: z.array(PeerNoticeWireSchema),
        })
        .strict(),
      z.object({ kind: z.literal("unverified") }).strict(),
    ]),
  );
  if (parsed.kind === "admitted") {
    return {
      kind: "admitted",
      messageId: parsed.message_id,
      value: parsed.value,
    };
  }
  if (parsed.kind === "held") {
    return { kind: "held", notices: parsed.notices.map(peerNotice) };
  }
  return { kind: "unverified" };
}

/**
 * Lists held notices for the authenticated session. Digest and session ids are
 * binding material for the caller; a model-facing surface must not print them.
 * `toolCallId`, when the gateway has one, retains that call's metadata so a
 * later client tool result cannot replace it.
 */
export async function listPeerMessages(params: {
  session: OpenAppaSession;
  toolCallId?: string;
}): Promise<PeerNotice[]> {
  const parsed = await peerResponse(
    params.session,
    (module, policy) =>
      module.listPeerMessages(
        JSON.stringify({
          ...peerActor(params.session),
          ...(params.toolCallId ? { tool_call_id: params.toolCallId } : {}),
          tool: archestraMcpBranding.getToolName(
            TOOL_LIST_PEER_MESSAGES_SHORT_NAME,
          ),
        }),
        policy,
      ),
    z.object({ notices: z.array(PeerNoticeWireSchema) }),
  );
  return parsed.notices.map(peerNotice);
}

/**
 * Reads one message through the runtime's stored label. The returned tool
 * result is the retained native result for this tool call.
 */
export async function readPeerMessage(params: {
  session: OpenAppaSession;
  toolCallId: string;
  args: { message_id: string };
}): Promise<CallToolResult> {
  const decision = await withRuntime(
    params.session.organization_id,
    (module, policy) =>
      module.readPeerMessage(
        JSON.stringify({
          ...peerActor(params.session),
          tool_call_id: params.toolCallId,
          message_id: params.args.message_id,
          tool: archestraMcpBranding.getToolName(
            TOOL_READ_PEER_MESSAGE_SHORT_NAME,
          ),
        }),
        policy,
      ),
  );
  if (decision.decision === "mcp_result" && decision.result) {
    return decision.result;
  }
  if (decision.decision === "ack") {
    throw openappaFailure(
      new Error("OpenAPPA acknowledged a peer read without a body"),
    );
  }
  if (decision.decision === "deny_call") {
    return {
      isError: true,
      content: [{ type: "text", text: decision.feedback }],
      structuredContent: {
        decision: "deny_call",
        peer_read_denied: true,
        offers: decision.offers ?? [],
        review: decision.review ?? [],
      },
    };
  }
  return {
    isError: true,
    content: [{ type: "text", text: decisionMessage(decision) }],
  };
}

/**
 * Loads the review entry for an offer from the retained DenyCall in PostgreSQL.
 * Session routing comes from the verified offer claims.
 */
function verifiedOfferRestrictions(
  value:
    | Array<{ dimension: string; before: string; after: string }>
    | undefined,
):
  | {
      restrictions: Array<{ dimension: string; before: string; after: string }>;
    }
  | undefined {
  if (!value || value.length === 0) return undefined;
  const verified = value.filter(
    (item) =>
      !!item &&
      (item.dimension === "trust" || item.dimension === "readers") &&
      typeof item.before === "string" &&
      item.before.length > 0 &&
      typeof item.after === "string" &&
      item.after.length > 0,
  );
  if (verified.length !== value.length) {
    throw new Error("OpenAPPA offer review contains invalid restrictions");
  }
  return { restrictions: verified };
}

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
  /** Narrowing recorded on the retained offer. Absent is not a grant. */
  restrictions?: Array<{ dimension: string; before: string; after: string }>;
} | null> {
  try {
    if (
      capturedActivation.getStore() !== "active" &&
      !(await isGuardrailsV2Active())
    )
      return null;
    const module = await binding();
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
      ...verifiedOfferRestrictions(result.restrictions),
    };
  } catch (error) {
    logger.warn(
      { err: error, offerId: params.offerId },
      "Failed to load OpenAPPA offer review",
    );
    throw openappaFailure(error);
  }
}

function validateReturnContract(text: string): void {
  if (Buffer.byteLength(text, "utf8") > 64 * 1024) {
    throw new ApiError(
      413,
      "The OpenAPPA child return contract exceeds 64 KiB",
    );
  }
}

async function crossChildValue(params: {
  session: OpenAppaSession;
  operationId: string;
  output: string;
  event: "child_end" | "child_return";
  spawnCallId?: string;
  childNativeId?: string;
}): Promise<ChildEndOutcome> {
  if (!params.session.parent_id) {
    throw new ApiError(409, "OpenAPPA cannot end a non-child trajectory");
  }
  if (Buffer.byteLength(params.output, "utf8") > 8 * 1024 * 1024) {
    return {
      decision: "replace",
      crossed: false,
      content:
        "The child value exceeds the supported size. No original bytes were returned.",
    };
  }
  const policy = sharedPolicy(params.session.organization_id);
  const correlation = {
    ...(params.spawnCallId ? { spawn_call_id: params.spawnCallId } : {}),
    ...(params.childNativeId ? { child_native_id: params.childNativeId } : {}),
  };
  const decision = await dispatch(
    params.session,
    {
      event: params.event,
      operation_id: params.operationId,
      ...(params.event === "child_return" || params.output.length > 0
        ? { output: params.output }
        : {}),
      ...correlation,
    },
    await policy(),
  );
  if (decision.decision === "ack") {
    return { decision: "release", crossed: true };
  }
  if (decision.decision === "block") {
    return {
      decision: "replace",
      content: decisionMessage(decision),
      crossed: false,
    };
  }
  if (decision.decision === "refuse") {
    throw openappaFailure(new Error("OpenAPPA refused the child return"));
  }
  if (decision.decision !== "child_return") {
    throw openappaFailure(
      new Error(`Unexpected child return decision: ${decision.decision}`),
    );
  }
  const echo = await dispatch(
    params.session,
    {
      event: params.event,
      operation_id: `${params.operationId}:echo`,
      // Echo exact canonical bytes, including an explicitly empty value.
      output: decision.value,
      ...correlation,
    },
    await policy(),
  );
  if (echo.decision !== "ack") {
    throw openappaFailure(
      new Error(
        `OpenAPPA did not admit the canonical child return: ${echo.decision}`,
      ),
    );
  }
  return { decision: "replace", content: decision.value, crossed: true };
}

/**
 * The name the authorized retry instruction should use. A direct dispatch
 * keeps the client's spelling. A native spawn also names its namespace:
 * Codex routes `collaboration.spawn_agent` on that field, and an instruction
 * that says only `spawn_agent` is not a call the client can replay.
 */
function spawnRetrySpelling(params: {
  call: { name: string; namespace?: string };
  tool: string;
  spawn: boolean;
  canonicalize: (name: string, namespace?: string) => string;
}): string | undefined {
  if (
    params.tool !== params.call.name &&
    params.canonicalize(params.call.name, params.call.namespace) === params.tool
  ) {
    return params.call.name;
  }
  if (
    !params.spawn ||
    !params.call.namespace ||
    params.call.namespace === "functions"
  ) {
    return undefined;
  }
  const prefix = `${params.call.namespace}.`;
  return params.call.name.startsWith(prefix)
    ? params.call.name
    : `${prefix}${params.call.name}`;
}

function nativePresentation(
  controlToolName?: string,
  supportsDelegation = false,
): {
  control_tool: string;
  supports_delegation: boolean;
} {
  return {
    control_tool:
      controlToolName ??
      archestraMcpBranding.getToolName(TOOL_EXECUTE_REMEDY_PLAN_SHORT_NAME),
    supports_delegation: supportsDelegation,
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

type PeerNotice = {
  messageId: string;
  senderSessionId: string;
  recipientSessionId: string;
  /** SHA-256 of the body, 64 lowercase hex. Internal binding material. */
  digest: string;
  expiresAt: string;
};

const PeerNoticeWireSchema = z
  .object({
    message_id: z.string().min(1),
    sender_session_id: z.string().min(1),
    recipient_session_id: z.string().min(1),
    digest: z.string().regex(/^[0-9a-f]{64}$/),
    expires_at: z.string().min(1),
  })
  .strict();

function peerNotice(value: z.infer<typeof PeerNoticeWireSchema>): PeerNotice {
  return {
    messageId: value.message_id,
    senderSessionId: value.sender_session_id,
    recipientSessionId: value.recipient_session_id,
    digest: value.digest,
    expiresAt: value.expires_at,
  };
}

function peerActor(session: OpenAppaSession) {
  return {
    organization_id: session.organization_id,
    session_id: session.session_id,
    ...(session.caller_id ? { caller_id: session.caller_id } : {}),
    ...(session.parent_id ? { parent_id: session.parent_id } : {}),
  };
}

async function peerResponse<T>(
  session: OpenAppaSession,
  call: (
    module: Awaited<ReturnType<typeof binding>>,
    policy: DispatchPolicy,
  ) => Promise<string>,
  schema: z.ZodType<T>,
): Promise<T> {
  try {
    return schema.parse(await peerJson(session, call));
  } catch (error) {
    throw openappaFailure(error);
  }
}

async function peerJson(
  session: OpenAppaSession,
  call: (
    module: Awaited<ReturnType<typeof binding>>,
    policy: DispatchPolicy,
  ) => Promise<string>,
): Promise<unknown> {
  try {
    const policy = await effectivePolicy(session.organization_id);
    const module = await binding();
    return JSON.parse(await call(module, policy));
  } catch (error) {
    throw openappaFailure(error);
  }
}
