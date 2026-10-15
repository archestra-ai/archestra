import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { finished } from "node:stream/promises";
import type { A2AActor } from "@/agents/a2a/a2a-base";
import { LRUCacheManager } from "@/cache-manager";
import config from "@/config";
import logger from "@/logging";
import {
  addressRuntimeChild,
  type OpenAppaSession,
  returnRuntimeValue,
} from "@/openappa/service";
import { ApiError } from "@/types";
import {
  type WorkspaceFileStat,
  WorkspaceFileStatSchema,
  type WorkspaceSnapshot,
  WorkspaceSnapshotSchema,
  type WorkspaceTransferDirection,
  WorkspaceUploadReceiptSchema,
} from "@/types/agent-workspace-transfer";
import { sanitizeUploadFilename } from "@/utils/upload-filename";
import { resolveAgentRuntimeBackendDriver } from "./backends";
import { AGENT_RUNTIME_ATTACHMENTS_DIR } from "./runtime-contract";
import {
  heldFileRefusal,
  reportCrossingRefusal,
  runtimeCrossingRefusal,
} from "./runtime-crossing";
import { authorizeAgentWorkspaceAccess } from "./workspace-files";

/** Long enough for a person to notice a failure and retry, short enough that a
 * leaked ticket is not durable authority. */
export const WORKSPACE_TRANSFER_TICKET_TTL_MS = 15 * 60 * 1000;

/** How far a protected export of a pinned snapshot has crossed. JSON-safe. */
export type ProtectedExportProgress = {
  snapshot: WorkspaceSnapshot;
  /** Digests of the chunks admitted so far, in order. */
  digests: string[];
  /** Admission attempts so far; each one crosses under fresh operation ids. */
  attempt: number;
};

/**
 * The runtime had a tool call open, so nothing more could cross. The snapshot
 * stays pinned; `progress` is what crossed before the runtime got busy.
 */
export class ProtectedExportBusy extends Error {
  constructor(readonly progress: ProtectedExportProgress) {
    super("The runtime is mid-call; the export waits for it");
    this.name = "ProtectedExportBusy";
  }
}

type WorkspaceTransferTicket = {
  id: string;
  direction: WorkspaceTransferDirection;
  path: string;
  /** Directory `path` is relative to, when it is not the workspace. */
  root?: string;
  /** Pinned copy in the Pod for a download, staging entry for an upload. */
  entryId: string;
  size: number;
  sha256: string;
  /** Destination identity when the transfer was authorized. */
  destination: WorkspaceFileStat;
};

/** Short-lived authority to move one file, one way.
 *
 * A ticket is not a session credential. It names a single path and direction,
 * and it never widens what its owner could already reach. Every request it
 * accompanies re-runs the workspace gate, so ownership, lifecycle and
 * retention are revalidated rather than captured once at mint.
 */
class WorkspaceTransferTickets {
  private readonly tickets = new LRUCacheManager<StoredTicket>({
    maxSize: 1000,
    maxBytes: 64 * 1024 * 1024,
    sizeOf: (ticket) =>
      (ticket.admittedBytes?.byteLength ?? 0) +
      (ticket.chunkDigests?.length ?? 0) * 64 +
      1024,
    defaultTtl: WORKSPACE_TRANSFER_TICKET_TTL_MS,
  });

