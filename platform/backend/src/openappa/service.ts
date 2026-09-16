import {
  extractMcpToolError,
  isAgentTool,
  isSkillTool,
} from "@archestra/shared";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { archestraMcpBranding } from "@/archestra-mcp-server/branding";
import config from "@/config";
import { getDatabaseConnectionString } from "@/database";
import type { PolicyBlockResult } from "@/guardrails/tool-invocation";
import { normalizeToolCallsForPolicy } from "@/routes/proxy/llm-proxy-helpers";
import { isGuardrailsV2Active } from "@/services/guardrails-deployment";
import { guardrailsPolicyService } from "@/services/guardrails-policy";
import { ApiError, type CommonToolResult } from "@/types";

import { isChatBlockResult } from "./chat-block";

export const APPA_SESSION_HEADER = "X-Appa-Session-ID";
export const APPA_PARENT_HEADER = "X-Appa-Parent-ID";
export const APPA_CHAT_SOURCES = [
  "chat",
  "chat:tool_call_repair",
  "chat:compaction",
] as const;
export type AppaChatSource = (typeof APPA_CHAT_SOURCES)[number];
type ExecutionOutcome = "success" | "failure" | "unknown";
export type OpenAppaSession = {
  organization_id: string;
  caller_id?: string;
  session_id: string;
  parent_id?: string;
};

const Decision = z.object({
  decision: z.enum([
    "ack",
    "allow_call",
    "pass_control",
    "deny_call",
    "block",
    "replace_output",
    "deliver_value",
    "child_return",
    "context",
    "refuse",
    "mcp_result",
  ]),
  feedback: z.string().optional(),
  reason: z.string().optional(),
  detail: z.string().optional(),
  text: z.string().optional(),
  approved_output: z.string().optional(),
  result: z.unknown().optional(),
  offers: z.array(z.object({ offer_id: z.string() })).optional(),
});

