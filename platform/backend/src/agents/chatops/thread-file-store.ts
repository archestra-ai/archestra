import { createHash, randomUUID } from "node:crypto";
import { LRUCacheManager } from "@/cache-manager";
import { ephemeralSandboxStore } from "@/skills-sandbox/ephemeral-sandbox-store";
import { executionSandboxRegistry } from "@/skills-sandbox/execution-sandbox-registry";
import { resolveArtifactMime } from "@/skills-sandbox/mime-sniff";
import { CHATOPS_ATTACHMENT_LIMITS } from "./constants";

/** Server-established context; callers must never accept these fields from tool arguments. */
export interface ThreadFileScope {
  organizationId: string;
  userId: string;
  isolationKey: string;
  chatOpsBindingId: string;
  chatOpsThreadId: string;
}

interface ThreadFileMetadata {
  fileId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
}

interface StoredThreadFile extends ThreadFileMetadata {
  scope: ThreadFileScope;
  data: Buffer;
}

/** Private execution-scoped snapshots; expire after an hour or earlier eviction. No sandbox or persistent file is created. */
class ThreadFileStore {
  private readonly files = new LRUCacheManager<StoredThreadFile>({
    maxSize: 128,
    maxBytes: 128 * 1024 * 1024,
    sizeOf: (file) => file.data.length,
  });

  retain(params: {
    scope: ThreadFileScope;
    data: Buffer;
    filename: string;
  }): ThreadFileMetadata {
    if (
      executionSandboxRegistry.isEphemeralExecution(params.scope.isolationKey)
    ) {
      ephemeralSandboxStore.assertExecutionActive(params.scope.isolationKey);
    }
    const prefix = executionPrefix(params.scope.isolationKey);
    let retainedBytes = 0;
    for (const key of this.files.keys()) {
      if (key.startsWith(prefix))
        retainedBytes += this.files.get(key)?.sizeBytes ?? 0;
    }
    // Reserve room for processing output as well as the 25 MiB ingestion budget.
    if (
      retainedBytes + params.data.length >
      2 * CHATOPS_ATTACHMENT_LIMITS.MAX_TOTAL_ATTACHMENTS_SIZE
    ) {
      throw new Error(
        "The retained files exceed this execution's attachment limit.",
      );
    }
    const metadata: ThreadFileMetadata = {
      fileId: `chatops_file_${randomUUID()}`,
      filename: params.filename,
      mimeType: resolveArtifactMime({
        buffer: params.data,
        claimed: undefined,
      }),
      sizeBytes: params.data.length,
      sha256: createHash("sha256").update(params.data).digest("hex"),
    };
    this.files.set(`${prefix}${metadata.fileId}`, {
      ...metadata,
      scope: { ...params.scope },
      data: Buffer.from(params.data),
    });
    return metadata;
  }

  resolve(params: {
    scope: ThreadFileScope;
    fileId: string;
  }): (ThreadFileMetadata & { data: Buffer }) | null {
    if (
      executionSandboxRegistry.isEphemeralExecution(params.scope.isolationKey)
    ) {
      try {
        ephemeralSandboxStore.assertExecutionActive(params.scope.isolationKey);
      } catch {
        return null;
      }
    }
    const file = this.files.get(
      `${executionPrefix(params.scope.isolationKey)}${params.fileId}`,
    );
    if (!file || !sameScope(file.scope, params.scope)) return null;
    const { scope: _scope, data, ...metadata } = file;
    return { ...metadata, data: Buffer.from(data) };
  }

  resolveAll(scope: ThreadFileScope) {
    return [...this.files.keys()].flatMap((key) => {
      const stored = this.files.get(key);
      if (!stored || !sameScope(stored.scope, scope)) return [];
      const file = this.resolve({ scope, fileId: stored.fileId });
      return file ? [file] : [];
    });
  }

  release(isolationKey: string): void {
    this.files.deleteByPrefix(executionPrefix(isolationKey));
  }
}

export const threadFileStore = new ThreadFileStore();

function executionPrefix(isolationKey: string): string {
  return `${JSON.stringify(isolationKey)}:`;
}

function sameScope(a: ThreadFileScope, b: ThreadFileScope): boolean {
  return (
    a.organizationId === b.organizationId &&
    a.userId === b.userId &&
    a.isolationKey === b.isolationKey &&
    a.chatOpsBindingId === b.chatOpsBindingId &&
    a.chatOpsThreadId === b.chatOpsThreadId
  );
}