  /**
   * Authorizes one download. With a crossing, the pinned bytes must first pass
   * the parent's guardrail. A runtime that is mid-call cannot return anything
   * yet: the snapshot stays pinned and `ProtectedExportBusy` carries what was
   * admitted so far, so `advanceExport` can continue once the runtime is idle.
   */
  async mintDownload(params: {
    actor: A2AActor;
    taskId: string;
    path: string;
    crossing?: { child: OpenAppaSession; operationId: string };
  }): Promise<{ ticket: WorkspaceTransferTicket; token: string }> {
    const session = await authorizeAgentWorkspaceAccess(params);
    const driver = resolveAgentRuntimeBackendDriver(session.backend);
    // Pin the current version before any byte moves. Cancellation does not
    // prove the runtime stopped writing, so export must not depend on it.
    const snapshot = WorkspaceSnapshotSchema.parse(
      camelize(
        await driver.runWorkspaceTransferCommand({
          session,
          args: ["snapshot", params.path],
          timeoutMs: CONTROL_TIMEOUT_MS,
        }),
      ),
    );
    const download = {
      direction: "download" as const,
      path: params.path,
      entryId: snapshot.transferId,
      size: snapshot.size,
      sha256: snapshot.sha256,
      destination: { ...snapshot, present: true as const },
      actor: params.actor,
      taskId: params.taskId,
    };
    if (!params.crossing) return this.store(download);
    const { crossing } = params;
    let keepSnapshot = false;
    try {
      if (snapshot.size <= PROTECTED_EXPORT_CHUNK_BYTES) {
        const bytes = await readSnapshotRange({
          driver,
          session,
          transferId: snapshot.transferId,
          offset: 0,
          length: snapshot.size,
        });
        if (
          createHash("sha256").update(bytes).digest("hex") !== snapshot.sha256
        )
          throw new ApiError(
            409,
            "The pinned export failed its integrity check",
          );
        const value = JSON.stringify({
          path: params.path,
          ...exportPayload(bytes),
          sha256: snapshot.sha256,
        });
        const result = await returnRuntimeValue({
          session: crossing.child,
          operationId: `file-export:${crossing.operationId}:${snapshot.sha256}`,
          value,
        });
        if (result.kind === "held" && result.busy) {
          keepSnapshot = true;
          throw new ProtectedExportBusy({ snapshot, digests: [], attempt: 1 });
        }
        assertAdmittedUnchanged({ result, value, child: crossing.child });
        // HTTP ranges must serve the exact admitted copy, never the mutable file.
        return this.store({ ...download, admittedBytes: bytes });
      }
      const advanced = await advanceExportOn({
        driver,
        session,
        path: params.path,
        child: crossing.child,
        operationBase: `file-export:${crossing.operationId}:${snapshot.sha256}`,
        progress: { snapshot, digests: [], attempt: 0 },
        budgetBytes: Number.POSITIVE_INFINITY,
      });
      if (advanced.kind === "waiting") {
        keepSnapshot = true;
        throw new ProtectedExportBusy(advanced.progress);
      }
      await verifyAdmittedSnapshot({
        driver,
        session,
        progress: advanced.progress,
        child: crossing.child,
      });
      // A larger file is served from its snapshot, chunk by chunk against the
      // admitted digests.
      keepSnapshot = true;
      return this.store({
        ...download,
        chunkDigests: advanced.progress.digests,
      });
    } finally {
      if (!keepSnapshot)
        await discardSnapshot({
          driver,
          session,
          transferId: snapshot.transferId,
        });
    }
  }

  /**
   * Continues admitting a pinned export, at most `budgetBytes` of it. Each
   * chunk crosses under an operation id no earlier attempt used, because the
   * runtime answers a repeated operation with the decision it already gave.
   */
  async advanceExport(params: {
    actor: A2AActor;
    taskId: string;
    path: string;
    child: OpenAppaSession;
    operationBase: string;
    progress: ProtectedExportProgress;
    budgetBytes: number;
  }): Promise<{
    kind: "complete" | "waiting";
    progress: ProtectedExportProgress;
    busy: boolean;
  }> {
    const session = await authorizeAgentWorkspaceAccess(params);
    return advanceExportOn({
      ...params,
      driver: resolveAgentRuntimeBackendDriver(session.backend),
      session,
    });
  }

  /** Issues the ticket for an export whose every chunk crossed. */
  async mintAdmittedDownload(params: {
    actor: A2AActor;
    taskId: string;
    path: string;
    child: OpenAppaSession;
    progress: ProtectedExportProgress;
  }): Promise<{ ticket: WorkspaceTransferTicket; token: string }> {
    const session = await authorizeAgentWorkspaceAccess(params);
    const driver = resolveAgentRuntimeBackendDriver(session.backend);
    const { snapshot } = params.progress;
    await verifyAdmittedSnapshot({
      driver,
      session,
      progress: params.progress,
      child: params.child,
    });
    return this.store({
      direction: "download",
      path: params.path,
      entryId: snapshot.transferId,
      size: snapshot.size,
      sha256: snapshot.sha256,
      destination: { ...snapshot, present: true },
      actor: params.actor,
      taskId: params.taskId,
      chunkDigests: params.progress.digests,
    });
  }