let native: Promise<typeof import("@archestra/openappa-rs")> | undefined;
export function openappaEnabled(): boolean {
  return config.openappa.enabled;
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
    await module.initializeOpenappa(url.toString(), content);
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
  try {
    if (!(await isGuardrailsV2Active()))
      throw new Error("Guardrails v2 is disabled");
    const policy = await guardrailsPolicyService.get(session.organization_id);
    const module = await binding(policy.content);
    return Decision.parse(
      JSON.parse(
        await module.dispatchHook(
          JSON.stringify({ ...session, ...event }),
          policy.content,
        ),
      ),
    );
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

export function sessionFromHeaders(params: {
  headers: Record<string, unknown>;
  organizationId: string;
  callerId?: string;
}): OpenAppaSession | undefined {
  if (!openappaEnabled()) return undefined;
  const sessionId = params.headers[APPA_SESSION_HEADER.toLowerCase()];
  const parentId = params.headers[APPA_PARENT_HEADER.toLowerCase()];
  const valid = (value: unknown): value is string =>
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 512 &&
    !/\p{Cc}/u.test(value);
  if (!valid(sessionId) || (parentId !== undefined && !valid(parentId)))
    throw new ApiError(
      400,
      "OpenAPPA requires valid X-Appa-Session-ID and optional X-Appa-Parent-ID headers",
    );
  return {
    organization_id: params.organizationId,
    ...(params.callerId ? { caller_id: params.callerId } : {}),
    session_id: sessionId,
    ...(parentId ? { parent_id: parentId as string } : {}),
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
    throw new ApiError(409, decision.detail ?? "OpenAPPA session refused");
}

async function approveToolResult(
  session: OpenAppaSession,
  toolCallId: string,
  output: string,
  outcome: ExecutionOutcome,
) {
  const decision = await dispatch(session, {
    event: "tool_result",
    tool_call_id: toolCallId,
    output,
    outcome,
  });
  if (decision.approved_output === undefined)
    throw new ApiError(503, "OpenAPPA returned no approved tool output");
  return decision.approved_output;
}

export async function processProxyResults(
  session: OpenAppaSession,
  results: CommonToolResult[],
) {
  await startSession(session);
  const updates: Record<string, string> = {};
  for (const result of results) {
    // A signed proxy refusal is feedback, not an executed tool result.
    if (
      isChatBlockResult({
        content: result.content,
        toolCallId: result.id,
        session,
      })
    )
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
    updates[result.id] = await approveToolResult(
      session,
      result.id,
      typeof result.content === "string"
        ? result.content
        : (JSON.stringify(result.content) ?? ""),
      outcome,
    );
  }
  return {
    toolResultUpdates: updates,
    contextIsTrusted: true,
    dualLlmAnalyses: [],
    unsafeContextBoundary: undefined,
  };
}

export async function checkToolCalls(
  session: OpenAppaSession,
  calls: Array<{ id: string; name: string; arguments: string | object }>,
  canonicalize: (name: string) => string,
): Promise<PolicyBlockResult | null> {
  // APPA reserves an allowed call until its result arrives. Withholding a
  // partially checked batch would leave that reservation stuck forever.
  if (openappaEnabled() && calls.length > 1) {
    const feedback =
      "OpenAPPA requires one tool call at a time. None of these calls ran. Retry with one tool call, wait for its result, then make the next call.";
    return {
      refusalMessage: feedback,
      contentMessage: feedback,
      reason: feedback,
      blockedToolName: calls[0].name,
      toolInput: {},
      allToolCallNames: calls.map((call) => call.name),
    };
  }
  const normalized = normalizeToolCallsForPolicy(calls, canonicalize);
  for (const [index, call] of calls.entries()) {
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
    const target = normalized[index];
    const tool =
      archestraMcpBranding.getToolShortName(
        canonicalize(target.toolCallName),
      ) === "execute_remedy_plan"
        ? "appa/execute_remedy_plan"
        : target.toolCallName;
    if (isAgentTool(tool) || isSkillTool(tool)) {
      const feedback = `OpenAPPA delegation requires a child-return adapter, which is not yet available in ${archestraMcpBranding.appName} Chat.`;
      return {
        refusalMessage: feedback,
        contentMessage: feedback,
        reason: feedback,
        blockedToolName: call.name,
        toolInput: JSON.parse(target.toolCallArgs),
        allToolCallNames: calls.map((call) => call.name),
      };
    }
    const event = {
      event: "tool_call",
      operation_id: `call:${call.id}`,
      tool,
      arguments: JSON.parse(target.toolCallArgs),
      spawn: isAgentTool(tool),
    };
    const decision = await dispatch(session, event);
    if (
      decision.decision === "allow_call" ||
      decision.decision === "pass_control"
    )
      continue;
    const feedback = (
      decision.feedback ??
      decision.reason ??
      decision.detail ??
      "OpenAPPA blocked this tool call"
    )
      .replaceAll(
        "appa/execute_remedy_plan",
        archestraMcpBranding.getToolName("execute_remedy_plan"),
      )
      .replace(
        /(?<![\w/])execute_remedy_plan\b/g,
        archestraMcpBranding.getToolName("execute_remedy_plan"),
      );
    return {
      refusalMessage: feedback,
      contentMessage: feedback,
      reason: feedback,
      blockedToolName: call.name,
      toolInput: JSON.parse(target.toolCallArgs),
      allToolCallNames: calls.map((call) => call.name),
    };
  }
  return null;
}

function remedyResult(decision: z.infer<typeof Decision>): CallToolResult {
  if (decision.decision !== "mcp_result")
    return {
      isError: true,
      content: [
        {
          type: "text",
          text:
            decision.feedback ?? decision.detail ?? "OpenAPPA remedy refused",
        },
      ],
    };
  // MCP validation stays at the gateway boundary; this result comes from the
  // existing Rust MCP implementation, including isError and content blocks.
  return decision.result as CallToolResult;
}

export async function executeRemedy(
  session: OpenAppaSession,
  toolCallId: string,
  args: unknown,
): Promise<CallToolResult> {
  const decision = await dispatch(session, {
    event: "remedy",
    operation_id: `remedy:${toolCallId}`,
    arguments: args,
  });
  return remedyResult(decision);
}
