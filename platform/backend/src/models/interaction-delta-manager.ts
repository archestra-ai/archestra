import { createHash } from "node:crypto";
import { isClaudeSessionSource, TimeInMs } from "@archestra/shared";
import { and, desc, eq, lt, sql } from "drizzle-orm";
import { LRUCacheManager } from "@/cache-manager";
import db, { schema } from "@/database";
import type { InsertInteraction } from "@/types";

/**
 * Delta-encoding for Claude Code / Claude Desktop LLM-proxy interactions.
 *
 * Every agentic request re-sends the whole conversation, so storing the full
 * `request`/`processedRequest` on every row is Θ(N²) per session. This manager
 * stores only the suffix of `messages` that is new versus the row's parent and
 * rebuilds the full request on read by walking the parent chain — Θ(N).
 *
 * It is the single source of truth for the delta format and is used on BOTH the
 * write path (`encodeOnWrite` from `InteractionModel.create`) and the read path
 * (`reconstructRow` / `reconstructMany`). A per-pod LRU is the fast path; the DB
 * (recursive CTE up `parent_id`) is the source of truth, so results are identical
 * with a cold cache or across pods.
 *
 * Non-Claude / non-Anthropic interactions are returned untouched (full storage),
 * preserving existing behavior.
 */

/** Minimal view of an Anthropic-style messages request. */
interface MessagesRequest {
  messages?: unknown[];
  [key: string]: unknown;
}

interface FullRequest {
  request: unknown;
  processedRequest: unknown;
}

/** Cached tip of a (sessionId, threadId) branch — the most recent row. */
interface CachedTip {
  id: string;
  requestLastMessageIdx: number;
  requestLastMessageHash: string;
}

/** Cache entry returned by encodeOnWrite to commit once the new row id is known. */
interface DeltaTipUpdate {
  key: string;
  requestLastMessageIdx: number;
  requestLastMessageHash: string;
  fullRequest: unknown;
  fullProcessed: unknown;
}

/**
 * Top-level request/processedRequest fields that are large and near-constant
 * across a session (the tool-schema array and the system prompt). On a child
 * row they are dropped when byte-identical to the parent's reconstructed value
 * and re-inherited on read — the same prefix-delta idea applied to whole fields
 * instead of a message suffix.
 *
 * Caveat: inheritance is "carry the parent's value forward when the field is
 * absent", so a field that legitimately goes present -> absent mid-chain would
 * be re-inherited rather than dropped. Claude Code never removes `tools`/`system`
 * mid-conversation, so this can't happen in practice; revisit if that changes.
 */
const INHERITABLE_ENVELOPE_FIELDS = ["tools", "system"] as const;

interface EncodedInteraction {
  values: InsertInteraction;
  tip: DeltaTipUpdate | null;
}

/** Row shape loaded for reconstruction (camelCase mapping of the chain CTE). */
interface ChainRow {
  id: string;
  parentId: string | null;
  threadId: string | null;
  requestSharedPrefix: number | null;
  processedRequestSharedPrefix: number | null;
  request: unknown;
  processedRequest: unknown;
}

/** Subset of an interaction row the read path passes to reconstructMany. */
interface ReconstructableRow {
  id: string;
  threadId: string | null;
  request: unknown;
  processedRequest?: unknown;
}

const CACHE_MAX_SIZE = 5000;

class InteractionDeltaManager {
  /** Branch tip per (sessionId, threadId) — write-path parent fast path. */
  private static tipCache = new LRUCacheManager<CachedTip>({
    maxSize: CACHE_MAX_SIZE,
    defaultTtl: TimeInMs.Hour,
  });

  /** Reconstructed full request/processedRequest per interaction id — read-path memo. */
  private static reconstructCache = new LRUCacheManager<FullRequest>({
    maxSize: CACHE_MAX_SIZE,
    defaultTtl: TimeInMs.Hour,
  });

