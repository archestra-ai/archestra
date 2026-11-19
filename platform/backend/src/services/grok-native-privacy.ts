import type { FastifyRequest } from "fastify";
import logger from "@/logging";
import AuditLogModel from "@/models/audit-log";
import UserModel from "@/models/user";
import { reportAuditWriteFailure } from "@/observability/metrics/audit";
import {
  fetchNativeGrokMetadata,
  updateNativeGrokPrivacy,
} from "@/routes/proxy/adapters/xai-native-session";
import { ApiError } from "@/types/api";

export async function setGrokNativePrivacy(params: {
  request: FastifyRequest;
  identity: { userId?: string; agent: { organizationId: string } } | undefined;
  optOut: boolean;
}): Promise<{ codingDataRetentionOptOut: boolean }> {
  const { request, identity, optOut } = params;
  if (!identity?.userId)
    throw new ApiError(
      401,
      "A personal platform identity is required to update native Grok privacy settings.",
    );
  const occurredAt = new Date();
  const signal = AbortSignal.timeout(15000);
  const user = await fetchNativeGrokMetadata({
    name: "user",
    headers: request.headers,
    signal,
  });
  const before =
    typeof user.codingDataRetentionOptOut === "boolean"
      ? user.codingDataRetentionOptOut
      : null;
  const actor = await UserModel.getById(identity.userId);
  let failure: unknown;
  try {
    await updateNativeGrokPrivacy({ headers: request.headers, optOut, signal });
  } catch (error) {
    failure = error;
  }
  if (before !== optOut || failure) {
    await AuditLogModel.create({
      organizationId: identity.agent.organizationId,
      actorId: identity.userId,
      actorType: "api_key",
      actorName: actor?.name ?? null,
      actorEmail: actor?.email ?? null,
      action: "clientPrivacy.updated",
      outcome: failure
        ? failure instanceof ApiError && failure.statusCode === 403
          ? "denied"
          : "failure"
        : "success",
      resourceType: "clientPrivacy",
      resourceId: identity.userId,
      resourceName: "Grok coding data sharing",
      before: { clientId: "grok-build", codingDataRetentionOptOut: before },
      after: failure
        ? null
        : { clientId: "grok-build", codingDataRetentionOptOut: optOut },
      httpMethod: request.method,
      httpPath: request.url.split("?")[0],
      httpRoute: request.routeOptions.url ?? null,
      httpStatus:
        failure instanceof ApiError ? failure.statusCode : failure ? 502 : 200,
      requestId: request.id,
      sourceIp: request.ip,
      userAgent: request.headers["user-agent"] ?? null,
      occurredAt,
    }).catch((error) => {
      logger.error(
        { err: error },
        "audit: failed to record native Grok privacy update",
      );
      reportAuditWriteFailure({
        source: "http",
        resourceType: "clientPrivacy",
      });
    });
  }
  if (failure) throw failure;
  return { codingDataRetentionOptOut: optOut };
}
