// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.

import { createHash } from "node:crypto";
import { MIN_PERMISSION_SYNC_INTERVAL_SECONDS } from "@archestra/shared";
import { CacheKey, cacheManager } from "@/cache-manager";
import logger from "@/logging";
import { KbContainerAclModel, KbExternalUserGroupModel } from "@/models";
import * as metrics from "@/observability/metrics";
import type { AclEntry } from "@/types";
import { normalizeEmail } from "./acl-tokens";

/**
 * Group memberships and container audiences only change when a permission-sync
 * pass writes them, so a cached lookup is exactly as fresh as those tables as
 * long as every finished pass invalidates (permission-sync.ts does). The TTL
 * is a backstop, bounded by the shortest interval any connector can sync at.
 */
const ACCESS_TOKEN_CACHE_TTL_MS = MIN_PERMISSION_SYNC_INTERVAL_SECONDS * 1000;

/**
 * Ceiling on the `container:` tokens resolved for one user. Every token is a
 * bind parameter of the chunk query's `?|` filter; a pathological wiki (tens
 * of thousands of restricted pages readable by one user) must not blow up the
 * query. Truncation is an under-grant (fail-closed) in the safe direction.
 */
const MAX_USER_CONTAINER_TOKENS = 2000;

/**
 * Ceiling on the `group:` tokens resolved for one user. Group tokens are bind
 * parameters twice over — the container-audience overlap's `?| ARRAY[...]`
 * and the chunk query's `?|` filter — so a user in a pathological number of
 * upstream groups must not blow up either query. Truncation is an under-grant
 * (fail-closed) in the safe direction.
 */
const MAX_USER_GROUP_TOKENS = 2000;

/**
 * The upstream-derived ACL tokens a user is entitled to across the given
 * auto-sync connectors, resolved locally (no upstream call) and cached:
 * - `group:` tokens from the membership snapshot (email or admin override);
 * - `container:` tokens for every container whose materialized audience
 *   overlaps the user's base tokens (`org:*` public containers, direct
 *   `user_email:` grants, and the group tokens resolved first).
 *
 * Cached per (user email, user id, connector set) — including EMPTY results,
 * which are the common case and cost the same joins to recompute.
 */
export async function findAccessTokensForUserCached(params: {
  memberEmail: string;
  userId?: string;
  connectorIds: string[];
}): Promise<AclEntry[]> {
  if (params.connectorIds.length === 0) return [];

  const key = buildCacheKey(params);
  const cached = await cacheManager.get<AclEntry[]>(key);
  if (cached !== undefined) return cached;

  const tokens = await resolveAccessTokens(params);
  try {
    await cacheManager.set(key, tokens, ACCESS_TOKEN_CACHE_TTL_MS);
  } catch (error) {
    // A lost cache write only costs a recompute — never fail the query. (It
    // cannot over-grant: what we cache is exactly what we would return.)
    logger.warn(
      { error: error instanceof Error ? error.message : String(error) },
      "Failed to cache access tokens; serving the uncached result",
    );
  }
  return tokens;
}

/**
 * Drop every cached access-token resolution. Called whenever a permission-sync
 * pass finishes or an admin edits a manual member override (the only writers
 * of what the resolution joins read), so freshly synced or freshly mapped
 * access is visible on the next query instead of after the TTL.
 */
export async function invalidateGroupTokenCache(): Promise<void> {
  await cacheManager.deleteByPrefix(CacheKey.KbGroupTokens);
}

// ===== Internal helpers =====

async function resolveAccessTokens(params: {
  memberEmail: string;
  userId?: string;
  connectorIds: string[];
}): Promise<AclEntry[]> {
  let groupTokens = await KbExternalUserGroupModel.findGroupTokensForUser({
    memberEmail: params.memberEmail,
    userId: params.userId,
    connectorIds: params.connectorIds,
  });
  if (groupTokens.length > MAX_USER_GROUP_TOKENS) {
    // A warn line is invisible to the person it happens to: the user simply
    // stops finding documents they are entitled to, with nothing to see. The
    // counter is what makes it an alertable condition instead of an
    // archaeological finding.
    logger.warn(
      {
        memberEmail: normalizeEmail(params.memberEmail),
        groupTokens: groupTokens.length,
        cap: MAX_USER_GROUP_TOKENS,
      },
      "User group-token resolution exceeds the cap; truncating (fail-closed under-grant)",
    );
    metrics.rag.reportAccessTokenTruncation({ kind: "group" });
    groupTokens = groupTokens.slice(0, MAX_USER_GROUP_TOKENS);
  }
  // Base tokens feed the container-audience overlap: public containers match
  // org:*, direct grants match the email token, group grants match the group
  // tokens resolved above. `team:` tokens never appear in container audiences.
  const baseTokens: AclEntry[] = [
    "org:*",
    `user_email:${normalizeEmail(params.memberEmail)}`,
    ...groupTokens,
  ];
  let containerTokens = await KbContainerAclModel.findContainerTokensForUser({
    connectorIds: params.connectorIds,
    baseTokens,
  });
  if (containerTokens.length > MAX_USER_CONTAINER_TOKENS) {
    logger.warn(
      {
        memberEmail: normalizeEmail(params.memberEmail),
        containerTokens: containerTokens.length,
        cap: MAX_USER_CONTAINER_TOKENS,
      },
      "User container-token resolution exceeds the cap; truncating (fail-closed under-grant)",
    );
    metrics.rag.reportAccessTokenTruncation({ kind: "container" });
    containerTokens = containerTokens.slice(0, MAX_USER_CONTAINER_TOKENS);
  }
  return [...groupTokens, ...containerTokens];
}

function buildCacheKey(params: {
  memberEmail: string;
  userId?: string;
  connectorIds: string[];
}): `${typeof CacheKey.KbGroupTokens}-${string}` {
  // The connector set varies per agent/gateway scope; hash it so the key stays
  // bounded regardless of how many connectors are in scope. The userId rides
  // along because manual member overrides resolve by user id, not email.
  //
  // The full 128 bits of the digest are kept. A truncated hash collides between
  // two DIFFERENT connector sets, and the entry it collides with was resolved
  // against the other set's containers and groups — so a collision does not lose
  // a cache entry, it hands a user tokens for connectors that were never in
  // their scope. That is an over-grant, and no birthday-bound argument is worth
  // making for one when the extra 16 characters cost nothing.
  const connectorSetHash = createHash("sha256")
    .update([...params.connectorIds].sort().join(","))
    .digest("hex")
    .slice(0, 32);
  return `${CacheKey.KbGroupTokens}-${normalizeEmail(params.memberEmail)}:${params.userId ?? ""}:${connectorSetHash}`;
}