  /**
   * Delta-encode an interaction before insert. Returns the row to persist and a
   * tip update to commit (via `commitTip`) once the inserted id is known.
   * Returns the row unchanged (tip null) when not delta-eligible.
   */
  static async encodeOnWrite(
    data: InsertInteraction,
  ): Promise<EncodedInteraction> {
    if (!InteractionDeltaManager.isEligible(data)) {
      return { values: data, tip: null };
    }

    const request = data.request as MessagesRequest;
    const messages = request.messages as unknown[];
    const threadId = hashMessage(messages[0]);
    const lastIdx = messages.length - 1;
    const lastHash = hashMessage(messages[lastIdx]);
    const key = tipKey(data.sessionId as string, threadId);

    const parent = await InteractionDeltaManager.resolveParent(key, {
      sessionId: data.sessionId as string,
      threadId,
      messages,
    });

    let requestSharedPrefix: number;
    let parentId: string | null;
    let deltaMessages: unknown[];
    if (parent) {
      requestSharedPrefix = parent.requestLastMessageIdx + 1;
      parentId = parent.id;
      deltaMessages = messages.slice(requestSharedPrefix);
    } else {
      // No parent (first request / sub-agent / post-compaction / aged-out branch):
      // persist a complete-request "head" row. Still delta-format (threadId + last
      // message metadata set) so the next request resolves it as parent.
      requestSharedPrefix = 0;
      parentId = null;
      deltaMessages = messages;
    }

    // Drop `tools`/`system` from the stored request when byte-identical to the
    // parent's — reconstruction re-inherits them. Head rows (no parent) keep the
    // full envelope, so every thread retains one complete copy.
    const requestToStore = omitInheritedFields(
      { ...request, messages: deltaMessages },
      parent?.fullRequest,
    );

    // processedRequest is delta-encoded independently against the parent's
    // reconstructed processedRequest (its message array can differ from request).
    const processedRequest = data.processedRequest as MessagesRequest | null;
    const processedMessages = getMessages(processedRequest);
    let processedRequestSharedPrefix: number | null;
    let processedToStore: unknown;
    if (processedMessages) {
      const parentProcessed = parent
        ? getMessages(parent.fullProcessedRequest)
        : null;
      const prefix = parentProcessed
        ? longestCommonPrefixLen(parentProcessed, processedMessages)
        : 0;
      processedRequestSharedPrefix = prefix;
      processedToStore = omitInheritedFields(
        {
          ...(processedRequest as MessagesRequest),
          messages: processedMessages.slice(prefix),
        },
        parent?.fullProcessedRequest,
      );
    } else {
      // processedRequest null or non-message-shaped — store as-is, no reconstruction.
      processedRequestSharedPrefix = null;
      processedToStore = data.processedRequest;
    }

    const values: InsertInteraction = {
      ...data,
      request: requestToStore as InsertInteraction["request"],
      processedRequest:
        processedToStore as InsertInteraction["processedRequest"],
      threadId,
      parentId,
      requestSharedPrefix,
      processedRequestSharedPrefix,
      requestLastMessageIdx: lastIdx,
    };

    const tip: DeltaTipUpdate = {
      key,
      requestLastMessageIdx: lastIdx,
      requestLastMessageHash: lastHash,
      // Tip carries the FULL (un-omitted) request so it seeds this row's
      // reconstruction cache and is the inheritance source for the next request.
      fullRequest: { ...request, messages },
      fullProcessed: processedMessages
        ? {
            ...(processedRequest as MessagesRequest),
            messages: processedMessages,
          }
        : null,
    };

    return { values, tip };
  }

  /**
   * Populate the caches after the row is inserted and its id is known. Makes the
   * next request on the branch O(1) and an immediate read of this row a cache hit.
   */
  static commitTip(id: string, tip: DeltaTipUpdate): void {
    InteractionDeltaManager.tipCache.set(tip.key, {
      id,
      requestLastMessageIdx: tip.requestLastMessageIdx,
      requestLastMessageHash: tip.requestLastMessageHash,
    });
    InteractionDeltaManager.reconstructCache.set(id, {
      request: tip.fullRequest,
      processedRequest: tip.fullProcessed,
    });
  }

