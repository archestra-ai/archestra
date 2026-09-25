import { createHash } from "node:crypto";
import { TimeInMs } from "@archestra/shared";
import { z } from "zod";
import { archestraMcpBranding } from "@/archestra-mcp-server/branding";
import { type AllowedCacheKey, CacheKey, cacheManager } from "@/cache-manager";
import logger from "@/logging";
import { normalizeToolCallsForPolicy } from "@/routes/proxy/llm-proxy-helpers";
import type { ToolNameResolution } from "@/routes/proxy/utils/gateway-tool-names";
import type { OpenAppaSession } from "./service";

export const YellArgumentsSchema = z.strictObject({
  message: z
    .string()
    .min(1)
    .max(65536)
    .refine((value) => value.trim().length > 0, "A message is required"),
  with_trajectory: z.boolean(),
});

type YellArguments = z.infer<typeof YellArgumentsSchema>;

type YellSession = { session: OpenAppaSession; callId: string };

/**
 * An external client runs the yell the proxy allowed through the MCP gateway,
 * which sees neither the proxy's session nor the model's call id. The proxy
 * leaves both here, keyed by what the gateway does see: the organization and
 * the call's arguments. Calls that are not the platform's yell, directly or
 * through `run_tool`, leave nothing.
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
  if (archestraMcpBranding.getToolShortName(target.toolCallName) !== "yell")
    return;
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
    logger.warn({ err: error }, "Could not record the OpenAPPA yell session");
  }
}

export async function recallYellSession(params: {
  organizationId: string;
  args: YellArguments;
}): Promise<YellSession | undefined> {
  return cacheManager.getAndDelete<YellSession>(
    yellSessionKey(params.organizationId, params.args),
    { throwOnError: true },
  );
}

function yellSessionKey(
  organizationId: string,
  args: YellArguments,
): AllowedCacheKey {
  const digest = createHash("sha256")
    .update(
      JSON.stringify([organizationId, args.message, args.with_trajectory]),
    )
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
