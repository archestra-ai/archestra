import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import type { z } from "zod";
import { schema } from "@/database";

/**
 * Predefined cache key prefixes for the distributed cache.
 *
 * These prefixes categorize cache entries and enable efficient invalidation
 * of related entries using deleteByPrefix().
 */
export const CacheKey = {
  /** Chat model list cache */
  GetChatModels: "get-chat-models",
  /** MCP tools for chat feature */
  ChatMcpTools: "chat-mcp-tools",
  /** Deduplication for processed emails */
  ProcessedEmail: "processed-email",
  /** Rate limiting for webhooks */
  WebhookRateLimit: "webhook-rate-limit",
  /** OAuth flow state during authentication */
  OAuthState: "oauth-state",
  /** MCP Gateway session state */
  McpSession: "mcp-session",
  /** SSO groups cache during login flow */
  SsoGroups: "sso-groups",
} as const;

export type CacheKeyPrefix = (typeof CacheKey)[keyof typeof CacheKey];

/**
 * Allowed cache key format: either a base prefix or prefix with suffix.
 *
 * Examples:
 * - "get-chat-models" (just the prefix)
 * - "oauth-state-abc123" (prefix with unique identifier)
 * - "sso-groups-provider:user@example.com" (prefix with composite key)
 */
export type AllowedCacheKey =
  | `${CacheKeyPrefix}`
  | `${CacheKeyPrefix}-${string}`;

// Database schemas using drizzle-zod
export const SelectCacheSchema = createSelectSchema(schema.cacheTable);
export const InsertCacheSchema = createInsertSchema(schema.cacheTable);

export type CacheEntry = z.infer<typeof SelectCacheSchema>;
export type InsertCacheEntry = z.infer<typeof InsertCacheSchema>;
