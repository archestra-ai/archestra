import type { SsoTeamSyncConfig } from "@shared";
import logger from "@/logging";
import { extractGroupsWithTemplate } from "@/templating";

/**
 * Temporary in-memory cache for SSO groups during login flow.
 *
 * This cache stores the user's SSO groups from the token/userInfo
 * so they can be used in the after hook for team synchronization.
 *
 * The cache is keyed by a composite of providerId and user email.
 * Entries automatically expire after 60 seconds to prevent stale data.
 */

interface SsoGroupsCacheEntry {
  groups: string[];
  organizationId: string;
  timestamp: number;
}

const SSO_GROUPS_CACHE = new Map<string, SsoGroupsCacheEntry>();
const CACHE_TTL_MS = 60_000; // 60 seconds

/**
 * Generate a cache key from provider ID and user email
 */
function getCacheKey(providerId: string, email: string): string {
  return `${providerId}:${email.toLowerCase()}`;
}

/**
 * Store SSO groups for a user during login
 */
export function cacheSsoGroups(
  providerId: string,
  email: string,
  organizationId: string,
  groups: string[],
): void {
  const key = getCacheKey(providerId, email);
  logger.debug(
    { providerId, email, organizationId, groupCount: groups.length },
    "[ssoTeamSyncCache] Caching SSO groups",
  );
  SSO_GROUPS_CACHE.set(key, {
    groups,
    organizationId,
    timestamp: Date.now(),
  });
}

/**
 * Retrieve and remove SSO groups for a user after login
 * Returns null if no entry exists or if the entry has expired
 */
export function retrieveSsoGroups(
  providerId: string,
  email: string,
): { groups: string[]; organizationId: string } | null {
  const key = getCacheKey(providerId, email);
  const entry = SSO_GROUPS_CACHE.get(key);

  logger.debug(
    { providerId, email, found: !!entry },
    "[ssoTeamSyncCache] Retrieving SSO groups",
  );

  if (!entry) {
    logger.debug(
      { providerId, email },
      "[ssoTeamSyncCache] No cached groups found",
    );
    return null;
  }

  // Remove the entry regardless of expiry
  SSO_GROUPS_CACHE.delete(key);

  // Check if expired
  const age = Date.now() - entry.timestamp;
  if (age > CACHE_TTL_MS) {
    logger.debug(
      { providerId, email, ageMs: age, ttlMs: CACHE_TTL_MS },
      "[ssoTeamSyncCache] Cached groups expired",
    );
    return null;
  }

  logger.debug(
    {
      providerId,
      email,
      groupCount: entry.groups.length,
      organizationId: entry.organizationId,
    },
    "[ssoTeamSyncCache] Retrieved valid cached groups",
  );

  return {
    groups: entry.groups,
    organizationId: entry.organizationId,
  };
}

/**
 * Normalize extracted groups to an array of strings.
 * Handles various formats from different identity providers.
 */
function normalizeGroups(value: unknown): string[] {
  if (Array.isArray(value)) {
    // Filter to only strings and flatten if nested
    return value.flat().filter((v) => typeof v === "string") as string[];
  }

  if (typeof value === "string" && value.trim()) {
    // Try comma-separated first
    if (value.includes(",")) {
      return value
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }
    // Try space-separated
    if (value.includes(" ")) {
      return value
        .split(" ")
        .map((s) => s.trim())
        .filter(Boolean);
    }
    // Single value
    return [value.trim()];
  }

  return [];
}

/**
 * Extract groups from SSO claims using Handlebars template.
 *
 * @param claims - The SSO claims object (token claims, userInfo, or combined)
 * @param teamSyncConfig - Optional team sync configuration with Handlebars template
 * @returns Array of group identifiers
 */
export function extractGroupsFromClaims(
  claims: Record<string, unknown>,
  teamSyncConfig?: SsoTeamSyncConfig,
): string[] {
  // If team sync is explicitly disabled, return empty array
  if (teamSyncConfig?.enabled === false) {
    return [];
  }

  // If a custom Handlebars template is configured, use it
  if (teamSyncConfig?.groupsExpression) {
    try {
      const groups = extractGroupsWithTemplate(
        teamSyncConfig.groupsExpression,
        claims,
      );

      if (groups.length > 0) {
        logger.debug(
          {
            expression: teamSyncConfig.groupsExpression,
            groupCount: groups.length,
          },
          "Extracted groups using custom Handlebars template",
        );
        return groups;
      }

      logger.debug(
        {
          expression: teamSyncConfig.groupsExpression,
        },
        "Handlebars template returned no groups",
      );
      return [];
    } catch (error) {
      logger.warn(
        {
          err: error,
          expression: teamSyncConfig.groupsExpression,
        },
        "Error evaluating team sync Handlebars template, falling back to default extraction",
      );
      // Fall through to default extraction
    }
  }

  // Default: Check common claim names for groups
  const groupClaimNames = [
    "groups",
    "group",
    "memberOf",
    "member_of",
    "roles",
    "role",
    "teams",
    "team",
  ];

  for (const claimName of groupClaimNames) {
    const value = claims[claimName];
    const groups = normalizeGroups(value);
    if (groups.length > 0) {
      return groups;
    }
  }

  return [];
}

/**
 * Clean up expired cache entries.
 * Call periodically to prevent memory leaks.
 */
export function cleanupExpiredEntries(): void {
  const now = Date.now();
  let cleaned = 0;
  for (const [key, entry] of SSO_GROUPS_CACHE.entries()) {
    if (now - entry.timestamp > CACHE_TTL_MS) {
      SSO_GROUPS_CACHE.delete(key);
      cleaned++;
    }
  }
  if (cleaned > 0) {
    logger.debug(
      { cleanedEntries: cleaned, remainingEntries: SSO_GROUPS_CACHE.size },
      "[ssoTeamSyncCache] Cleaned expired entries",
    );
  }
}

// Run cleanup every 5 minutes
setInterval(cleanupExpiredEntries, 5 * 60 * 1000);
