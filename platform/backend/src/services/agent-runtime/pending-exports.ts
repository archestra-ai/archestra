import { createHash, randomBytes } from "node:crypto";
import type { A2AActor } from "@/agents/a2a/a2a-base";
import { type AllowedCacheKey, CacheKey, cacheManager } from "@/cache-manager";
import logger from "@/logging";
import { reportAgentRuntimePendingExport } from "@/observability/metrics/agent-runtime";
import { type OpenAppaSession, returnRuntimeValue } from "@/openappa/service";
import {
  crossingRefusal,
  crossRuntimeFile,
  heldFileRefusal,
  reportCrossingRefusal,
  runtimeCrossingRefusal,
} from "./runtime-crossing";
import {
  ProtectedExportBusy,
  type ProtectedExportProgress,
  workspaceTransferTickets,
} from "./workspace-transfers";

/**
 * Protected runtime files that wait for their runtime to finish a tool call.
 *
 * Guardrails cannot release a runtime's bytes to its parent while the runtime
 * has a call open: that call's output is not labelled yet and may be what the
 * file holds. Refusing would leave the parent nothing to act on, so the file
 * is pinned instead and the parent is told to call again.
 *
 * The runtime's next model request is the first moment it has no call open:
 * its tool results are in and its next calls are not out. `drain` crosses the
 * pinned files there. The parent's next call serves what crossed, or crosses
 * it then if the runtime is idle. Nothing ever crosses around the check.
 *
 * Entries live in the shared cache, one per runtime session, so whichever
 * replica serves either side sees them.
 */
class PendingExports {
  /**
   * A protected `read_workspace_file`. Returns the content, or `pending` when
   * the runtime is mid-call; a ruling against the file throws the refusal.
   */
  async crossRead(params: {
    child: OpenAppaSession;
    actor: A2AActor;
    taskId: string;
    path: string;
    encoding: "utf8" | "base64";
    operationId: string;
    read: () => Promise<{ metadata: FileMetadata; content: string }>;
  }): Promise<
    | { kind: "content"; metadata: FileMetadata; content: string }
    | { kind: "pending"; metadata: FileMetadata }
  > {
    const name = entryName({
      kind: "read",
      child: params.child,
      path: params.path,
      encoding: params.encoding,
    });
    const existing = (await this.load(params.child)).get(name);
    if (existing?.kind === "read") {
      const step =
        existing.state === "pending" ? await advanceRead(existing) : existing;
      if (step.state === "pending") {
        await this.replace(params.child, name, existing, step);
        return { kind: "pending", metadata: step.metadata };
      }
      await this.remove(params.child, name);
      if (step.state === "held") throw heldRead(step);
      return { kind: "content", metadata: step.metadata, content: step.value };
    }
    const { metadata, content } = await params.read();
    const crossed = await crossRuntimeFile({
      child: params.child,
      operationId: params.operationId,
      value: content,
    });
    if (crossed.kind === "admitted") {
      return { kind: "content", metadata, content: crossed.value };
    }
    await this.create(params.child, name, {
      kind: "read",
      ...newEntry(params),
      encoding: params.encoding,
      metadata,
      state: "pending",
      value: content,
    });
    return { kind: "pending", metadata };
  }

