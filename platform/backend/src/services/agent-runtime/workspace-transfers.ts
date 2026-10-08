import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { Readable, Transform } from "node:stream";
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
  WorkspaceSnapshotSchema,
  type WorkspaceTransferDirection,
  WorkspaceUploadReceiptSchema,
} from "@/types/agent-workspace-transfer";
import { sanitizeUploadFilename } from "@/utils/upload-filename";
import { resolveAgentRuntimeBackendDriver } from "./backends";
import { AGENT_RUNTIME_ATTACHMENTS_DIR } from "./runtime-contract";
import { authorizeAgentWorkspaceAccess } from "./workspace-files";

/** Long enough for a person to notice a failure and retry, short enough that a
 * leaked ticket is not durable authority. */
export const WORKSPACE_TRANSFER_TICKET_TTL_MS = 15 * 60 * 1000;

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
    sizeOf: (ticket) => (ticket.admittedBytes?.byteLength ?? 0) + 1024,
    defaultTtl: WORKSPACE_TRANSFER_TICKET_TTL_MS,
  });

  async mintDownload(params: {
    actor: A2AActor;
    taskId: string;
    path: string;
    crossing?: { child: OpenAppaSession; operationId: string };
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
    let admittedBytes: Buffer | undefined;
    if (params.crossing) {
      try {
        // Admit the pinned content, not a manifest that can be approved separately.
        if (snapshot.size > PROTECTED_EXPORT_LIMIT_BYTES) {
          throw new ApiError(
            413,
            "Protected exports are limited to 4 MiB per admitted file",
          );
        }
        const stream = await resolveAgentRuntimeBackendDriver(
          session.backend,
        ).readWorkspaceTransferRange({
          session,
          transferId: snapshot.transferId,
          offset: 0,
          length: snapshot.size,
          timeoutMs: TRANSFER_TIMEOUT_MS,
        });
        const chunks: Buffer[] = [];
        // Cancellation can reject this before the normal await below.
        void stream.completed.catch(() => undefined);
        let size = 0;
        for await (const chunk of stream.stdout) {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += bytes.length;
          if (size > snapshot.size)
            throw new ApiError(409, "The pinned export changed size");
          chunks.push(bytes);
        }
        await stream.completed;
        const bytes = Buffer.concat(chunks);
        if (
          size !== snapshot.size ||
          createHash("sha256").update(bytes).digest("hex") !== snapshot.sha256
        ) {
          throw new ApiError(
            409,
            "The pinned export failed its integrity check",
          );
        }
        let encoding: "utf8" | "base64" = "utf8";
        let data: string;
        try {
          data = new TextDecoder("utf-8", {
            fatal: true,
            ignoreBOM: true,
          }).decode(bytes);
        } catch {
          encoding = "base64";
          data = bytes.toString("base64");
        }
        const content = JSON.stringify({
          path: params.path,
          encoding,
          content: data,
          sha256: snapshot.sha256,
        });
        const result = await returnRuntimeValue({
          session: params.crossing.child,
          operationId: `file-export:${params.crossing.operationId}:${snapshot.sha256}`,
          value: content,
        });
        if (result.kind !== "admitted" || result.value !== content) {
          throw new ApiError(
            409,
            "The pinned file was not admitted unchanged. No download ticket was issued.",
          );
        }
        // HTTP ranges must serve the exact admitted copy, never the mutable file.
        admittedBytes = bytes;
      } finally {
        await resolveAgentRuntimeBackendDriver(session.backend)
          .runWorkspaceTransferCommand({
            session,
            args: helperArgs(undefined, "discard", snapshot.transferId),
            timeoutMs: CONTROL_TIMEOUT_MS,
          })
          .catch(() => {
            logger.warn(
              { transferId: snapshot.transferId },
              "Could not discard a refused runtime export snapshot",
            );
          });
      }
    }
    return this.store({
      direction: "download",
      path: params.path,
      entryId: snapshot.transferId,
      size: snapshot.size,
      sha256: snapshot.sha256,
      destination: { ...snapshot, present: true },
      actor: params.actor,
      taskId: params.taskId,
      ...(admittedBytes ? { admittedBytes } : {}),
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
  crossing?: {
    parent: OpenAppaSession;
    childSessionId: string;
    operationId: string;
  };
};

const PROTECTED_EXPORT_LIMIT_BYTES = 4 * 1024 * 1024;

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
