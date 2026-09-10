import { isAgentTool, isSkillTool } from "@archestra/shared";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { archestraMcpBranding } from "@/archestra-mcp-server/branding";
import { getDatabaseConnectionString } from "@/database";
import type { PolicyBlockResult } from "@/guardrails/tool-invocation";
import { normalizeToolCallsForPolicy } from "@/routes/proxy/llm-proxy-helpers";
import { ApiError, type CommonMessage } from "@/types";

export const APPA_SESSION_HEADER = "X-Appa-Session-ID";
export const APPA_PARENT_HEADER = "X-Appa-Parent-ID";
export const OPENAPPA_REMEDY_TOOL = "archestra__execute_remedy_plan";
export type ExecutionOutcome = "success" | "failure" | "unknown";
export type OpenAppaSession = {
  organization_id: string;
  caller_id: string;
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
});

let native: Promise<typeof import("@archestra/openappa-rs")> | undefined;
export function openappaEnabled(): boolean {
  return Boolean(process.env.ARCHESTRA_OPENAPPA_POLICY_PATH);
}

async function binding() {
  native ??= (async () => {
    const module = await import("@archestra/openappa-rs");
    const url = new URL(getDatabaseConnectionString());
    // pg ignores Prisma's legacy schema parameter; rust-postgres rejects it.
    url.searchParams.delete("schema");
    await module.initializeOpenappa(
      url.toString(),
      process.env.ARCHESTRA_OPENAPPA_POLICY_PATH ?? "",
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
  try {
    const module = await binding();
    return Decision.parse(
      JSON.parse(
        await module.dispatchHook(JSON.stringify({ ...session, ...event })),
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
  if (!params.callerId)
    throw new ApiError(
      401,
      "OpenAPPA requires an authenticated Archestra caller",
    );
  return {
    organization_id: params.organizationId,
    caller_id: params.callerId,
    session_id: sessionId,
    ...(parentId ? { parent_id: parentId as string } : {}),
  };
}

export async function startSession(session: OpenAppaSession) {
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

export async function chatLifecycle(
  session: OpenAppaSession,
  event: "prompt" | "turn_end",
  turnId: string,
) {
  if (!openappaEnabled()) return;
  const decision = await dispatch(session, {
    event,
    operation_id: `${event}:${turnId}`,
  });
  if (decision.decision !== "ack")
    throw new ApiError(409, "OpenAPPA lifecycle event refused");
}

export async function approveToolResult(
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
  messages: CommonMessage[],
) {
  await startSession(session);
  const updates: Record<string, string> = {};
  for (const message of messages) {
    for (const result of message.toolCalls ?? []) {
      // isError=false is a default in several provider adapters, not evidence
      // of successful execution. Chat already supplies the real MCP outcome.
      updates[result.id] = await approveToolResult(
        session,
        result.id,
        typeof result.content === "string"
          ? result.content
          : (JSON.stringify(result.content) ?? ""),
        result.isError ? "failure" : "unknown",
      );
    }
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
      const feedback =
        "OpenAPPA delegation requires a child-return adapter, which is not yet available in Archestra Chat.";
      return {
        refusalMessage: feedback,
        contentMessage: feedback,
        reason: feedback,
        blockedToolName: call.name,
        toolInput: JSON.parse(target.toolCallArgs),
        allToolCallNames: calls.map((call) => call.name),
      };
    }
    const decision = await dispatch(session, {
      event: "tool_call",
      operation_id: `call:${call.id}`,
      tool,
      arguments: JSON.parse(target.toolCallArgs),
      spawn: isAgentTool(tool),
    });
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