  /** Reconstruct the full request/processedRequest for a single interaction row. */
  static async reconstructRow(row: ReconstructableRow): Promise<FullRequest> {
    if (row.threadId === null) {
      // Legacy / non-delta row stores full request already.
      return { request: row.request, processedRequest: row.processedRequest };
    }
    const cached = InteractionDeltaManager.reconstructCache.get(row.id);
    if (cached) {
      return cached;
    }
    const map = await InteractionDeltaManager.loadChain([row.id]);
    return (
      InteractionDeltaManager.foldFor(row.id, map) ?? {
        request: row.request,
        processedRequest: row.processedRequest,
      }
    );
  }

  /**
   * Batch-reconstruct many rows (e.g. a paginated page). Loads every needed
   * ancestor in one recursive CTE; legacy rows and cache hits issue no DB work.
   */
  static async reconstructMany(
    rows: ReconstructableRow[],
  ): Promise<Map<string, FullRequest>> {
    const result = new Map<string, FullRequest>();
    const needLoad: string[] = [];

    for (const row of rows) {
      if (row.threadId === null) {
        result.set(row.id, {
          request: row.request,
          processedRequest: row.processedRequest,
        });
        continue;
      }
      const cached = InteractionDeltaManager.reconstructCache.get(row.id);
      if (cached) {
        result.set(row.id, cached);
        continue;
      }
      needLoad.push(row.id);
    }

    if (needLoad.length > 0) {
      const map = await InteractionDeltaManager.loadChain(needLoad);
      for (const id of needLoad) {
        const folded = InteractionDeltaManager.foldFor(id, map);
        if (folded) {
          result.set(id, folded);
        }
      }
    }

    return result;
  }

  /** Clear both caches. Intended for tests that exercise the cold-cache DB path. */
  static reset(): void {
    InteractionDeltaManager.tipCache.clear();
    InteractionDeltaManager.reconstructCache.clear();
  }

  private static isEligible(data: InsertInteraction): boolean {
    if (data.sessionId == null) return false;
    if (!isClaudeSessionSource(data.sessionSource ?? null)) {
      return false;
    }
    if (data.type !== "anthropic:messages") return false;
    const messages = getMessages(data.request);
    return messages !== null && messages.length >= 1;
  }

  private static async resolveParent(
    key: string,
    params: { sessionId: string; threadId: string; messages: unknown[] },
  ): Promise<{
    id: string;
    requestLastMessageIdx: number;
    fullRequest: unknown;
    fullProcessedRequest: unknown;
  } | null> {
    const { sessionId, threadId, messages } = params;

    const cached = InteractionDeltaManager.tipCache.get(key);
    if (cached && InteractionDeltaManager.isValidParent(cached, messages)) {
      return InteractionDeltaManager.parentRef(
        cached.id,
        cached.requestLastMessageIdx,
      );
    }

    // DB fallback. Fetch a small candidate set (NOT limit 1): under forking,
    // concurrent branches share the threadId and reach the same message index, so
    // the most recent candidate can belong to a different branch. We require a
    // strict prefix (`request_last_message_idx < length - 1`) and then pick the
    // most recent candidate whose stored last message actually matches the
    // incoming request at that index. The candidate's delta always ends at the
    // full request's last message, so `request -> 'messages' -> -1` is exactly the
    // message at request_last_message_idx — no separate stored hash needed.
    const candidates = await db
      .select({
        id: schema.interactionsTable.id,
        requestLastMessageIdx: schema.interactionsTable.requestLastMessageIdx,
        lastMessage: sql<unknown>`${schema.interactionsTable.request} -> 'messages' -> -1`,
      })
      .from(schema.interactionsTable)
      .where(
        and(
          eq(schema.interactionsTable.sessionId, sessionId),
          eq(schema.interactionsTable.threadId, threadId),
          lt(
            schema.interactionsTable.requestLastMessageIdx,
            messages.length - 1,
          ),
        ),
      )
      .orderBy(
        // seq is tie-proof insertion order; createdAt kept as a fallback for
        // any pre-backfill edge. Same-instant interactions are routine under
        // streaming, and a wrong "latest" pick corrupts the delta chain.
        desc(schema.interactionsTable.seq),
        desc(schema.interactionsTable.createdAt),
      )
      .limit(16);

    const chosen = candidates.find(
      (c) =>
        c.requestLastMessageIdx !== null &&
        hashMessage(c.lastMessage) ===
          hashMessage(messages[c.requestLastMessageIdx]),
    );
    if (!chosen || chosen.requestLastMessageIdx === null) {
      return null;
    }

    return InteractionDeltaManager.parentRef(
      chosen.id,
      chosen.requestLastMessageIdx,
    );
  }