  /** Releases a pinned export that will never be served. */
  async discardExport(params: {
    actor: A2AActor;
    taskId: string;
    transferId: string;
  }): Promise<void> {
    const session = await authorizeAgentWorkspaceAccess(params);
    await discardSnapshot({
      driver: resolveAgentRuntimeBackendDriver(session.backend),
      session,
      transferId: params.transferId,
    });
  }

  async mintUpload(params: {
    actor: A2AActor;
    taskId: string;
    path: string;
    size: number;
    sha256: string;
    location?: "workspace" | "attachments";
    crossing?: {
      parent: OpenAppaSession;
      childSessionId: string;
      operationId: string;
    };
  }): Promise<{ ticket: WorkspaceTransferTicket; token: string }> {
    if (
      params.location === "attachments" &&
      params.size > config.chat.attachmentStorageBytesLimit
    ) {
      throw new ApiError(
        413,
        `Attachments are limited to ${Math.floor(config.chat.attachmentStorageBytesLimit / 1024 / 1024)} MB`,
      );
    }
    const session = await authorizeAgentWorkspaceAccess(params);
    // Attachments sit beside the run's start-up inputs, outside the tree the
    // Agent works in. The prefix keeps a repeated name from replacing a file
    // the Agent was already pointed at.
    const placement =
      params.location === "attachments"
        ? {
            root: `${AGENT_RUNTIME_ATTACHMENTS_DIR}/${params.taskId}`,
            path: `${randomBytes(4).toString("hex")}-${sanitizeUploadFilename(params.path)}`,
          }
        : { path: params.path };
    const destination = WorkspaceFileStatSchema.parse(
      camelize(
        await resolveAgentRuntimeBackendDriver(
          session.backend,
        ).runWorkspaceTransferCommand({
          session,
          args: helperArgs(placement.root, "stat", placement.path),
          timeoutMs: CONTROL_TIMEOUT_MS,
        }),
      ),
    );
    return this.store({
      direction: "upload",
      ...placement,
      entryId: randomBytes(16).toString("hex"),
      size: params.size,
      sha256: params.sha256,
      destination,
      actor: params.actor,
      taskId: params.taskId,
      ...(params.crossing ? { crossing: params.crossing } : {}),
    });
  }

  /** Resolve a presented ticket. Unknown, expired and wrong tokens are
   * indistinguishable, so a ticket id alone reveals nothing. */
  resolve(id: string, token: string): StoredTicket {
    const stored = this.tickets.get(id);
    const presented = hashToken(token);
    if (
      !stored ||
      stored.tokenHash.length !== presented.length ||
      !timingSafeEqual(stored.tokenHash, presented)
    ) {
      throw new ApiError(404, "Transfer not found");
    }
    return stored;
  }

  /** Stream bytes of a pinned snapshot. Resumes read the same version. */
  async read(params: {
    ticket: StoredTicket;
    offset: number;
    length: number;
  }): Promise<{ stdout: Readable; completed: Promise<void> }> {
    const session = await authorizeAgentWorkspaceAccess(params.ticket);
    if (params.ticket.admittedBytes) {
      const end = params.length < 0 ? undefined : params.offset + params.length;
      return {
        stdout: Readable.from(
          params.ticket.admittedBytes.subarray(params.offset, end),
        ),
        completed: Promise.resolve(),
      };
    }
    if (params.ticket.chunkDigests) {
      return verifiedSnapshotRead({
        driver: resolveAgentRuntimeBackendDriver(session.backend),
        session,
        ticket: params.ticket,
        digests: params.ticket.chunkDigests,
        offset: params.offset,
        length: params.length,
      });
    }
    return resolveAgentRuntimeBackendDriver(
      session.backend,
    ).readWorkspaceTransferRange({
      session,
      transferId: params.ticket.entryId,
      offset: params.offset,
      length: params.length,
      timeoutMs: TRANSFER_TIMEOUT_MS,
    });
  }

