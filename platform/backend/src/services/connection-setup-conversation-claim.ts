// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise

import { type AllowedCacheKey, CacheKey, cacheManager } from "@/cache-manager";
import logger from "@/logging";
import { isWellFormedAppaId } from "@/openappa/service";
import { APPA_CLIENT_ADAPTERS } from "@/proxy/plugins/appa-plugin-archestra/session-identity";
import type { AppaMatchContext } from "@/proxy/plugins/appa-plugin-archestra/types";
import { readHeader } from "@/proxy/plugins/appa-plugin-archestra/utils";

/**
 * Bind a verified setup to the first well-formed native conversation that
 * presents its reference. Later conversations, a missing identity, a cache
 * error, and an expired window are not exempt. Does not open an OpenAPPA
 * session.
 */
export async function claimConnectionSetupConversation(params: {
  organizationId: string;
  setupId: string;
  expiresAt: number;
  headers: AppaMatchContext["headers"];
  requestBody: unknown;
}): Promise<boolean> {
  const nativeConversationId = nativeConversationIdForSetupClaim(params);
  if (!nativeConversationId) return false;
  if (!isNonEmpty(params.organizationId) || !isNonEmpty(params.setupId)) {
    return false;
  }
  if (!Number.isSafeInteger(params.expiresAt)) return false;
  const key = conversationKey(params.organizationId, params.setupId);
  try {
    const claimed = await cacheManager.withLock(key, async (cache) => {
      if (params.expiresAt <= Date.now()) return false;
      const existing = await cache.get<unknown>(key);
      const now = Date.now();
      if (params.expiresAt <= now) return false;
      if (existing !== undefined) {
        const owner = claimedConversationId(existing);
        return owner === nativeConversationId;
      }
      const ttl = params.expiresAt - now;
      if (ttl <= 0) return false;
      await cache.set(key, { nativeConversationId }, ttl);
      return true;
    });
    return claimed && params.expiresAt > Date.now();
  } catch (error) {
    logger.warn(
      { err: error },
      "Connection setup conversation claim failed; Guardrails apply",
    );
    return false;
  }
}

function nativeConversationIdForSetupClaim(params: {
  headers: AppaMatchContext["headers"];
  requestBody: unknown;
}): string | undefined {
  try {
    const context: AppaMatchContext = {
      headers: params.headers,
      requestBody: params.requestBody,
    };
    const adapter = APPA_CLIENT_ADAPTERS.find((candidate) =>
      candidate.matches(context),
    );
    const sessionId = adapter?.extractSessionIdentity?.(context)?.sessionId;
    if (!isWellFormedAppaId(sessionId)) return undefined;
    if (
      adapter?.id === "opencode" &&
      !isOpenCodeOwnSession(context, sessionId)
    ) {
      return undefined;
    }
    return sessionId;
  } catch {
    return undefined;
  }
}

function isOpenCodeOwnSession(
  context: AppaMatchContext,
  sessionId: string,
): boolean {
  const own =
    readHeader(context.headers, "x-opencode-session") ??
    readHeader(context.headers, "x-session-id") ??
    readHeader(context.headers, "session-id");
  return own === sessionId;
}

function conversationKey(
  organizationId: string,
  setupId: string,
): AllowedCacheKey {
  return `${CacheKey.ConnectionSetupConversation}-${organizationId}:${setupId}`;
}

function claimedConversationId(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  if (!Object.hasOwn(value, "nativeConversationId")) return undefined;
  const id = (value as { nativeConversationId: unknown }).nativeConversationId;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

function isNonEmpty(value: string): boolean {
  return value.length > 0;
}
