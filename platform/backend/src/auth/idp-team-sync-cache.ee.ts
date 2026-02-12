import type { IdpTeamSyncConfig } from "@shared";
import { CacheKey, cacheManager } from "@/cache-manager";
import logger from "@/logging";
import { extractGroupsWithTemplate } from "@/templating";

/**
 * Cache for IdP groups during login flow.
 *
 * This cache stores the user's IdP groups from the token/userInfo
 * so they can be used in the after hook for team synchronization.
 *
 * The cache is keyed by a composite of providerId and user email.
 * Entries automatically expire after 60 seconds to prevent stale data.
 */

interface IdpGroupsCacheEntry {
  groups: string[];
  organizationId: string;
}

const CACHE_TTL_MS = 60_000; // 60 seconds

/**
 * Generate a cache key from provider ID and user email
 */
function getCacheKey(
  providerId: string,
  email: string,
): `${typeof CacheKey.IdpGroups}-${string}` {
  return `${CacheKey.IdpGroups}-${providerId}:${email.toLowerCase()}`;
}

/**
 * Store IdP groups for a user during login
 */
export async function cacheIdpGroups(
  providerId: string,
  email: string,
  organizationId: string,
  groups: string[],
): Promise<void> {
  const key = getCacheKey(providerId, email);
  logger.debug(
    { providerId, email, organizationId, groupCount: groups.length },
    "[idpTeamSyncCache] Caching IdP groups",
  );
  await cacheManager.set<IdpGroupsCacheEntry>(
    key,
    { groups, organizationId },
    CACHE_TTL_MS,
  );
}

/**
 * Retrieve and remove IdP groups for a user after login
 * Returns null if no entry exists or if the entry has expired
 */
export async function retrieveIdpGroups(
  providerId: string,
  email: string,
): Promise<{ groups: string[]; organizationId: string } | null> {
  const key = getCacheKey(providerId, email);

  // Use atomic getAndDelete to prevent race conditions where multiple
  // concurrent requests could retrieve the same IdP groups
  const entry = await cacheManager.getAndDelete<IdpGroupsCacheEntry>(key);

  logger.debug(
    { providerId, email, found: !!entry },
    "[idpTeamSyncCache] Retrieving IdP groups",
  );

  if (!entry) {
    logger.debug(
      { providerId, email },
      "[idpTeamSyncCache] No cached groups found",
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
    "[idpTeamSyncCache] Retrieved valid cached groups",
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
  teamSyncConfig?: IdpTeamSyncConfig,
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
