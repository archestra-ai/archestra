import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Readable } from "node:stream";
import type { A2AActor } from "@/agents/a2a/a2a-base";
import { LRUCacheManager } from "@/cache-manager";
import { ApiError } from "@/types";
import {
  type WorkspaceFileStat,
  WorkspaceFileStatSchema,
  WorkspaceSnapshotSchema,
  type WorkspaceTransferDirection,
  WorkspaceUploadReceiptSchema,
} from "@/types/agent-workspace-transfer";
import { resolveAgentRuntimeBackendDriver } from "./backends";
import { authorizeAgentWorkspaceAccess } from "./workspace-files";

/** Long enough for a person to notice a failure and retry, short enough that a
 * leaked ticket is not durable authority. */
export const WORKSPACE_TRANSFER_TICKET_TTL_MS = 15 * 60 * 1000;

type WorkspaceTransferTicket = {
  id: string;
  direction: WorkspaceTransferDirection;
  path: string;
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
    defaultTtl: WORKSPACE_TRANSFER_TICKET_TTL_MS,
  });

  async mintDownload(params: {
    actor: A2AActor;
    taskId: string;
    path: string;
  }): Promise<{ ticket: WorkspaceTransferTicket; token: string }> {
    const session = await authorizeAgentWorkspaceAccess(params);
    // Pin the current version before any byte moves. Cancellation does not
    // prove the runtime stopped writing, so export must not depend on it.
    const snapshot = WorkspaceSnapshotSchema.parse(
      camelize(
        await resolveAgentRuntimeBackendDriver(
          session.backend,
        ).runWorkspaceTransferCommand({
          session,
          args: ["snapshot", params.path],
          timeoutMs: CONTROL_TIMEOUT_MS,
        }),
      ),
    );
    return this.store({
      direction: "download",
      path: params.path,
      entryId: snapshot.transferId,
      size: snapshot.size,
      sha256: snapshot.sha256,
      destination: { ...snapshot, present: true },
      actor: params.actor,
      taskId: params.taskId,
    });
  }

  async mintUpload(params: {
    actor: A2AActor;
    taskId: string;
    path: string;
    size: number;
    sha256: string;
  }): Promise<{ ticket: WorkspaceTransferTicket; token: string }> {
    const session = await authorizeAgentWorkspaceAccess(params);
    const destination = WorkspaceFileStatSchema.parse(
      camelize(
        await resolveAgentRuntimeBackendDriver(
          session.backend,
        ).runWorkspaceTransferCommand({
          session,
          args: ["stat", params.path],
          timeoutMs: CONTROL_TIMEOUT_MS,
        }),
      ),
    );
    return this.store({
      direction: "upload",
      path: params.path,
      entryId: randomBytes(16).toString("hex"),
      size: params.size,
      sha256: params.sha256,
      destination,
      actor: params.actor,
      taskId: params.taskId,
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
    const driver = resolveAgentRuntimeBackendDriver(session.backend);
    const receipt = WorkspaceUploadReceiptSchema.parse(
      camelize(
        await driver.runWorkspaceTransferCommand({
          session,
          args: ["write-stream", params.ticket.entryId],
          stdin: params.body,
          timeoutMs: TRANSFER_TIMEOUT_MS,
        }),
      ),
    );
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
        args: [
          "finalize",
          params.ticket.entryId,
          params.ticket.path,
          params.ticket.sha256,
          destination.present ? destination.ino : "-",
          destination.present ? destination.mtimeNs : "0",
        ],
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
    return camelize(result);
  }

  /** Remove a staging entry so an abandoned transfer leaves nothing behind. */
  async discard(ticket: StoredTicket): Promise<void> {
    this.tickets.delete(ticket.id);
    const session = await authorizeAgentWorkspaceAccess(ticket);
    await resolveAgentRuntimeBackendDriver(
      session.backend,
    ).runWorkspaceTransferCommand({
      session,
      args: ["discard", ticket.entryId],
      timeoutMs: CONTROL_TIMEOUT_MS,
    });
  }

  private store(
    fields: Omit<WorkspaceTransferTicket, "id"> & {
      actor: A2AActor;
      taskId: string;
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
};

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