  /**
   * Resolve a chosen parent id into the reference encodeOnWrite needs: its last
   * message index plus its fully reconstructed request/processedRequest (the
   * source for message-prefix and tools/system inheritance). Reconstruction is a
   * cache hit on the warm write path; cold only after eviction.
   */
  private static async parentRef(
    id: string,
    requestLastMessageIdx: number,
  ): Promise<{
    id: string;
    requestLastMessageIdx: number;
    fullRequest: unknown;
    fullProcessedRequest: unknown;
  }> {
    const full = await InteractionDeltaManager.reconstructById(id);
    return {
      id,
      requestLastMessageIdx,
      fullRequest: full?.request ?? null,
      fullProcessedRequest: full?.processedRequest ?? null,
    };
  }

  private static isValidParent(
    cached: CachedTip,
    messages: unknown[],
  ): boolean {
    return (
      cached.requestLastMessageIdx < messages.length - 1 &&
      hashMessage(messages[cached.requestLastMessageIdx]) ===
        cached.requestLastMessageHash
    );
  }

  private static async reconstructById(
    id: string,
  ): Promise<FullRequest | null> {
    const cached = InteractionDeltaManager.reconstructCache.get(id);
    if (cached) return cached;
    const map = await InteractionDeltaManager.loadChain([id]);
    return InteractionDeltaManager.foldFor(id, map);
  }

  /** Load each seed row plus all of its ancestors (deduped) in one query. */
  private static async loadChain(
    seedIds: string[],
  ): Promise<Map<string, ChainRow>> {
    const seedList = sql.join(
      seedIds.map((id) => sql`${id}::uuid`),
      sql`, `,
    );
    const rows = await db.execute<{
      id: string;
      parent_id: string | null;
      thread_id: string | null;
      request_shared_prefix: number | null;
      processed_request_shared_prefix: number | null;
      request: unknown;
      processed_request: unknown;
    }>(sql`
      WITH RECURSIVE chain AS (
        SELECT id, parent_id, thread_id, request_shared_prefix,
               processed_request_shared_prefix, request, processed_request
        FROM interactions
        WHERE id IN (${seedList})
        UNION
        SELECT i.id, i.parent_id, i.thread_id, i.request_shared_prefix,
               i.processed_request_shared_prefix, i.request, i.processed_request
        FROM interactions i
        JOIN chain c ON i.id = c.parent_id
      )
      SELECT id, parent_id, thread_id, request_shared_prefix,
             processed_request_shared_prefix, request, processed_request
      FROM chain
    `);

    const map = new Map<string, ChainRow>();
    for (const row of rows.rows) {
      map.set(row.id, {
        id: row.id,
        parentId: row.parent_id,
        threadId: row.thread_id,
        requestSharedPrefix: row.request_shared_prefix,
        processedRequestSharedPrefix: row.processed_request_shared_prefix,
        request: row.request,
        processedRequest: row.processed_request,
      });
    }
    return map;
  }