  /**
   * A protected `transfer_workspace_file` download. Returns the ticket, or
   * `pending` with the pinned version while the runtime is mid-call.
   */
  async crossDownload(params: {
    child: OpenAppaSession;
    actor: A2AActor;
    taskId: string;
    path: string;
    operationId: string;
  }): Promise<
    | {
        kind: "ticket";
        minted: Awaited<
          ReturnType<typeof workspaceTransferTickets.mintDownload>
        >;
      }
    | { kind: "pending"; size: number; sha256: string }
  > {
    const name = entryName({
      kind: "download",
      child: params.child,
      path: params.path,
    });
    const existing = (await this.load(params.child)).get(name);
    if (existing?.kind === "download") {
      let step: PendingDownload;
      try {
        step =
          existing.state === "pending"
            ? await advanceDownload(existing, Number.POSITIVE_INFINITY)
            : existing;
      } catch (error) {
        // The pinned version cannot be read any more (the workspace was
        // reset, or its snapshot swept). The next call pins the current one.
        await this.remove(params.child, name);
        await discard(existing);
        throw error;
      }
      const { snapshot } = step.progress;
      if (step.state === "pending") {
        await this.replace(params.child, name, existing, step);
        return {
          kind: "pending",
          size: snapshot.size,
          sha256: snapshot.sha256,
        };
      }
      await this.remove(params.child, name);
      if (step.state === "held") {
        await discard(step);
        // Counted where the runtime ruled; this only delivers it.
        throw runtimeCrossingRefusal(
          step.reason ??
            "The protected file could not be admitted. No download ticket was issued.",
        );
      }
      try {
        return {
          kind: "ticket",
          minted: await workspaceTransferTickets.mintAdmittedDownload({
            actor: step.actor,
            taskId: step.taskId,
            path: step.path,
            child: step.child,
            progress: step.progress,
          }),
        };
      } catch (error) {
        await discard(step);
        throw error;
      }
    }
    try {
      return {
        kind: "ticket",
        minted: await workspaceTransferTickets.mintDownload({
          actor: params.actor,
          taskId: params.taskId,
          path: params.path,
          crossing: { child: params.child, operationId: params.operationId },
        }),
      };
    } catch (error) {
      if (!(error instanceof ProtectedExportBusy)) throw error;
      await this.create(params.child, name, {
        kind: "download",
        ...newEntry(params),
        state: "pending",
        progress: error.progress,
      });
      const { snapshot } = error.progress;
      return { kind: "pending", size: snapshot.size, sha256: snapshot.sha256 };
    }
  }

  /**
   * Crosses the files pinned for this runtime. Call it when the runtime has no
   * tool call open: on its model request, after its tool results are admitted
   * and before its next calls are released. Never fails the request; a file
   * that cannot cross now stays pinned for the next request or the parent's
   * next call.
   */
  async drain(child: OpenAppaSession): Promise<void> {
    if (!child.parent_id) return;
    try {
      const entries = await this.load(child);
      let budget = DRAIN_BUDGET_BYTES;
      for (const [name, entry] of entries.pendingOldestFirst()) {
        if (entry.kind === "read") {
          const step = await advanceRead(entry);
          await this.replace(child, name, entry, step);
          // Still mid-call: nothing else can cross on this request either.
          if (step.state === "pending") return;
          budget -= Buffer.byteLength(entry.value, "utf8");
        } else {
          const step = await advanceDownload(entry, budget);
          await this.replace(child, name, entry, step);
          budget -=
            (step.progress.digests.length - entry.progress.digests.length) *
            CHUNK_BYTES;
          if (step.state === "pending") return;
        }
        if (budget <= 0) return;
      }
    } catch (error) {
      logger.warn(
        { err: error, sessionId: child.session_id },
        "Could not release protected files pinned for an Agent Runtime",
      );
    }
  }

  private async load(child: OpenAppaSession): Promise<Entries> {
    return new Entries(
      (await cacheManager.get<StoredEntries>(entriesKey(child))) ?? {},
    );
  }

  /** Pins a new entry, unless a concurrent call already pinned this file. */
  private async create(
    child: OpenAppaSession,
    name: string,
    entry: PendingEntry,
  ): Promise<void> {
    await this.mutate(child, (entries) => {
      if (entries.get(name)) return;
      entries.add(name, entry);
      reportAgentRuntimePendingExport("pinned");
    });
  }

