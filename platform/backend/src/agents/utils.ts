import { type AllowedCacheKey, cacheManager } from "@/cache-manager";
import { AGENT_TEMPLATES, type AgentTemplate } from "./agent-templates";

/**
 * ARCHESTRA AGENT UTILS - IMPLEMENTATION FOR ISSUE #3858
 * Contains rate-limiting logic and Agent Template Catalog functions.
 */

export interface RateLimitEntry {
  count: number;
  windowStart: number;
}

interface RateLimitConfig {
  windowMs: number;
  maxRequests: number;
}

/**
 * Returns the complete catalog of pre-configured agent templates.
 * This is the core logic for the $450 Agent Template Catalog bounty.
 */
export function getAgentTemplateCatalog(): AgentTemplate[] {
  return AGENT_TEMPLATES;
}

/**
 * Check if an identifier is rate limited using the shared CacheManager.
 */
export async function isRateLimited(
  cacheKey: AllowedCacheKey,
  config: RateLimitConfig,
): Promise<boolean> {
  const { windowMs, maxRequests } = config;
  const now = Date.now();
  const entry = await cacheManager.get<RateLimitEntry>(cacheKey);

  if (!entry || now - entry.windowStart > windowMs) {
    await cacheManager.set(
      cacheKey,
      { count: 1, windowStart: now },
      windowMs * 2,
    );
    return false;
  }

  if (entry.count >= maxRequests) {
    return true;
  }

  await cacheManager.set(
    cacheKey,
    { count: entry.count + 1, windowStart: entry.windowStart },
    windowMs * 2,
  );
  return false;
}