  /** Consume an upload body, then replace the destination atomically. */
  async receive(params: { ticket: StoredTicket; body: Readable }) {
    const session = await authorizeAgentWorkspaceAccess(params.ticket);
    if (params.ticket.crossing) {
      await addressRuntimeChild({
        session: params.ticket.crossing.parent,
        childSessionId: params.ticket.crossing.childSessionId,
        operationId: `file-upload:${params.ticket.crossing.operationId}:${params.ticket.id}`,
      });
    }
    const driver = resolveAgentRuntimeBackendDriver(session.backend);
    const body = limitBytes(params.body, params.ticket.size);
    const receipt = WorkspaceUploadReceiptSchema.parse(
      camelize(
        await driver.runWorkspaceTransferCommand({
          session,
          args: helperArgs(
            params.ticket.root,
            "write-stream",
            params.ticket.entryId,
          ),
          stdin: body.stream,
          timeoutMs: TRANSFER_TIMEOUT_MS,
        }),
      ),
    );
    if (body.exceeded()) {
      await this.discard(params.ticket);
      throw new ApiError(413, "Upload is larger than the size it declared");
    }
    if (receipt.sha256 !== params.ticket.sha256) {
      await this.discard(params.ticket);
      throw new ApiError(
        422,
        "Uploaded bytes do not match the expected checksum",
      );
    }
    const destination = params.ticket.destination;
    const result = await driver
      .runWorkspaceTransferCommand({
        session,
        args: helperArgs(
          params.ticket.root,
          "finalize",
          params.ticket.entryId,
          params.ticket.path,
          params.ticket.sha256,
          destination.present ? destination.ino : "-",
          destination.present ? destination.mtimeNs : "0",
        ),
        timeoutMs: CONTROL_TIMEOUT_MS,
      })
      .catch((error: unknown) => {
        // Losing a race for the destination is a conflict, not a bad request.
        // The staged upload is kept so the caller can still decide what to do.
        if (
          error instanceof ApiError &&
          error.message.includes("destination changed")
        ) {
          throw new ApiError(409, error.message);
        }
        throw error;
      });
    this.tickets.delete(params.ticket.id);
    return { ...(camelize(result) as object), path: ticketPath(params.ticket) };
  }

  /** Remove a staging entry so an abandoned transfer leaves nothing behind. */
  async discard(ticket: StoredTicket): Promise<void> {
    this.tickets.delete(ticket.id);
    const session = await authorizeAgentWorkspaceAccess(ticket);
    await resolveAgentRuntimeBackendDriver(
      session.backend,
    ).runWorkspaceTransferCommand({
      session,
      args: helperArgs(ticket.root, "discard", ticket.entryId),
      timeoutMs: CONTROL_TIMEOUT_MS,
    });
  }

  private store(
    fields: Omit<WorkspaceTransferTicket, "id"> & {
      actor: A2AActor;
      taskId: string;
      admittedBytes?: Buffer;
      chunkDigests?: readonly string[];
      crossing?: {
        parent: OpenAppaSession;
        childSessionId: string;
        operationId: string;
      };
    },
  ): { ticket: WorkspaceTransferTicket; token: string } {
    const id = randomBytes(16).toString("hex");
    // The plaintext leaves here once. Only its hash is retained, so a dump of
    // cache state cannot be replayed against a workspace.
    const token = randomBytes(32).toString("base64url");
    const stored: StoredTicket = {
      ...fields,
      id,
      tokenHash: hashToken(token),
    };
    this.tickets.set(id, stored);
    return {
      ticket: {
        id,
        direction: stored.direction,
        path: stored.path,
        root: stored.root,
        entryId: stored.entryId,
        size: stored.size,
        sha256: stored.sha256,
        destination: stored.destination,
      },
      token,
    };
  }
}

export const workspaceTransferTickets = new WorkspaceTransferTickets();

// === Internal ========================================================

