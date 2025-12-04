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

  if (!entry) {
    return null;
  }

  // Remove the entry regardless of expiry
  SSO_GROUPS_CACHE.delete(key);

  // Check if expired
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    return null;
  }

  return {
    groups: entry.groups,
    organizationId: entry.organizationId,
  };
}

/**
 * Extract groups from SSO claims.
 * Supports various formats from different identity providers:
 * - Array of strings: ["group1", "group2"]
 * - Comma-separated string: "group1,group2"
 * - Space-separated string: "group1 group2"
 */
export function extractGroupsFromClaims(
  claims: Record<string, unknown>,
): string[] {
  // Common claim names for groups
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

    if (Array.isArray(value)) {
      // Filter to only strings and flatten if nested
      const groups = value
        .flat()
        .filter((v) => typeof v === "string") as string[];
      // Only return if we found non-empty groups, otherwise continue checking other claim names
      if (groups.length > 0) {
        return groups;
      }
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
  }

  return [];
}

/**
 * Clean up expired cache entries.
 * Call periodically to prevent memory leaks.
 */
export function cleanupExpiredEntries(): void {
  const now = Date.now();
  for (const [key, entry] of SSO_GROUPS_CACHE.entries()) {
    if (now - entry.timestamp > CACHE_TTL_MS) {
      SSO_GROUPS_CACHE.delete(key);
    }
  }
}

// Run cleanup every 5 minutes
setInterval(cleanupExpiredEntries, 5 * 60 * 1000);