  /**
   * Saves `after` only if the stored entry is still `before`. A parent that
   * already took the entry, or a concurrent step that moved it on, wins.
   */
  private async replace(
    child: OpenAppaSession,
    name: string,
    before: PendingEntry,
    after: PendingEntry,
  ): Promise<void> {
    await this.mutate(child, (entries) => {
      if (entries.get(name)?.rev !== before.rev) return;
      entries.set(name, { ...after, rev: newRev() });
    });
  }

  private async remove(child: OpenAppaSession, name: string): Promise<void> {
    await this.mutate(child, (entries) => entries.delete(name));
  }

  /** The only work under the lock is reading and writing the cache entry. */
  private async mutate(
    child: OpenAppaSession,
    change: (entries: Entries) => void,
  ): Promise<void> {
    const key = entriesKey(child);
    await cacheManager.withLock(key, async (cache) => {
      const entries = new Entries((await cache.get<StoredEntries>(key)) ?? {});
      change(entries);
      if (!entries.changed) return;
      if (entries.size === 0) await cache.delete(key);
      else await cache.set(key, entries.toJSON(), ENTRY_TTL_MS);
    });
  }
}

export const pendingExports = new PendingExports();

/** What the parent learns about a file that is waiting for its runtime. */
export function pendingFileNotice(tool: string): string {
  return `The runtime is in the middle of a tool call, so Guardrails cannot release this file yet. This version was pinned. Call ${tool} again with the same arguments after that tool call finishes: the runtime's next step releases it. This is not an error.`;
}

// =============================================================================
// Internal helpers
// =============================================================================

type FileMetadata = Record<string, unknown>;

type EntryBase = {
  id: string;
  /** Changes on every write, so a stale write cannot overwrite a newer one. */
  rev: string;
  attempt: number;
  createdAt: number;
  child: OpenAppaSession;
  actor: A2AActor;
  taskId: string;
  path: string;
};

type PendingRead = EntryBase & {
  kind: "read";
  encoding: "utf8" | "base64";
  metadata: FileMetadata;
  state: "pending" | "admitted" | "held";
  /** Pending: the bytes to cross. Admitted: what crossed. Held: the ruling. */
  value: string;
};

type PendingDownload = EntryBase & {
  kind: "download";
  state: "pending" | "admitted" | "held";
  progress: ProtectedExportProgress;
  /** Held: the refusal the parent gets. */
  reason?: string;
};

type PendingEntry = PendingRead | PendingDownload;
type StoredEntries = Record<string, PendingEntry>;

/** The entries of one runtime session, with the cap and expiry applied. */
class Entries {
  changed = false;
  private readonly entries: Map<string, PendingEntry>;

  constructor(stored: StoredEntries) {
    const now = Date.now();
    this.entries = new Map(
      Object.entries(stored).filter(
        ([, entry]) => now - entry.createdAt < ENTRY_TTL_MS,
      ),
    );
    if (this.entries.size !== Object.keys(stored).length) this.changed = true;
  }

  get size(): number {
    return this.entries.size;
  }

  get(name: string): PendingEntry | undefined {
    return this.entries.get(name);
  }

  set(name: string, entry: PendingEntry): void {
    this.entries.set(name, entry);
    this.changed = true;
  }

  /** Adds an entry, dropping the oldest when the runtime already has the most. */
  add(name: string, entry: PendingEntry): void {
    while (this.entries.size >= MAX_ENTRIES_PER_RUNTIME) {
      const [oldest] = [...this.entries.entries()].sort(
        ([, a], [, b]) => a.createdAt - b.createdAt,
      );
      if (!oldest) break;
      this.entries.delete(oldest[0]);
    }
    this.set(name, entry);
  }

  delete(name: string): void {
    if (this.entries.delete(name)) this.changed = true;
  }

  pendingOldestFirst(): Array<[string, PendingEntry]> {
    return [...this.entries.entries()]
      .filter(([, entry]) => entry.state === "pending")
      .sort(([, a], [, b]) => a.createdAt - b.createdAt);
  }