type StoredTicket = WorkspaceTransferTicket & {
  tokenHash: Buffer;
  actor: A2AActor;
  taskId: string;
  /** Host-private, byte-bounded copy of a protected download's admitted value. */
  admittedBytes?: Buffer;
  /** Digest of each admitted chunk of a protected download served from its
   * pinned snapshot, in chunk order. */
  chunkDigests?: readonly string[];
  crossing?: {
    parent: OpenAppaSession;
    childSessionId: string;
    operationId: string;
  };
};

/**
 * Largest protected export kept on the host, and the chunk size above it.
 * A chunk crosses the guardrail as one child value, so after base64 inflation
 * and its JSON envelope it must stay under the 8 MiB a child value may carry.
 * No file size is refused here: an unprotected export has no limit either.
 */
const PROTECTED_EXPORT_CHUNK_BYTES = 4 * 1024 * 1024;

const SNAPSHOT_MISMATCH =
  "The pinned export no longer matches its admitted bytes";

type TransferDriver = ReturnType<typeof resolveAgentRuntimeBackendDriver>;
type TransferSession = Awaited<
  ReturnType<typeof authorizeAgentWorkspaceAccess>
>;

/**
 * Admits the next chunks of a pinned snapshot in order, one child value per
 * chunk. Content crosses, never a manifest that could be approved apart from
 * its bytes. Stops at the budget, or when the runtime is mid-call (`busy`).
 */
async function advanceExportOn(params: {
  driver: TransferDriver;
  session: TransferSession;
  path: string;
  child: OpenAppaSession;
  operationBase: string;
  progress: ProtectedExportProgress;
  budgetBytes: number;
}): Promise<{
  kind: "complete" | "waiting";
  progress: ProtectedExportProgress;
  busy: boolean;
}> {
  const { snapshot } = params.progress;
  const count = Math.max(
    1,
    Math.ceil(snapshot.size / PROTECTED_EXPORT_CHUNK_BYTES),
  );
  const digests = [...params.progress.digests];
  const attempt = params.progress.attempt + 1;
  const progress = () => ({ snapshot, digests: [...digests], attempt });
  let spent = 0;
  for (let index = digests.length; index < count; index++) {
    const start = index * PROTECTED_EXPORT_CHUNK_BYTES;
    const length = Math.min(
      PROTECTED_EXPORT_CHUNK_BYTES,
      snapshot.size - start,
    );
    if (spent > 0 && spent + length > params.budgetBytes) {
      return { kind: "waiting", progress: progress(), busy: false };
    }
    const chunk = await readSnapshotRange({
      driver: params.driver,
      session: params.session,
      transferId: snapshot.transferId,
      offset: start,
      length,
    });
    const digest = createHash("sha256").update(chunk).digest("hex");
    const value = JSON.stringify({
      path: params.path,
      ...exportPayload(chunk),
      sha256: snapshot.sha256,
      chunk: { index, count, sha256: digest },
    });
    const result = await returnRuntimeValue({
      session: params.child,
      operationId: `${params.operationBase}:${index}/${count}:${attempt}`,
      value,
    });
    if (result.kind === "held" && result.busy) {
      return { kind: "waiting", progress: progress(), busy: true };
    }
    assertAdmittedUnchanged({ result, value, child: params.child });
    digests.push(digest);
    spent += length;
  }
  return { kind: "complete", progress: progress(), busy: false };
}

/**
 * Before a ticket is issued, the whole snapshot must still hash to the
 * version that was pinned and to the chunks that crossed. A file rewritten in
 * place after it was pinned gets no ticket.
 */
