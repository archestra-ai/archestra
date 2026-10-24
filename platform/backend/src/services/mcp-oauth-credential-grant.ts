import { createHash } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { CacheKey, cacheManager } from "@/cache-manager";
import { ApiError } from "@/types";

export function getMcpOAuthCallerBinding(request: FastifyRequest): string {
  const { user, organizationId, authMethod, sessionInfo } = request;
  if (
    !user?.id ||
    !organizationId ||
    !authMethod ||
    (authMethod === "session" && !sessionInfo?.id)
  ) {
    throw new ApiError(401, "Unauthenticated");
  }
  return createHash("sha256")
    .update(
      JSON.stringify([
        organizationId,
        user.id,
        authMethod,
        authMethod === "session" ? sessionInfo?.id : null,
      ]),
    )
    .digest("hex");
}

export async function issueMcpOAuthCredentialGrant(params: {
  secretId: string;
  catalogId: string;
  serverId?: string;
  callerBinding: string;
}): Promise<void> {
  await cacheManager.set(
    grantKey(params.secretId, params.callerBinding),
    {
      catalogId: params.catalogId,
      serverId: params.serverId ?? null,
      callerBinding: params.callerBinding,
    },
    10 * 60 * 1000,
  );
}

export async function consumeMcpOAuthCredentialGrant(params: {
  request: FastifyRequest;
  secretId: string;
  catalogId: string;
  serverId?: string;
}): Promise<boolean> {
  const callerBinding = getMcpOAuthCallerBinding(params.request);
  const data = await cacheManager.getAndDelete<unknown>(
    grantKey(params.secretId, callerBinding),
  );
  const parsed = grantSchema.safeParse(data);
  return (
    parsed.success &&
    parsed.data.catalogId === params.catalogId &&
    parsed.data.serverId === (params.serverId ?? null) &&
    parsed.data.callerBinding === callerBinding
  );
}

const grantSchema = z.object({
  catalogId: z.string().uuid(),
  serverId: z.string().uuid().nullable(),
  callerBinding: z.string().length(64),
});

function grantKey(
  secretId: string,
  callerBinding: string,
): `${typeof CacheKey.OAuthState}-${string}` {
  return `${CacheKey.OAuthState}-credential-grant-${callerBinding}-${secretId}`;
}