  toJSON(): StoredEntries {
    return Object.fromEntries(this.entries);
  }
}

function newEntry(params: {
  child: OpenAppaSession;
  actor: A2AActor;
  taskId: string;
  path: string;
}): EntryBase {
  return {
    id: randomBytes(12).toString("hex"),
    rev: newRev(),
    attempt: 0,
    createdAt: Date.now(),
    child: params.child,
    actor: params.actor,
    taskId: params.taskId,
    path: params.path,
  };
}

function newRev(): string {
  return randomBytes(8).toString("hex");
}

async function discard(entry: PendingDownload): Promise<void> {
  await workspaceTransferTickets
    .discardExport({
      actor: entry.actor,
      taskId: entry.taskId,
      transferId: entry.progress.snapshot.transferId,
    })
    .catch(() => undefined);
}

/** Tries once more to cross a pinned read, under an operation id not used before. */
async function advanceRead(entry: PendingRead): Promise<PendingRead> {
  const attempt = entry.attempt + 1;
  const result = await returnRuntimeValue({
    session: entry.child,
    operationId: `file-read:${entry.id}:${attempt}`,
    value: entry.value,
  });
  if (result.kind === "admitted") {
    reportAgentRuntimePendingExport("admitted");
    return { ...entry, attempt, state: "admitted", value: result.value };
  }
  if (result.busy) return { ...entry, attempt };
  reportAgentRuntimePendingExport("held");
  return { ...entry, attempt, state: "held", value: result.reason };
}

/** Crosses more of a pinned download, at most `budgetBytes` of it. */
async function advanceDownload(
  entry: PendingDownload,
  budgetBytes: number,
): Promise<PendingDownload> {
  try {
    const advanced = await workspaceTransferTickets.advanceExport({
      actor: entry.actor,
      taskId: entry.taskId,
      path: entry.path,
      child: entry.child,
      operationBase: `file-export:${entry.id}`,
      progress: entry.progress,
      budgetBytes,
    });
    const attempt = entry.attempt + 1;
    if (advanced.kind === "waiting") {
      return { ...entry, attempt, progress: advanced.progress };
    }
    reportAgentRuntimePendingExport("admitted");
    return {
      ...entry,
      attempt,
      state: "admitted",
      progress: advanced.progress,
    };
  } catch (error) {
    const refusal = crossingRefusal(error);
    if (refusal === undefined) throw error;
    reportAgentRuntimePendingExport("held");
    return { ...entry, state: "held", reason: refusal };
  }
}

function heldRead(entry: PendingRead): Error {
  return runtimeCrossingRefusal(
    reportCrossingRefusal({
      reason: "held",
      message: heldFileRefusal(entry.value),
      childSessionId: entry.child.session_id,
      parentSessionId: entry.child.parent_id,
    }),
  );
}

function entriesKey(child: OpenAppaSession): AllowedCacheKey {
  return `${CacheKey.AgentRuntimePendingExports}-${digest(
    `${child.organization_id}\n${child.session_id}`,
  )}`;
}

/** One file of one parent: a later call for the same file finds its entry. */
function entryName(params: {
  kind: "read" | "download";
  child: OpenAppaSession;
  path: string;
  encoding?: string;
}): string {
  return digest(
    [
      params.kind,
      params.child.parent_id ?? "",
      params.path,
      params.encoding ?? "",
    ].join("\n"),
  );
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

/** Matches the protected export chunk: one drained chunk spends this much. */
const CHUNK_BYTES = 4 * 1024 * 1024;
/** What one runtime request spends releasing files, so its own latency stays small. */
const DRAIN_BUDGET_BYTES = 8 * 1024 * 1024;
/** Longer than any tool call worth waiting for; the in-pod snapshot lives six hours. */
const ENTRY_TTL_MS = 2 * 60 * 60 * 1000;
const MAX_ENTRIES_PER_RUNTIME = 16;
