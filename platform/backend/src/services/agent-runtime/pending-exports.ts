import { createHash, randomBytes } from "node:crypto";
import type { A2AActor } from "@/agents/a2a/a2a-base";
import { type AllowedCacheKey, CacheKey, cacheManager } from "@/cache-manager";
import logger from "@/logging";
import { AgentRunModel, AgentWorkspaceModel } from "@/models";
import { reportAgentRuntimePendingExport } from "@/observability/metrics/agent-runtime";
import {
  loadChildReturns,
  type OpenAppaSession,
  returnRuntimeValue,
} from "@/openappa/service";
import {
  crossingRefusal,
  crossRuntimeFile,
  heldFileRefusal,
  reportCrossingRefusal,
  runtimeCrossingRefusal,
} from "./runtime-crossing";
import { authorizeAgentWorkspaceAccess } from "./workspace-files";
import {
  nextProtectedChunkBytes,
  operationNonce,
  PinnedVersionGone,
  ProtectedExportBusy,
  type ProtectedExportProgress,
  workspaceTransferTickets,
} from "./workspace-transfers";

/**
 * Protected runtime files that wait for their runtime to finish a tool call.
 *
 * Guardrails cannot release a runtime's bytes to its parent while the runtime
 * has a call open: that call's output is not labelled yet and may be what the
 * file holds. Refusing would leave the parent nothing to act on, so the
 * version is pinned in the runtime's workspace instead and the parent is told
 * to call again. Until something crosses, the parent learns nothing about the
 * file, not even its size.
 *
 * The runtime's next model request is the first moment it has no call open:
 * its tool results are in and its next calls are not out. `drain` crosses the
 * pinned files there. The parent's next call serves what crossed, or crosses
 * it then if the runtime has gone idle. Nothing ever crosses around the check.
 *
 * Only small entries live in the shared cache, one record per runtime session,
 * so whichever replica serves either side sees them. File bytes stay pinned in
 * the workspace, and what crossed is kept by the runtime's own store.
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
    | { kind: "pending" }
  > {
    const name = entryName({ kind: "read", ...params });
    const existing = await this.liveEntry(params.child, name);
    if (existing?.kind === "read") {
      // The caller must still be able to use this workspace right now.
      await authorizeAgentWorkspaceAccess(params);
      const served = await this.continueRead(params.child, name, existing);
      if (served) return served;
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
    if (!(await runtimeIsMidTurn(params.taskId))) throw stoppedMidCall(params);
    const snapshot = await workspaceTransferTickets.pinFile(params);
    await this.pin(params.child, name, {
      kind: "read",
      ...newEntry(params),
      encoding: params.encoding,
      progress: { snapshot, digests: [] },
    });
    return { kind: "pending" };
  }

  /**
   * A protected `transfer_workspace_file` download. Returns the ticket, or
   * `pending` while the runtime is mid-call.
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
    | { kind: "pending" }
  > {
    const name = entryName({ kind: "download", ...params });
    const existing = await this.liveEntry(params.child, name);
    if (existing?.kind === "download") {
      await authorizeAgentWorkspaceAccess(params);
      const served = await this.continueDownload(params.child, name, existing);
      if (served) return served;
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
      if (!(await runtimeIsMidTurn(params.taskId))) {
        await discardPinned({ ...params, progress: error.progress });
        throw stoppedMidCall(params);
      }
      await this.pin(params.child, name, {
        kind: "download",
        ...newEntry(params),
        progress: error.progress,
      });
      return { kind: "pending" };
    }
  }

  /**
   * Crosses the files pinned for this runtime. Call it when the runtime has no
   * tool call open: on its model request, after its tool results are admitted
   * and before its next calls are released. Never fails the request and keeps
   * to a small budget; a file that cannot cross now stays pinned for the next
   * request or the parent's next call. The first file always gets its turn;
   * the files after it share the byte budget, one chunk per download. The
   * deadline is checked before each file, so one already crossing finishes
   * (a slow pod read gives up after its own timeout) and the rest wait.
   */
  async drain(child: OpenAppaSession): Promise<void> {
    if (!child.parent_id) return;
    const started = Date.now();
    let entries: Array<[string, PendingEntry]>;
    try {
      entries = (await this.load(child)).pendingOldestFirst();
    } catch (error) {
      logger.warn(
        { err: error, sessionId: child.session_id },
        "Could not read the protected files pinned for an Agent Runtime",
      );
      return;
    }
    let spentBytes = 0;
    for (const [name, entry] of entries) {
      if (Date.now() - started > DRAIN_DEADLINE_MS) return;
      const size =
        entry.kind === "read"
          ? entry.progress.snapshot.size
          : nextProtectedChunkBytes(entry.progress);
      if (spentBytes > 0 && spentBytes + size > DRAIN_BYTES) continue;
      try {
        const step =
          entry.kind === "read"
            ? await advanceRead(entry, { drain: true })
            : await advanceDownload(entry, { drain: true });
        spentBytes += size;
        await this.replace(child, name, entry, step.entry);
        await afterStep(entry, step.entry);
        // Still mid-call: nothing else can cross on this request either.
        if (step.busy) return;
      } catch (error) {
        logger.warn(
          { err: error, sessionId: child.session_id, entryId: entry.id },
          "Could not release a protected file pinned for an Agent Runtime",
        );
        await this.failed(child, name, entry).catch(() => undefined);
      }
    }
  }

  // ===========================================================================
  // Private
  // ===========================================================================

  /** Serves or advances a read pinned earlier; undefined means pin afresh. */
  private async continueRead(
    child: OpenAppaSession,
    name: string,
    entry: PendingRead,
  ): Promise<
    | { kind: "content"; metadata: FileMetadata; content: string }
    | { kind: "pending" }
    | undefined
  > {
    if (entry.state === "admitted") {
      const content = await admittedRead(entry);
      await this.remove(child, name, entry);
      return content === undefined
        ? undefined
        : { kind: "content", metadata: servedMetadata(entry), content };
    }
    if (entry.state === "held") {
      await this.remove(child, name, entry);
      throw runtimeCrossingRefusal(entry.reason ?? heldFileRefusal("held"));
    }
    let step: Awaited<ReturnType<typeof advanceRead>>;
    try {
      step = await advanceRead(entry, { drain: false });
    } catch (error) {
      if (!(error instanceof PinnedVersionGone)) throw error;
      await this.remove(child, name, entry);
      await discardPinned(entry);
      return undefined;
    }
    if (step.entry.state === "pending") {
      if (!(await runtimeIsMidTurn(entry.taskId))) {
        await this.remove(child, name, entry);
        await discardPinned(entry);
        throw stoppedMidCall(entry);
      }
      await this.replace(child, name, entry, step.entry);
      return { kind: "pending" };
    }
    await this.remove(child, name, entry);
    await discardPinned(entry);
    if (step.entry.state === "held")
      throw runtimeCrossingRefusal(
        step.entry.reason ?? heldFileRefusal("held"),
      );
    return {
      kind: "content",
      metadata: servedMetadata(entry),
      content: step.admitted ?? "",
    };
  }

  /** Serves or advances a download pinned earlier; undefined means pin afresh. */
  private async continueDownload(
    child: OpenAppaSession,
    name: string,
    entry: PendingDownload,
  ): Promise<
    | {
        kind: "ticket";
        minted: Awaited<
          ReturnType<typeof workspaceTransferTickets.mintDownload>
        >;
      }
    | { kind: "pending" }
    | undefined
  > {
    let current = entry;
    if (current.state === "pending") {
      let step: Awaited<ReturnType<typeof advanceDownload>>;
      try {
        step = await advanceDownload(current, { drain: false });
      } catch (error) {
        if (!(error instanceof PinnedVersionGone)) throw error;
        await this.remove(child, name, entry);
        await discardPinned(entry);
        return undefined;
      }
      if (step.entry.state === "pending") {
        if (!(await runtimeIsMidTurn(entry.taskId))) {
          await this.remove(child, name, entry);
          await discardPinned(entry);
          throw stoppedMidCall(entry);
        }
        await this.replace(child, name, entry, step.entry);
        return { kind: "pending" };
      }
      current = step.entry;
    }
    await this.remove(child, name, entry);
    if (current.state === "held") {
      await discardPinned(current);
      throw runtimeCrossingRefusal(
        current.reason ??
          "The protected file could not be admitted. No download ticket was issued.",
      );
    }
    try {
      return {
        kind: "ticket",
        minted: await workspaceTransferTickets.mintAdmittedDownload({
          actor: current.actor,
          taskId: current.taskId,
          path: current.path,
          child: current.child,
          progress: current.progress,
        }),
      };
    } catch (error) {
      await discardPinned(current);
      throw error;
    }
  }

  private async liveEntry(
    child: OpenAppaSession,
    name: string,
  ): Promise<PendingEntry | undefined> {
    return (await this.load(child)).get(name);
  }

  private async load(child: OpenAppaSession): Promise<Entries> {
    return new Entries(
      (await cacheManager.get<StoredEntries>(entriesKey(child))) ?? {},
    );
  }

  /** Pins a new entry, unless a concurrent call already pinned this file. */
  private async pin(
    child: OpenAppaSession,
    name: string,
    entry: PendingEntry,
  ): Promise<void> {
    let created = false;
    const evicted = await this.mutate(child, (entries) => {
      if (entries.get(name)) return;
      entries.add(name, entry);
      created = true;
    });
    if (created) reportAgentRuntimePendingExport("pinned");
    else await discardPinned(entry);
    await Promise.all(evicted.map(discardPinned));
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
    const evicted = await this.mutate(child, (entries) => {
      if (entries.get(name)?.rev !== before.rev) return;
      entries.set(name, { ...after, rev: newRev() });
    });
    await Promise.all(evicted.map(discardPinned));
  }

  /** Removes `entry`, unless a concurrent call already replaced it. */
  private async remove(
    child: OpenAppaSession,
    name: string,
    entry: PendingEntry,
  ): Promise<void> {
    const evicted = await this.mutate(child, (entries) => {
      if (entries.get(name)?.rev === entry.rev) entries.delete(name);
    });
    await Promise.all(evicted.map(discardPinned));
  }

  /** Counts a failed drain; a pin that keeps failing is given up as held. */
  private async failed(
    child: OpenAppaSession,
    name: string,
    entry: PendingEntry,
  ): Promise<void> {
    const failures = entry.failures + 1;
    const after: PendingEntry =
      failures < MAX_DRAIN_FAILURES
        ? { ...entry, failures }
        : {
            ...entry,
            failures,
            state: "held",
            decidedAt: Date.now(),
            reason:
              "The pinned version of this file could not be read from the runtime. Call the tool again to pin its current version.",
          };
    await this.replace(child, name, entry, after);
    if (after.state === "held") await discardPinned(entry);
  }

  /**
   * The only work under the lock is reading and writing the cache entry.
   * Returns the entries that expired or were evicted, for their pins to be
   * released outside the lock.
   */
  private async mutate(
    child: OpenAppaSession,
    change: (entries: Entries) => void,
  ): Promise<PendingEntry[]> {
    const key = entriesKey(child);
    return cacheManager.withLock(key, async (cache) => {
      const entries = new Entries((await cache.get<StoredEntries>(key)) ?? {});
      change(entries);
      if (entries.changed) {
        if (entries.size === 0) await cache.delete(key);
        else await cache.set(key, entries.toJSON(), PENDING_TTL_MS);
      }
      return entries.dropped;
    });
  }
}

