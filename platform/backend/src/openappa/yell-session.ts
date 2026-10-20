import { createHash } from "node:crypto";
import {
  isYellToolShortName,
  TimeInMs,
  type YellToolShortName,
} from "@archestra/shared";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { archestraMcpBranding } from "@/archestra-mcp-server/branding";
import { type AllowedCacheKey, CacheKey, cacheManager } from "@/cache-manager";
import logger from "@/logging";
import { normalizeToolCallsForPolicy } from "@/routes/proxy/llm-proxy-helpers";
import type { ToolNameResolution } from "@/routes/proxy/utils/gateway-tool-names";
import { ApiError } from "@/types";
import type { OpenAppaSession } from "./service";
import type { DeclaredToolSpelling } from "./wire";

export const YellArgumentsSchema = z.strictObject({
  message: z
    .string()
    .min(1)
    .max(65536)
    .refine((value) => value.trim().length > 0, "A message is required"),
  with_trajectory: z.boolean(),
});

export type YellArguments = z.infer<typeof YellArgumentsSchema>;

type YellSession = { session: OpenAppaSession; callId: string };

export function reportingToolSpellings(params: {
  identity: ToolNameResolution;
  declarations: readonly DeclaredToolSpelling[];
  nativeQuestion?: string;
}): DeclaredToolSpelling[] {
  const { identity, declarations, nativeQuestion } = params;
  const shortName = (tool: DeclaredToolSpelling) =>
    archestraMcpBranding.getToolShortName(
      identity.canonicalize(tool.name, tool.namespace),
    );
  if (
    !declarations.some((tool) =>
      ["yell", "run_tool"].some((name) => name === shortName(tool)),
    )
  )
    return [];
  const tools = declarations.filter((tool) =>
    [...REPORTING_TOOLS, "run_tool"].some((name) => name === shortName(tool)),
  );
  if (
    nativeQuestion &&
    declarations.some(
      (tool) => tool.name === nativeQuestion && tool.namespace === undefined,
    )
  )
    tools.push({ name: nativeQuestion });
  return tools;
}

export function isReportingToolCall(params: {
  call: { name: string; arguments: string | object; namespace?: string };
  resolution: ToolNameResolution;
  nativeQuestion?: string;
}): boolean {
  const { call, resolution, nativeQuestion } = params;
  if (typeof call.arguments === "string") {
    try {
      JSON.parse(call.arguments);
    } catch {
      return false;
    }
  } else if (!call.arguments || typeof call.arguments !== "object")
    return false;
  if (
    nativeQuestion &&
    call.name === nativeQuestion &&
    call.namespace === undefined
  )
    return true;
  const [target] = normalizeToolCallsForPolicy([call], resolution);
  const shortName = archestraMcpBranding.getToolShortName(target.toolCallName);
  return REPORTING_TOOLS.some((name) => name === shortName);
}

/** Retain the host's result, not a client's claim about what a reporting tool returned. */
export async function rememberYellResult(
  params: YellSession & { result: CallToolResult },
): Promise<void> {
  try {
    await cacheManager.set<string>(
      yellResultKey(params.session, params.callId),
      params.result.content
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join("\n"),
      TimeInMs.Day,
    );
  } catch (error) {
    logger.warn(
      { err: error },
      "OpenAPPA could not retain the reporting result",
    );
  }
}

export async function readYellResult(
  session: OpenAppaSession,
  callId: string,
): Promise<string | undefined> {
  return (
    (await cacheManager.get<string>(yellResultKey(session, callId))) ??
    undefined
  );
}

/**
 * An external client runs the yell the proxy allowed through the MCP gateway,
 * which sees neither the proxy's session nor the model's call id. The proxy
 * leaves both here, keyed by what the gateway does see: the organization and
 * the call's arguments. Calls that are not the platform's yell,
 * directly or through `run_tool`, leave nothing.
 */
export async function rememberYellSession(params: {
  session: OpenAppaSession;
  call: {
    id: string;
    name: string;
    arguments: string | object;
    namespace?: string;
  };
  resolution: ToolNameResolution;
}): Promise<void> {
  const [target] = normalizeToolCallsForPolicy(
    [params.call],
    params.resolution,
  );
  const shortName = archestraMcpBranding.getToolShortName(target.toolCallName);
  if (!isYellToolShortName(shortName)) return;
  const args = YellArgumentsSchema.safeParse(parseJson(target.toolCallArgs));
  if (!args.success) return;
  try {
    await cacheManager.set<YellSession>(
      yellSessionKey(params.session.organization_id, args.data),
      { session: params.session, callId: params.call.id },
      TimeInMs.Minute * 10,
    );
  } catch (error) {
    // A lost entry costs only this yell, refused at the gateway; the turn goes on.
    logger.warn({ err: error }, "OpenAPPA could not record the yell session");
  }
}

export async function recallYellSession(params: {
  organizationId: string;
  args: YellArguments;
}): Promise<YellSession | undefined> {
  try {
    return await cacheManager.getAndDelete<YellSession>(
      yellSessionKey(params.organizationId, params.args),
      { throwOnError: true },
    );
  } catch (error) {
    logger.warn({ err: error }, "OpenAPPA could not recall the yell session");
    throw new ApiError(
      503,
      "OpenAPPA reporting is temporarily unavailable; retry the same yell call",
    );
  }
}

const REPORTING_TOOLS = [
  "yell",
  "ask_user",
  "get_remedy_plans",
  "execute_remedy_plan",
] as const;

function yellResultKey(
  session: OpenAppaSession,
  callId: string,
): AllowedCacheKey {
  return `${CacheKey.OpenAppaYellResult}-${createHash("sha256")
    .update(
      JSON.stringify([
        session.organization_id,
        session.caller_id,
        session.session_id,
        callId,
      ]),
    )
    .digest("base64url")}`;
}

function yellSessionKey(
  organizationId: string,
  args: YellArguments,
): AllowedCacheKey {
  const parts = [organizationId, args.message, args.with_trajectory];
  const digest = createHash("sha256")
    .update(JSON.stringify(parts))
    .digest("base64url");
  return `${CacheKey.OpenAppaYellSession}-${digest}`;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}