async function verifyAdmittedSnapshot(params: {
  driver: TransferDriver;
  session: TransferSession;
  progress: ProtectedExportProgress;
  child: OpenAppaSession;
}): Promise<void> {
  const { snapshot, digests } = params.progress;
  const stream = await params.driver.readWorkspaceTransferRange({
    session: params.session,
    transferId: snapshot.transferId,
    offset: 0,
    length: snapshot.size,
    timeoutMs: TRANSFER_TIMEOUT_MS,
  });
  void stream.completed.catch(() => undefined);
  const file = createHash("sha256");
  const seen: string[] = [];
  let chunk = createHash("sha256");
  let inChunk = 0;
  let size = 0;
  for await (const piece of stream.stdout) {
    let bytes = Buffer.isBuffer(piece) ? piece : Buffer.from(piece);
    size += bytes.length;
    if (size > snapshot.size) break;
    file.update(bytes);
    while (bytes.length > 0) {
      const take = Math.min(
        bytes.length,
        PROTECTED_EXPORT_CHUNK_BYTES - inChunk,
      );
      chunk.update(bytes.subarray(0, take));
      inChunk += take;
      bytes = bytes.subarray(take);
      if (inChunk === PROTECTED_EXPORT_CHUNK_BYTES) {
        seen.push(chunk.digest("hex"));
        chunk = createHash("sha256");
        inChunk = 0;
      }
    }
  }
  await stream.completed;
  if (inChunk > 0 || snapshot.size === 0) seen.push(chunk.digest("hex"));
  if (
    size !== snapshot.size ||
    file.digest("hex") !== snapshot.sha256 ||
    seen.length !== digests.length ||
    seen.some((digest, index) => digest !== digests[index])
  ) {
    throw runtimeCrossingRefusal(
      reportCrossingRefusal({
        reason: "altered",
        message:
          "The pinned file changed after Guardrails admitted it. No download ticket was issued. Call transfer_workspace_file again to pin its current version.",
        childSessionId: params.child.session_id,
        parentSessionId: params.child.parent_id,
      }),
    );
  }
}

/** One child value must come back admitted and byte-identical, or no ticket. */
function assertAdmittedUnchanged(params: {
  result: Awaited<ReturnType<typeof returnRuntimeValue>>;
  value: string;
  child: OpenAppaSession;
}): void {
  const report = {
    childSessionId: params.child.session_id,
    parentSessionId: params.child.parent_id,
  };
  if (params.result.kind !== "admitted") {
    throw runtimeCrossingRefusal(
      reportCrossingRefusal({
        reason: "held",
        message: `${heldFileRefusal(params.result.reason)}\n\nNo download ticket was issued.`,
        ...report,
      }),
    );
  }
  if (params.result.value !== params.value) {
    throw runtimeCrossingRefusal(
      reportCrossingRefusal({
        reason: "altered",
        message:
          "The pinned file was not admitted unchanged. No download ticket was issued.",
        ...report,
      }),
    );
  }
}

/** Exactly `length` bytes of a snapshot, or a conflict. */
async function readSnapshotRange(params: {
  driver: TransferDriver;
  session: TransferSession;
  transferId: string;
  offset: number;
  length: number;
}): Promise<Buffer> {
  const range = await params.driver.readWorkspaceTransferRange({
    session: params.session,
    transferId: params.transferId,
    offset: params.offset,
    length: params.length,
    timeoutMs: TRANSFER_TIMEOUT_MS,
  });
  // Cancellation can reject this before the normal await below.
  void range.completed.catch(() => undefined);
  const parts: Buffer[] = [];
  let seen = 0;
  for await (const piece of range.stdout) {
    const bytes = Buffer.isBuffer(piece) ? piece : Buffer.from(piece);
    seen += bytes.length;
    if (seen > params.length)
      throw new ApiError(409, "The pinned export changed size");
    parts.push(bytes);
  }
  await range.completed;
  if (seen !== params.length)
    throw new ApiError(409, "The pinned export changed size");
  return Buffer.concat(parts);
}

/**
 * Text crosses as text, so a rule that reads content sees what the file says.
 * Bytes that are not UTF-8, or text that JSON would inflate past its base64
 * form (control characters), cross as base64.
 */
function exportPayload(bytes: Buffer): {
  encoding: "utf8" | "base64";
  content: string;
} {
  const base64 = bytes.toString("base64");
  try {
    const text = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes);
    if (JSON.stringify(text).length <= base64.length + 2)
      return { encoding: "utf8", content: text };
  } catch {
    // Not UTF-8: fall through to base64.
  }
  return { encoding: "base64", content: base64 };
}

async function discardSnapshot(params: {
  driver: TransferDriver;
  session: TransferSession;
  transferId: string;
}): Promise<void> {
  await params.driver
    .runWorkspaceTransferCommand({
      session: params.session,
      args: helperArgs(undefined, "discard", params.transferId),
      timeoutMs: CONTROL_TIMEOUT_MS,
    })
    .catch(() => {
      logger.warn(
        { transferId: params.transferId },
        "Could not discard a refused runtime export snapshot",
      );
    });
}