export const pendingExports = new PendingExports();

/** What the parent learns about a file that is waiting for its runtime. */
export function pendingFileNotice(tool: string): string {
  return `The runtime is in the middle of a tool call, so Guardrails cannot release this file yet. Its current version was pinned. Call ${tool} again with the same arguments after that tool call finishes: the runtime's next step releases it. This is not an error.`;
}

// =============================================================================
// Internal helpers
// =============================================================================

type FileMetadata = Record<string, unknown>;

type EntryBase = {
  id: string;
  /** Changes on every write, so a stale write cannot overwrite a newer one. */
  rev: string;
  createdAt: number;
  /** When it was admitted or held. */
  decidedAt?: number;
  child: OpenAppaSession;
  actor: A2AActor;
  taskId: string;
  path: string;
  state: "pending" | "admitted" | "held";
  /** Held: the refusal the parent gets. */
  reason?: string;
  failures: number;
  progress: ProtectedExportProgress;
};

type PendingRead = EntryBase & {
  kind: "read";
  encoding: "utf8" | "base64";
};

type PendingDownload = EntryBase & { kind: "download" };

type PendingEntry = PendingRead | PendingDownload;
type StoredEntries = Record<string, PendingEntry>;

/** The entries of one runtime session, with the cap and expiry applied. */
class Entries {
  changed = false;
  /** Entries that expired or were evicted; their pins should be released. */
  readonly dropped: PendingEntry[] = [];
  private readonly entries: Map<string, PendingEntry>;

