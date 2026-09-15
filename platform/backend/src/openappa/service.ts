import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { archestraMcpBranding } from "@/archestra-mcp-server/branding";
import config from "@/config";
import { ApiError } from "@/types";
import { openappaNative } from "./native";

export const APPA_SESSION_HEADER = "X-Appa-Session-ID";
export const APPA_PARENT_HEADER = "X-Appa-Parent-ID";
export const OPENAPPA_REMEDY_TOOL = "archestra__execute_remedy_plan";
/** @public - carried across the MCP gateway's module boundary. */
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
  offers: z.array(z.object({ offer_id: z.string() })).optional(),
});

export function openappaEnabled(): boolean {
  return config.llmProxy.plugins.includes("appa");
}

async function binding() {
  return openappaNative();
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
      `OpenAPPA requires an authenticated ${archestraMcpBranding.appName} caller`,
    );
  return {
    organization_id: params.organizationId,
    caller_id: params.callerId,
    session_id: sessionId,
    ...(parentId ? { parent_id: parentId as string } : {}),
  };
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