/**
 * Serves a large protected download from its pinned snapshot, releasing each
 * chunk only after it matches the digest admitted for it. A runtime that
 * rewrites the snapshot after admission ends the stream with an error instead
 * of changing what the parent receives.
 */
function verifiedSnapshotRead(params: {
  driver: ReturnType<typeof resolveAgentRuntimeBackendDriver>;
  session: Awaited<ReturnType<typeof authorizeAgentWorkspaceAccess>>;
  ticket: StoredTicket;
  digests: readonly string[];
  offset: number;
  length: number;
}): { stdout: Readable; completed: Promise<void> } {
  const { ticket, digests, offset } = params;
  const end =
    params.length < 0
      ? ticket.size
      : Math.min(ticket.size, offset + params.length);
  async function* chunks() {
    for (
      let index = Math.floor(offset / PROTECTED_EXPORT_CHUNK_BYTES);
      index * PROTECTED_EXPORT_CHUNK_BYTES < end;
      index++
    ) {
      const start = index * PROTECTED_EXPORT_CHUNK_BYTES;
      const length = Math.min(
        PROTECTED_EXPORT_CHUNK_BYTES,
        ticket.size - start,
      );
      const expected = digests[index];
      if (!expected) throw new ApiError(409, SNAPSHOT_MISMATCH);
      const range = await params.driver.readWorkspaceTransferRange({
        session: params.session,
        transferId: ticket.entryId,
        offset: start,
        length,
        timeoutMs: TRANSFER_TIMEOUT_MS,
      });
      void range.completed.catch(() => undefined);
      const parts: Buffer[] = [];
      let seen = 0;
      for await (const piece of range.stdout) {
        const bytes = Buffer.isBuffer(piece) ? piece : Buffer.from(piece);
        seen += bytes.length;
        if (seen > length) throw new ApiError(409, SNAPSHOT_MISMATCH);
        parts.push(bytes);
      }
      await range.completed;
      const chunk = Buffer.concat(parts);
      if (
        chunk.length !== length ||
        createHash("sha256").update(chunk).digest("hex") !== expected
      ) {
        throw new ApiError(409, SNAPSHOT_MISMATCH);
      }
      yield chunk.subarray(
        Math.max(offset, start) - start,
        Math.min(end, start + length) - start,
      );
    }
  }
  const stdout = Readable.from(chunks());
  const completed = finished(stdout);
  // The route decides how to react; an unobserved failure must not crash.
  void completed.catch(() => undefined);
  return { stdout, completed };
}

/** The path a person or Agent should use: absolute outside the workspace. */
export function ticketPath(
  ticket: Pick<WorkspaceTransferTicket, "root" | "path">,
): string {
  return ticket.root ? path.posix.join(ticket.root, ticket.path) : ticket.path;
}

/** Forward at most the bytes a ticket declared. The request stream is
 * unbounded, so without this a client could fill the runtime's volume. */
function limitBytes(
  body: Readable,
  limit: number,
): { stream: Readable; exceeded: () => boolean } {
  let seen = 0;
  let exceeded = false;
  const stream = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      seen += chunk.length;
      if (seen <= limit) return callback(null, chunk);
      // End the helper's input here; the rest of the body is never forwarded.
      exceeded = true;
      body.unpipe(stream);
      callback();
      stream.end();
    },
  });
  body.pipe(stream);
  return { stream, exceeded: () => exceeded };
}

/** The in-Pod helper works in the workspace unless told otherwise. */
function helperArgs(root: string | undefined, ...args: string[]): string[] {
  return root ? ["--root", root, ...args] : args;
}

function hashToken(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

/** The in-Pod helper speaks snake_case; the rest of the backend does not. */
function camelize(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()),
      entry,
    ]),
  );
}

const CONTROL_TIMEOUT_MS = 60 * 1000;
/** Bytes, not the control plane: sized for a slow link rather than a fast one. */
const TRANSFER_TIMEOUT_MS = 30 * 60 * 1000;