  /** Fold a row's parent chain into its full request, memoizing each ancestor. */
  private static foldFor(
    id: string,
    map: Map<string, ChainRow>,
  ): FullRequest | null {
    const target = map.get(id);
    if (!target) return null;

    if (target.threadId === null) {
      const full = {
        request: target.request,
        processedRequest: target.processedRequest,
      };
      InteractionDeltaManager.reconstructCache.set(id, full);
      return full;
    }

    // Walk head -> target.
    const chain: ChainRow[] = [];
    let cursor: ChainRow | undefined = target;
    while (cursor) {
      chain.push(cursor);
      if (cursor.parentId === null) break;
      cursor = map.get(cursor.parentId);
    }
    chain.reverse();

    let requestMessages: unknown[] | null = null;
    let processedMessages: unknown[] | null = null;
    // The previous row's reconstructed full request — the source for inheriting
    // omitted `tools`/`system`. Null at the head (which stores the full envelope).
    let parentFull: FullRequest | null = null;

    for (const row of chain) {
      const cached = InteractionDeltaManager.reconstructCache.get(row.id);
      if (cached) {
        requestMessages = getMessages(cached.request) ?? [];
        processedMessages = getMessages(cached.processedRequest);
        parentFull = cached;
        continue;
      }

      if (requestMessages === null) {
        // Head row stores full messages.
        requestMessages = [...(getMessages(row.request) ?? [])];
        processedMessages = getMessages(row.processedRequest);
      } else {
        requestMessages = requestMessages
          .slice(0, row.requestSharedPrefix ?? 0)
          .concat(getMessages(row.request) ?? []);
        if (row.processedRequestSharedPrefix === null) {
          processedMessages = getMessages(row.processedRequest);
        } else {
          processedMessages = (processedMessages ?? [])
            .slice(0, row.processedRequestSharedPrefix)
            .concat(getMessages(row.processedRequest) ?? []);
        }
      }

      const full = buildFull(
        row,
        requestMessages,
        processedMessages,
        parentFull,
      );
      InteractionDeltaManager.reconstructCache.set(row.id, full);
      parentFull = full;
    }

    return InteractionDeltaManager.reconstructCache.get(id) ?? null;
  }
}

function tipKey(sessionId: string, threadId: string): string {
  return `${sessionId}::${threadId}`;
}

function getMessages(request: unknown): unknown[] | null {
  if (request && typeof request === "object") {
    const messages = (request as MessagesRequest).messages;
    if (Array.isArray(messages)) return messages;
  }
  return null;
}

function buildFull(
  row: ChainRow,
  requestMessages: unknown[],
  processedMessages: unknown[] | null,
  parentFull: FullRequest | null,
): FullRequest {
  const request = reconstructEnvelope(
    row.request,
    parentFull?.request,
    requestMessages,
  );
  const rawProcessed = row.processedRequest;
  let processedRequest: unknown;
  if (rawProcessed == null) {
    processedRequest = null;
  } else if (Array.isArray((rawProcessed as MessagesRequest).messages)) {
    processedRequest = reconstructEnvelope(
      rawProcessed,
      parentFull?.processedRequest,
      processedMessages ?? [],
    );
  } else {
    processedRequest = rawProcessed;
  }
  return { request, processedRequest };
}

/**
 * Rebuild a request/processedRequest envelope: the stored (delta) object with
 * its folded `messages`, plus any inheritable field (`tools`/`system`) that the
 * stored object dropped re-filled from the parent's reconstructed envelope.
 */
