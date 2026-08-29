import { TimeInMs } from "@archestra/shared";
import KeyvPostgres from "@keyv/postgres";
import { sql } from "drizzle-orm";
import Keyv from "keyv";
import QuickLRU from "quick-lru";
import config from "@/config";
import db from "@/database";
import logger from "@/logging";

/**
 * Predefined cache key prefixes for the distributed cache.
 *
 * These prefixes categorize cache entries and enable efficient invalidation
 * of related entries using deleteByPrefix().
 */
export const CacheKey = {
  /** models.dev sync tracking */
  ModelsDevSync: "models-dev-sync",
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
  /** IdP groups cache during login flow */
  IdpGroups: "idp-groups",
  /** Chat stream stop signal for cross-pod abort */
  ChatStop: "chat-stop",
  /** Maps a conversation to the id of its currently-running chat stream */
  ChatActiveStream: "chat-active-stream",
  /** Pending MCP elicitation responses from the chat UI */
  ChatMcpElicitation: "chat-mcp-elicitation",
  /** OpenAI credentials that cannot generate reasoning summaries (unverified org) */
  OpenaiReasoningSummaryUnsupported: "openai-reasoning-summary-unsupported",
  /** Channel discovery TTL per workspace */
  ChannelDiscovery: "channel-discovery",
  /** Slack user ID → email mapping */
  SlackUserEmail: "slack-user-email",
  /** Virtual API key brute-force rate limiting per IP */
  VirtualKeyRateLimit: "virtual-key-rate-limit",
  /** Connection-setup script token brute-force rate limiting per IP */
  ConnectionSetupScriptRateLimit: "connection-setup-script-rate-limit",
  /** Archestra VAF Add On package proxy rate limiting per IP */
  MfilesVafAddOnPackageRateLimit: "mfiles-vaf-add-on-package-rate-limit",
  /** Resolved release pin (package URL + ref) for the Archestra VAF Add On installer */
  MfilesVafAddOnReleasePin: "mfiles-vaf-add-on-release-pin",
  /** Latest CI-built add-on artifact for the dev source-ref override */
  MfilesVafAddOnCiArtifact: "mfiles-vaf-add-on-ci-artifact",
  ConnectionHealthRateLimit: "connection-health-rate-limit",
  /** GitHub Copilot device-flow sign-in rate limiting per user */
  GithubCopilotDeviceAuthRateLimit: "github-copilot-device-auth-rate-limit",
  /** App Gallery share (GitHub device-flow) sign-in rate limiting per user */
  AppGalleryDeviceAuthRateLimit: "app-gallery-device-auth-rate-limit",
  /** Microsoft 365 Copilot device-flow sign-in rate limiting per user */
  Microsoft365CopilotDeviceAuthRateLimit:
    "microsoft-365-copilot-device-auth-rate-limit",
  /** ChatGPT/Codex subscription device-flow sign-in rate limiting per user */
  OpenaiCodexDeviceAuthRateLimit: "openai-codex-device-auth-rate-limit",
  /** SuperGrok subscription device-flow sign-in rate limiting per user */
  XaiSubscriptionDeviceAuthRateLimit: "xai-subscription-device-auth-rate-limit",
  /** RUM event-batch ingest rate limiting per user */
  RumIngestRateLimit: "rum-ingest-rate-limit",
  /** Slack missing-scope notification throttle per workspace */
  SlackScopeNotification: "slack-scope-notification",
  /** Organization-scoped settings cache */
  OrganizationSettings: "organization-settings",
  /** Per-user group-token resolution for auto-sync-permissions KB connectors */
  KbGroupTokens: "kb-group-tokens",
  /** Cross-pass upstream identity lookups (account id → email/profile) for KB permission sync */
  KbConnectorIdentity: "kb-connector-identity",
  /** MS Teams channel threads where the bot was @mentioned (sticky auto-reply) */
  TeamsThreadActive: "teams-thread-active",
  /** Slack channel threads where the bot was @mentioned (sticky auto-reply) */
  SlackThreadActive: "slack-thread-active",
  /** MS Teams channel threads that already got the one-time "you can mute me" hint */
  TeamsThreadMuteHint: "teams-thread-mute-hint",
  /** Slack channel threads that already got the one-time "you can mute me" hint */
  SlackThreadMuteHint: "slack-thread-mute-hint",
  /** Latest mute token per MS Teams channel thread (cross-pod in-flight reply suppression) */
  TeamsThreadMuteMarker: "teams-thread-mute-marker",
  /** Latest mute token per Slack channel thread (cross-pod in-flight reply suppression) */
  SlackThreadMuteMarker: "slack-thread-mute-marker",
  /** MS Teams channel threads muted while the channel answers all messages */
  TeamsThreadMuted: "teams-thread-muted",
  /** Slack channel threads muted while the channel answers all messages */
  SlackThreadMuted: "slack-thread-muted",
  /** Per-channel "answer all messages" flag, briefly cached to spare the gate a DB read per message */
  ChatOpsChannelAnswerAll: "chatops-channel-answer-all",
  /** MS Teams thread-format team id → aadGroupId, so the gate resolves it without a Bot Framework call per message */
  TeamsTeamAadGroupId: "teams-team-aad-group-id",
  /** MS Teams teams that have delivered an un-mentioned channel message — proof the RSC consent for reading channel messages exists */
  TeamsUnmentionedChannelTraffic: "teams-unmentioned-channel-traffic",
  /** Dual LLM sanitized tool results, keyed by tool call + content hash */
  DualLlmSanitizedResult: "dual-llm-sanitized-result",
  /** Completed Q&A rounds of a dual LLM analysis that failed mid-flight, keyed by content hash so a retry resumes instead of re-interrogating */
  DualLlmPartialTranscript: "dual-llm-partial-transcript",
  /** Telegram approval-button payloads (callback_data is capped at 64 bytes) */
  TelegramApprovalCallback: "chatops-telegram-approval",
  /** One-shot codes linking a Telegram chat to a signed-in user */
  TelegramLinkCode: "chatops-telegram-link",
  /** Positive "this chat session is a locked chat" lookups for LLM proxy redaction */
  /**
   * v2: entries changed from a bare `true` to a facts object (fingerprint +
   * escrow presence). The suffix is load-bearing — the cache is Postgres-backed
   * and shared across replicas, so during a rolling deploy new code must not
   * read an old boolean and mistake it for "not a locked chat".
   */
  LockedChatSession: "locked-chat-session-v2",
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

/**
 * PostgreSQL-based cache manager for distributed caching using Keyv.
 *
 * Provides a simple key-value store with TTL support using the @keyv/postgres adapter.
 * All cache operations are automatically shared across all application pods.
 *
 * Features:
 * - Automatic TTL expiration (handled by Keyv)
 * - JSONB storage for flexible value types
 * - Upsert semantics (set overwrites existing keys)
 * - Connection pooling via @keyv/postgres
 */
class CacheManager {
  private keyv: Keyv | null = null;
  private defaultTtl = TimeInMs.Hour;
  private isShuttingDown = false;

  /**
   * Start the cache manager by initializing the Keyv connection.
   * Should be called once during server startup.
   */
  start(): void {
    if (this.keyv) {
      return;
    }

    const store = new KeyvPostgres({
      uri: config.database.url,
      table: "keyv_cache",
      /**
       * From the PostgreSQL documentation:
       * If specified, the table is created as an unlogged table. Data written to unlogged tables is not written to the
       * write-ahead log (see Chapter 28), which makes them considerably faster than ordinary tables. However, they are
       * not crash-safe: an unlogged table is automatically truncated after a crash or unclean shutdown. The contents
       * of an unlogged table are also not replicated to standby servers. Any indexes created on an unlogged table are
       * automatically unlogged as well.
       *
       * We use this to improve performance of the cache manager.
       *
       * https://keyv.org/docs/storage-adapters/postgres/#using-an-unlogged-table-for-performance
       */
      useUnloggedTable: true,
    });

    this.keyv = new Keyv({ store });

    this.keyv.on("error", (err) => {
      if (!this.isShuttingDown) {
        logger.error({ err }, "CacheManager: Keyv connection error");
      }
    });

    logger.info("CacheManager: Started with Keyv PostgreSQL storage");
  }

  /**
   * Get a value from the cache.
   * Returns undefined if the key doesn't exist or has expired.
   *
   * Note: Returns undefined on error rather than throwing. This is intentional:
   * cache reads are non-critical and callers should handle cache misses gracefully.
   * A failed cache read should fall through to the underlying data source.
   */
  async get<T>(key: AllowedCacheKey): Promise<T | undefined> {
    if (!this.keyv) {
      logger.warn("CacheManager: Not started, returning undefined for get");
      return undefined;
    }

    try {
      const value = await this.keyv.get(key);
      return value as T | undefined;
    } catch (error) {
      logger.error({ error, key }, "CacheManager: Error getting cache entry");
      return undefined;
    }
  }

  /**
   * Set a value in the cache with optional TTL.
   * If the key already exists, it will be overwritten.
   *
   * Note: Unlike get() and delete(), this method throws on error rather than
   * returning a fallback value. This is intentional: a failed cache write for
   * critical data (like OAuth state or SSO groups) could cause security issues
   * if the caller assumes the data was cached. Callers should handle the error
   * or let it propagate to fail the operation.
   *
   * @param key - Cache key
   * @param value - Value to store (will be serialized as JSON)
   * @param ttl - Time-to-live in milliseconds (defaults to 1 hour)
   */
  async set<T>(
    key: AllowedCacheKey,
    value: T,
    ttl?: number,
  ): Promise<T | undefined> {
    if (!this.keyv) {
      throw new Error("CacheManager: Not started");
    }

    try {
      await this.keyv.set(key, value, ttl ?? this.defaultTtl);
      return value;
    } catch (error) {
      logger.error({ error, key }, "CacheManager: Error setting cache entry");
      throw error;
    }
  }

  /**
   * Delete a value from the cache.
   * Returns true if the operation succeeded.
   *
   * Note: Returns false on error rather than throwing. Cache deletes are
   * typically cleanup operations where failure is non-critical - the entry
   * will expire naturally via TTL.
   */
  async delete(key: AllowedCacheKey): Promise<boolean> {
    if (!this.keyv) {
      logger.warn("CacheManager: Not started, returning false for delete");
      return false;
    }

    try {
      return await this.keyv.delete(key);
    } catch (error) {
      logger.error({ error, key }, "CacheManager: Error deleting cache entry");
      return false;
    }
  }

  /**
   * Atomically get and delete a value from the cache.
   * Returns the value if it existed and hadn't expired, undefined otherwise.
   *
   * This is useful for one-time use tokens like OAuth state where you need to
   * ensure the same token can't be used twice (prevents replay attacks).
   *
   * Implementation uses DELETE ... RETURNING for true atomicity - the delete
   * and read happen in a single database operation, preventing race conditions
   * where two requests could both read the same token before either deletes it.
   */
  async getAndDelete<T>(key: AllowedCacheKey): Promise<T | undefined> {
    if (!this.keyv) {
      logger.warn(
        "CacheManager: Not started, returning undefined for getAndDelete",
      );
      return undefined;
    }

    try {
      // Use raw SQL for atomic delete-and-return
      // Keyv stores: key (text), value (text containing JSON with {value, expires})
      // The key is namespaced with "keyv:" prefix by Keyv
      // Note: expires is stored inside the JSON value, not as a separate column
      const keyvKey = `keyv:${key}`;
      const result = await db.execute<{ value: string }>(
        sql`DELETE FROM keyv_cache
            WHERE key = ${keyvKey}
            RETURNING value`,
      );

      if (result.rows.length === 0) {
        return undefined;
      }

      // Keyv stores values as JSON strings: {"value": <actual-value>, "expires": <timestamp>}
      const rawValue = result.rows[0].value;
      const parsed =
        typeof rawValue === "string" ? JSON.parse(rawValue) : rawValue;

      // Check expiration from the JSON payload
      if (parsed.expires && Date.now() > parsed.expires) {
        // Entry was expired, treat as not found
        return undefined;
      }

      return parsed.value as T | undefined;
    } catch (error) {
      logger.error(
        { error, key },
        "CacheManager: Error in getAndDelete operation",
      );
      return undefined;
    }
  }

  /**
   * Delete all entries with keys matching a prefix.
   * Useful for invalidating related cache entries (e.g., all chat models cache).
   *
   * Uses raw SQL with LIKE pattern matching for efficient bulk deletion.
   * Returns the number of entries deleted.
   */
  async deleteByPrefix(prefix: AllowedCacheKey): Promise<number> {
    if (!this.keyv) {
      logger.warn("CacheManager: Not started, skipping deleteByPrefix");
      return 0;
    }

    try {
      // Keyv namespaces keys with "keyv:" prefix
      // Use LIKE with escaped prefix for pattern matching
      const likePattern = `keyv:${prefix}%`;
      const result = await db.execute<{ count: string }>(
        sql`WITH deleted AS (
          DELETE FROM keyv_cache
          WHERE key LIKE ${likePattern}
          RETURNING 1
        )
        SELECT COUNT(*) as count FROM deleted`,
      );

      const deletedCount = Number.parseInt(result.rows[0]?.count ?? "0", 10);
      if (deletedCount > 0) {
        logger.info(
          { prefix, deletedCount },
          "CacheManager: Deleted entries by prefix",
        );
      }
      return deletedCount;
    } catch (error) {
      logger.error({ error, prefix }, "CacheManager: Error deleting by prefix");
      return 0;
    }
  }

  /**
   * Stop the cache manager and close connections.
   * Should be called during graceful shutdown.
   */
  shutdown(): void {
    this.isShuttingDown = true;
    if (this.keyv) {
      this.keyv.disconnect();
      this.keyv = null;
    }
  }
}

export const cacheManager = new CacheManager();

/**
 * Configuration options for LRU cache instances.
 */
interface LRUCacheOptions<T = unknown> {
  /** Maximum number of entries in the cache (required) */
  maxSize: number;
  /** Default TTL in milliseconds for cache entries (optional, defaults to 1 hour) */
  defaultTtl?: number;
  /** Callback fired when an entry is evicted from the cache */
  onEviction?: (key: string, value: unknown) => void;
  /**
   * Optional ceiling on total retained bytes, measured with `sizeOf`.
   *
   * An entry count only approximates memory when entries are of similar size.
   * For a cache holding values whose size varies by orders of magnitude it is
   * not a bound at all — a few hundred large entries can exhaust the heap while
   * the cache still looks nearly empty against `maxSize`. Setting this evicts
   * oldest-written entries until the total fits, making `maxSize` a coarse
   * backstop and this the real bound.
   *
   * Eviction order is QuickLRU's approximation, the same one its count-based
   * eviction uses: reads do not reorder entries within a generation, so this is
   * oldest-written-first rather than strictly least-recently-used.
   *
   * Requires `sizeOf`. Enforcement walks the retained entries on write, so
   * callers that set this should keep `maxSize` modest.
   */
  maxBytes?: number;
  /**
   * Approximate retained size of a value, in bytes. Called once per write, and
   * only when `maxBytes` is set.
   */
  sizeOf?: (value: T) => number;
}

/**
 * Entry stored in the LRU cache with TTL support.
 */
interface LRUCacheEntry<T> {
  value: T;
  expiresAt: number;
  /** Size recorded at write time. Always 0 when the cache is not byte-bounded. */
  bytes: number;
}

/**
 * In-memory LRU cache manager using QuickLRU.
 *
 * Unlike the distributed CacheManager (PostgreSQL-backed), this cache is
 * local to each pod/process and uses LRU eviction for memory management.
 *
 * Use cases:
 * - Caching objects that can't be serialized (e.g., functions, class instances)
 * - High-frequency access patterns where database round-trips are too slow
 * - Data that doesn't need to be shared across pods (with sticky sessions)
 *
 * Features:
 * - LRU eviction when cache is full
 * - TTL support for automatic expiration
 * - Optional eviction callback for cleanup (e.g., closing connections)
 * - Type-safe get/set operations
 */
export class LRUCacheManager<T = unknown> {
  private lruStore: QuickLRU<string, LRUCacheEntry<T>>;
  private defaultTtl: number;
  private onEviction?: (key: string, value: unknown) => void;
  private maxBytes?: number;
  private sizeOf?: (value: T) => number;

  constructor(options: LRUCacheOptions<T>) {
    this.defaultTtl = options.defaultTtl ?? TimeInMs.Hour;
    this.onEviction = options.onEviction;
    this.sizeOf = options.sizeOf;
    this.maxBytes = options.sizeOf ? options.maxBytes : undefined;

    this.lruStore = new QuickLRU<string, LRUCacheEntry<T>>({
      maxSize: options.maxSize,
      onEviction: (key: string, entry: LRUCacheEntry<T>) => {
        if (this.onEviction) {
          this.onEviction(key, entry.value);
        }
      },
    });
  }

  /**
   * Get a value from the cache.
   * Returns undefined if the key doesn't exist or has expired.
   */
  get(key: string): T | undefined {
    const entry = this.lruStore.get(key);
    if (!entry) {
      return undefined;
    }

    // Check if expired
    if (entry.expiresAt > 0 && Date.now() > entry.expiresAt) {
      this.evictExpiredEntry(key, entry);
      return undefined;
    }

    return entry.value;
  }

  /**
   * Set a value in the cache with optional TTL.
   * If the key already exists, it will be overwritten.
   *
   * @param key - Cache key
   * @param value - Value to store
   * @param ttl - Time-to-live in milliseconds (0 = no expiration)
   */
  set(key: string, value: T, ttl?: number): void {
    const effectiveTtl = ttl ?? this.defaultTtl;
    const entry: LRUCacheEntry<T> = {
      value,
      expiresAt: effectiveTtl > 0 ? Date.now() + effectiveTtl : 0,
      bytes: this.maxBytes === undefined ? 0 : (this.sizeOf?.(value) ?? 0),
    };
    this.lruStore.set(key, entry);
    this.enforceByteBudget();
  }

  /**
   * Delete a value from the cache.
   * Returns true if the key existed, false otherwise.
   */
  delete(key: string): boolean {
    return this.lruStore.delete(key);
  }

  /**
   * Check if a key exists in the cache (and is not expired).
   */
  has(key: string): boolean {
    // peek, not get: a pure existence check must not promote the entry's
    // recency, or has()-only keys outlive keys that are actually read.
    const entry = this.lruStore.peek(key);
    if (!entry) {
      return false;
    }
    if (entry.expiresAt > 0 && Date.now() > entry.expiresAt) {
      this.evictExpiredEntry(key, entry);
      return false;
    }
    return true;
  }

  /**
   * Get the current size of the cache.
   */
  get size(): number {
    return this.lruStore.size;
  }

  /**
   * Clear all entries from the cache.
   * Note: This does NOT trigger onEviction callbacks.
   */
  clear(): void {
    this.lruStore.clear();
  }

  /**
   * Delete all entries matching a key prefix.
   */
  deleteByPrefix(prefix: string): void {
    for (const key of this.lruStore.keys()) {
      if (key.startsWith(prefix)) {
        this.lruStore.delete(key);
      }
    }
  }

  /**
   * Get all keys in the cache (for debugging/testing).
   */
  keys(): IterableIterator<string> {
    return this.lruStore.keys();
  }

  /**
   * Total bytes recorded at write time across retained entries. Always 0 when
   * the cache is not byte-bounded.
   */
  get retainedBytes(): number {
    let total = 0;
    for (const [, entry] of this.lruStore.entriesAscending()) {
      total += entry.bytes;
    }
    return total;
  }

  private evictExpiredEntry(key: string, entry: LRUCacheEntry<T>): void {
    if (this.onEviction) {
      this.onEviction(key, entry.value);
    }
    this.lruStore.delete(key);
  }

  /**
   * Evict oldest-written entries until the retained total fits `maxBytes`.
   *
   * Sizes are summed from the retained entries rather than tracked incrementally
   * on purpose: QuickLRU fires `onEviction` for capacity evictions but not for
   * `delete`, so a running counter would drift out of sync with the store and
   * silently under- or over-report. At the modest `maxSize` a byte-bounded cache
   * should use, summing is a handful of integer adds.
   *
   * A value larger than the whole budget is evicted immediately, so callers must
   * not assume a `set` is observable by a later `get` — use the value they wrote.
   */
  private enforceByteBudget(): void {
    const budget = this.maxBytes;
    if (budget === undefined) {
      return;
    }

    const entries = [...this.lruStore.entriesAscending()];
    let total = 0;
    for (const [, entry] of entries) {
      total += entry.bytes;
    }

    for (const [key, entry] of entries) {
      if (total <= budget) {
        break;
      }
      total -= entry.bytes;
      this.lruStore.delete(key);
      if (this.onEviction) {
        this.onEviction(key, entry.value);
      }
    }
  }
}