  constructor(stored: StoredEntries) {
    this.entries = new Map();
    for (const [name, entry] of Object.entries(stored)) {
      if (isLive(entry)) this.entries.set(name, entry);
      else {
        this.dropped.push(entry);
        this.changed = true;
      }
    }
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
    const excess = this.entries.size - MAX_ENTRIES_PER_RUNTIME + 1;
    if (excess > 0) {
      const oldest = [...this.entries.entries()]
        .sort(([, a], [, b]) => a.createdAt - b.createdAt)
        .slice(0, excess);
      for (const [oldName, old] of oldest) {
        this.entries.delete(oldName);
        this.dropped.push(old);
      }
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

/**
 * A pin waits for one tool call, and a crossed file waits for the parent's
 * retry. Neither is served long after: the next read then reads afresh.
 */
function isLive(entry: PendingEntry): boolean {
  const now = Date.now();
  return entry.state === "pending"
    ? now - entry.createdAt < PENDING_TTL_MS
    : now - (entry.decidedAt ?? entry.createdAt) < DECIDED_TTL_MS;
}

function newEntry(params: {
  child: OpenAppaSession;
  actor: A2AActor;
  taskId: string;
  path: string;
}): Pick<
  EntryBase,
  | "id"
  | "rev"
  | "createdAt"
  | "child"
  | "actor"
  | "taskId"
  | "path"
  | "state"
  | "failures"
> {
  return {
    id: randomBytes(12).toString("hex"),
    rev: newRev(),
    createdAt: Date.now(),
    child: params.child,
    actor: params.actor,
    taskId: params.taskId,
    path: params.path,
    state: "pending",
    failures: 0,
  };
}

function newRev(): string {
  return randomBytes(8).toString("hex");
}

/**
 * Reads the pinned bytes and tries to cross them. `admitted` is what crossed;
 * a later caller finds it in the runtime's store by the entry's operation id.
 */
async function advanceRead(
  entry: PendingRead,
  options: { drain: boolean },
): Promise<{ entry: PendingRead; busy: boolean; admitted?: string }> {
  const bytes = await workspaceTransferTickets.readPinned({
    actor: entry.actor,
    taskId: entry.taskId,
    snapshot: entry.progress.snapshot,
    drain: options.drain,
  });
  let value: string;
  if (entry.encoding === "base64") value = bytes.toString("base64");
  else {
    try {
      value = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return {
        entry: held(
          entry,
          "The pinned version of this file is not UTF-8 text. Read it with encoding base64.",
        ),
        busy: false,
      };
    }
  }
  const result = await returnRuntimeValue({
    session: entry.child,
    operationId: `${readOperationPrefix(entry)}${operationNonce()}`,
    value,
  });
  if (result.kind === "admitted") {
    reportAgentRuntimePendingExport("admitted");
    return {
      entry: { ...entry, state: "admitted", decidedAt: Date.now() },
      busy: false,
      admitted: result.value,
    };
  }
  if (result.busy) return { entry, busy: true };
  return {
    entry: held(
      entry,
      reportCrossingRefusal({
        reason: "held",
        message: heldFileRefusal(result.reason),
        childSessionId: entry.child.session_id,
        parentSessionId: entry.child.parent_id,
      }),
    ),
    busy: false,
  };
}

/** Crosses more of a pinned download: one chunk on a drain, all it can otherwise. */
async function advanceDownload(
  entry: PendingDownload,
  options: { drain: boolean },
): Promise<{ entry: PendingDownload; busy: boolean }> {
  try {
    const advanced = await workspaceTransferTickets.advanceExport({
      actor: entry.actor,
      taskId: entry.taskId,
      path: entry.path,
      child: entry.child,
      operationBase: `file-export:${entry.id}`,
      progress: entry.progress,
      maxChunks: options.drain ? 1 : Number.POSITIVE_INFINITY,
      drain: options.drain,
    });
    if (advanced.kind === "waiting") {
      return {
        entry: { ...entry, progress: advanced.progress },
        busy: advanced.busy,
      };
    }
    reportAgentRuntimePendingExport("admitted");
    return {
      entry: {
        ...entry,
        state: "admitted",
        decidedAt: Date.now(),
        progress: advanced.progress,
      },
      busy: false,
    };
  } catch (error) {
    const refusal = crossingRefusal(error);
    if (refusal === undefined) throw error;
    return { entry: held(entry, refusal), busy: false };
  }
}

function held<T extends PendingEntry>(entry: T, reason: string): T {
  reportAgentRuntimePendingExport("held");
  return { ...entry, state: "held", decidedAt: Date.now(), reason };
}

/** What crossed for a read the drain admitted, from the runtime's own store. */
async function admittedRead(entry: PendingRead): Promise<string | undefined> {
  const prefix = readOperationPrefix(entry);
  const [latest] = (
    await loadChildReturns({
      organizationId: entry.child.organization_id,
      parentSessionId: entry.child.parent_id ?? "",
      childSessionId: entry.child.session_id,
      operationPrefix: prefix,
    })
  ).filter(
    (record) =>
      record.childSessionId === entry.child.session_id &&
      record.operationId?.startsWith(prefix),
  );
  return latest?.value;
}

function readOperationPrefix(entry: PendingRead): string {
  return `file-read:${entry.id}:`;
}

/** What a served pinned read tells the parent: the version it crossed, and when it was pinned. */
function servedMetadata(entry: PendingRead): FileMetadata {
  const { snapshot } = entry.progress;
  return {
    path: entry.path,
    size: snapshot.size,
    sha256: snapshot.sha256,
    pinned_at: new Date(entry.createdAt).toISOString(),
  };
}

/** Releases what a decided entry no longer needs pinned in the pod. */
async function afterStep(
  before: PendingEntry,
  after: PendingEntry,
): Promise<void> {
  if (before.state !== "pending" || after.state === "pending") return;
  // A crossed read is kept by the runtime's store; a crossed download is
  // served from its pin, so only that one stays.
  if (after.kind === "read" || after.state === "held")
    await discardPinned(after);
}

async function discardPinned(entry: {
  actor: A2AActor;
  taskId: string;
  progress: ProtectedExportProgress;
}): Promise<void> {
  const transferId = entry.progress.snapshot.transferId;
  await workspaceTransferTickets
    .discardExport({ actor: entry.actor, taskId: entry.taskId, transferId })
    .catch((error) => {
      // The in-pod sweep removes the pin later; this only says it stayed.
      logger.warn(
        { err: error, taskId: entry.taskId, transferId },
        "Could not discard a protected file pinned for an Agent Runtime",
      );
    });
}

/**
 * Whether the runtime is in a turn. A runtime that stopped mid-call never
 * reports that call, so its files would wait forever: refuse instead. Best
 * effort: a runtime that stops right after this check leaves a pin that
 * expires, or that the parent's next call crosses or refuses.
 */
async function runtimeIsMidTurn(taskId: string): Promise<boolean> {
  const run = await AgentRunModel.findByTaskId(taskId);
  if (!run) return false;
  const workspace = await AgentWorkspaceModel.findByWorkloadName(
    run.workloadName,
  );
  return workspace?.state === "active" && workspace.activeTaskId !== null;
}

function stoppedMidCall(params: { child: OpenAppaSession }): Error {
  return runtimeCrossingRefusal(
    reportCrossingRefusal({
      reason: "held",
      message:
        "The runtime stopped in the middle of a tool call that never reported, so Guardrails cannot release its files to this session. Open the run page to read the file there.",
      childSessionId: params.child.session_id,
      parentSessionId: params.child.parent_id,
    }),
  );
}

function entriesKey(child: OpenAppaSession): AllowedCacheKey {
  return `${CacheKey.AgentRuntimePendingExports}-${digest(
    `${child.organization_id}\n${child.session_id}`,
  )}`;
}

/**
 * One file of one caller in one parent session: a later call for the same
 * file by the same caller finds its entry, and nobody else does.
 */
function entryName(params: {
  kind: "read" | "download";
  child: OpenAppaSession;
  actor: A2AActor;
  taskId: string;
  path: string;
  encoding?: string;
}): string {
  return digest(
    [
      params.kind,
      params.child.parent_id ?? "",
      `${params.actor.kind}:${params.actor.id}`,
      params.taskId,
      params.path,
      params.encoding ?? "",
    ].join("\n"),
  );
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

/** What one runtime request spends releasing files, so its own latency stays small. */
const DRAIN_DEADLINE_MS = 2_000;
const DRAIN_BYTES = 8 * 1024 * 1024;
const MAX_DRAIN_FAILURES = 3;
/** One tool call worth waiting for; a longer one gets a fresh pin on the next call. */
const PENDING_TTL_MS = 30 * 60 * 1000;
/** A crossed file waits this long for the parent's retry, then is read afresh. */
const DECIDED_TTL_MS = 10 * 60 * 1000;
const MAX_ENTRIES_PER_RUNTIME = 16;