function reconstructEnvelope(
  stored: unknown,
  parent: unknown,
  messages: unknown[],
): unknown {
  const out = { ...(stored as Record<string, unknown>) };
  if (parent && typeof parent === "object" && !Array.isArray(parent)) {
    const parentObj = parent as Record<string, unknown>;
    for (const field of INHERITABLE_ENVELOPE_FIELDS) {
      if (!(field in out) && field in parentObj) {
        out[field] = parentObj[field];
      }
    }
  }
  out.messages = messages;
  return out;
}

/**
 * Drop each inheritable field that is byte-identical (key-order-insensitive) to
 * the parent's, so reconstruction re-inherits it. No parent / no match keeps the
 * field, so a head row or a genuinely-changed field is always stored in full.
 */
function omitInheritedFields(
  stored: Record<string, unknown>,
  parentEnvelope: unknown,
): Record<string, unknown> {
  if (
    !parentEnvelope ||
    typeof parentEnvelope !== "object" ||
    Array.isArray(parentEnvelope)
  ) {
    return stored;
  }
  const parentObj = parentEnvelope as Record<string, unknown>;
  const out = { ...stored };
  for (const field of INHERITABLE_ENVELOPE_FIELDS) {
    if (
      field in out &&
      field in parentObj &&
      stableStringify(out[field]) === stableStringify(parentObj[field])
    ) {
      delete out[field];
    }
  }
  return out;
}

function longestCommonPrefixLen(a: unknown[], b: unknown[]): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  for (; i < n; i++) {
    if (hashMessage(a[i]) !== hashMessage(b[i])) break;
  }
  return i;
}

/** Stable (key-sorted) sha256 so equal messages hash equal regardless of key order. */
function hashMessage(message: unknown): string {
  return createHash("sha256")
    .update(stableStringify(normalizeMessageForHash(message)))
    .digest("hex");
}

/**
 * Canonicalize a message before hashing so the *same logical message* hashes
 * equal across requests, even though Anthropic prompt caching rewrites it.
 *
 * Claude Code marks the most recent message(s) with the moving cache breakpoint
 * `cache_control: { type: "ephemeral" }`, and attaching that marker also wraps a
 * plain-string `content` into a single text block. One turn later the same
 * message is no longer the breakpoint, so the marker is gone and `content` is a
 * bare string again. Hashing the raw bytes therefore made every prefix/parent
 * match fail — so `resolveParent` returned null, `parent_id` was always NULL,
 * and every row stored the full conversation instead of a delta.
 *
 * Normalization is hash-only: stored request bytes are left untouched, so
 * reconstruction still returns each request's persisted content verbatim.
 */
function normalizeMessageForHash(message: unknown): unknown {
  const stripped = stripEphemeral(message);
  if (stripped && typeof stripped === "object" && !Array.isArray(stripped)) {
    const msg = stripped as Record<string, unknown>;
    const content = msg.content;
    // A single `{ type: "text", text }` block is equivalent to a bare string
    // `content`; collapse it so the breakpoint and non-breakpoint forms match.
    if (Array.isArray(content) && content.length === 1) {
      const block = content[0];
      if (
        block &&
        typeof block === "object" &&
        !Array.isArray(block) &&
        (block as Record<string, unknown>).type === "text" &&
        typeof (block as Record<string, unknown>).text === "string" &&
        Object.keys(block as Record<string, unknown>).length === 2
      ) {
        return { ...msg, content: (block as { text: string }).text };
      }
    }
  }
  return stripped;
}

/**
 * Recursively drop any child object that carries `type: "ephemeral"` (the moving
 * cache breakpoint, e.g. `cache_control: { type: "ephemeral", ttl: "1h" }`),
 * keyed on the marker shape rather than the `cache_control` key name.
 */
function stripEphemeral(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripEphemeral);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (isEphemeralObject(v)) continue;
      out[key] = stripEphemeral(v);
    }
    return out;
  }
  return value;
}

/** True for a plain object whose `type` is `"ephemeral"`. */
function isEphemeralObject(value: unknown): boolean {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).type === "ephemeral"
  );
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

export default InteractionDeltaManager;
