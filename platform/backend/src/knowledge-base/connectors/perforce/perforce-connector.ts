import type {
  ConnectorCredentials,
  ConnectorDocument,
  ConnectorSyncBatch,
  PerforceCheckpoint,
  PerforceConfig,
} from "@/types";
import { PerforceConfigSchema } from "@/types";
import { BaseConnector } from "../base-connector";
import {
  isConnectionLevelError,
  P4ApiError,
  type P4DepotFile,
  P4FileTooLargeError,
  P4RestClient,
} from "./p4-rest-client";

/**
 * Knowledge connector for Perforce Helix Core depots.
 *
 * Syncs text files (default: .md/.yaml/.yml, customizable via `fileTypes`)
 * from one or more depot paths through the P4 REST API — see
 * {@link P4RestClient} for the transport details. No `p4` CLI binary and no
 * client workspace are involved.
 *
 * Incremental sync is driven by a changelist-number cursor:
 * - `lastChangelist` is the committed cursor — every submitted change up to
 *   it is fully ingested.
 * - While a sweep is running, `targetChangelist` pins the sweep to a fixed
 *   changelist (so listing and content stay consistent even if users submit
 *   mid-sync) and `filesOffset` records progress through the deterministic,
 *   depot-path-sorted candidate list. The sync pipeline persists the
 *   checkpoint after every batch and resumes partial/time-boxed runs from it,
 *   so an interrupted sweep continues where it stopped instead of restarting.
 *
 * File deletions are not propagated on incremental syncs (the sync pipeline
 * has no delete channel); a force re-sync rebuilds the corpus from scratch.
 *
 * `estimateTotalItems` deliberately stays at the inherited null: producing a
 * count would require the same `/v0/file/revisions` listing the sweep itself
 * performs. The client also deliberately has no retry layer — transient
 * per-file download failures are recorded on the run, and listing/auth
 * failures surface loudly.
 */
export class PerforceConnector extends BaseConnector {
  type = "perforce" as const;

  async validateConfig(
    config: Record<string, unknown>,
  ): Promise<{ valid: boolean; error?: string }> {
    return this.validateConfigWithSchema({
      config,
      parser: parsePerforceConfig,
      label: "Perforce",
      invalidConfigError:
        'Invalid Perforce configuration: serverUrl (the P4 REST API base URL, e.g. "https://perforce.example.com:8080") and at least one depot path ("//depot/path") are required',
    });
  }

  async testConnection(params: {
    config: Record<string, unknown>;
    credentials: ConnectorCredentials;
  }): Promise<{ success: boolean; error?: string }> {
    const parsed = parsePerforceConfig(params.config);
    if (!parsed) {
      return { success: false, error: "Invalid Perforce configuration" };
    }

    return this.runConnectionTest({
      label: "Perforce",
      probe: async () => {
        const client = this.createClient(parsed, params.credentials);
        // Authenticated server probe: surfaces unreachable-URL and
        // login/ticket problems.
        await client.info();
        // Listing probe: surfaces per-path permission problems.
        await client.files([`${parsed.depotPaths[0]}/...`], { max: 1 });
      },
    });
  }

  async *sync(params: {
    config: Record<string, unknown>;
    credentials: ConnectorCredentials;
    checkpoint: Record<string, unknown> | null;
    startTime?: Date;
    endTime?: Date;
  }): AsyncGenerator<ConnectorSyncBatch> {
    const parsed = parsePerforceConfig(params.config);
    if (!parsed) {
      throw new Error("Invalid Perforce configuration");
    }

    const checkpoint = (params.checkpoint as PerforceCheckpoint | null) ?? {
      type: "perforce" as const,
    };
    const client = this.createClient(parsed, params.credentials);

    const sweep = await this.resolveSweep(client, parsed, checkpoint);
    if (!sweep) {
      this.log.info(
        { checkpoint },
        "No new submitted changes, nothing to sync",
      );
      yield {
        documents: [],
        failures: this.flushFailures(),
        skipped: this.flushSkipped(),
        // Re-persist only the committed cursor fields so malformed in-flight
        // state (e.g. an orphaned filesOffset) is normalized away.
        checkpoint: {
          type: "perforce",
          lastSyncedAt: checkpoint.lastSyncedAt,
          lastChangelist: checkpoint.lastChangelist,
        },
        hasMore: false,
      };
      return;
    }
    const { target, targetTime, isResume } = sweep;

    const files = await this.listCandidateFiles({
      client,
      config: parsed,
      checkpoint,
      target,
      isResume,
    });
    // Only honor the offset when it belongs to this sweep — an orphaned
    // filesOffset (no targetChangelist) must not skip files of a fresh sweep.
    const startOffset = isResume ? (checkpoint.filesOffset ?? 0) : 0;

    this.log.info(
      {
        target,
        fromChangelist: checkpoint.lastChangelist,
        candidateFiles: files.length,
        startOffset,
      },
      "Starting Perforce sweep",
    );

    const committedCheckpoint: PerforceCheckpoint = {
      type: "perforce",
      lastSyncedAt: targetTime ?? checkpoint.lastSyncedAt,
      lastChangelist: target,
    };

    if (startOffset >= files.length) {
      yield {
        documents: [],
        failures: this.flushFailures(),
        skipped: this.flushSkipped(),
        checkpoint: committedCheckpoint,
        hasMore: false,
      };
      return;
    }

    for (let i = startOffset; i < files.length; i += BATCH_SIZE) {
      const batch = files.slice(i, i + BATCH_SIZE);
      const documents: ConnectorDocument[] = [];

      for (const file of batch) {
        await this.rateLimit();
        const content = await this.fetchFileContent(client, file, target);
        if (content !== null) {
          documents.push(depotFileToDocument(file, content, target));
        }
      }

      const nextOffset = Math.min(i + BATCH_SIZE, files.length);
      const isLastBatch = nextOffset >= files.length;

      this.log.info(
        {
          target,
          batchStart: i,
          documentsIndexed: documents.length,
          remainingFiles: files.length - nextOffset,
        },
        "Perforce batch completed",
      );

      yield {
        documents,
        failures: this.flushFailures(),
        skipped: this.flushSkipped(),
        checkpoint: isLastBatch
          ? committedCheckpoint
          : {
              type: "perforce",
              lastSyncedAt: checkpoint.lastSyncedAt,
              lastChangelist: checkpoint.lastChangelist,
              targetChangelist: target,
              targetChangeTime: targetTime,
              filesOffset: nextOffset,
            },
        hasMore: !isLastBatch,
      };
    }
  }

  // ===== Private methods =====

  private createClient(
    config: PerforceConfig,
    credentials: ConnectorCredentials,
  ): P4RestClient {
    const username = credentials.email?.trim() ?? "";
    if (!username) {
      // Enforced at runtime (not only in the UI) because connectors can also
      // be created through the API and MCP tools.
      throw new P4ApiError(
        "Perforce connector requires a username (stored in the credential email field)",
        { connectionLevel: true },
      );
    }
    return new P4RestClient({
      serverUrl: config.serverUrl,
      username,
      ticket: credentials.apiToken,
      log: this.log,
    });
  }

  /**
   * Determine the changelist this run sweeps to. Resumes an in-flight sweep
   * when the checkpoint carries one; otherwise asks the server for the latest
   * submitted change across the configured depot paths. Returns null when
   * there is nothing new to sync.
   */
  private async resolveSweep(
    client: P4RestClient,
    config: PerforceConfig,
    checkpoint: PerforceCheckpoint,
  ): Promise<{
    target: number;
    targetTime?: string;
    isResume: boolean;
  } | null> {
    if (checkpoint.targetChangelist !== undefined) {
      this.log.info(
        {
          target: checkpoint.targetChangelist,
          filesOffset: checkpoint.filesOffset,
        },
        "Resuming interrupted Perforce sweep",
      );
      return {
        target: checkpoint.targetChangelist,
        targetTime: checkpoint.targetChangeTime,
        isResume: true,
      };
    }

    let latest: { change: number; time?: string } | null = null;
    for (const depotPath of config.depotPaths) {
      const change = await client.latestChange(`${depotPath}/...`);
      if (change && (!latest || change.change > latest.change)) {
        latest = change;
      }
    }

    if (
      !latest ||
      (checkpoint.lastChangelist !== undefined &&
        latest.change <= checkpoint.lastChangelist)
    ) {
      return null;
    }
    return { target: latest.change, targetTime: latest.time, isResume: false };
  }

  /**
   * Deterministic candidate list for the sweep, pinned to `@target`:
   * extension-filtered server-side via `//path/....<ext>` filespecs, restricted
   * to the `@lastChangelist+1,@target` window on incremental runs, reduced to
   * downloadable text filetypes, filtered against `excludePaths`, deduped, and
   * sorted by depot path so `filesOffset` resumes are stable.
   */
  private async listCandidateFiles(params: {
    client: P4RestClient;
    config: PerforceConfig;
    checkpoint: PerforceCheckpoint;
    target: number;
    isResume: boolean;
  }): Promise<P4DepotFile[]> {
    const { client, config, checkpoint, target, isResume } = params;
    const revisionRange =
      checkpoint.lastChangelist === undefined
        ? `@${target}`
        : `@${checkpoint.lastChangelist + 1},@${target}`;

    const filespecs: string[] = [];
    for (const depotPath of config.depotPaths) {
      for (const extension of getIndexedExtensions(config)) {
        filespecs.push(`${depotPath}/...${extension}${revisionRange}`);
      }
    }

    // One listing request per filespec so each response stays within the
    // per-request size/timeout caps — a combined listing of a large depot's
    // initial sweep could exceed them and fail the run on every retry.
    const byDepotFile = new Map<string, P4DepotFile>();
    const skippedNonText = new Map<string, string>();
    for (const filespec of filespecs) {
      for (const file of await client.files([filespec])) {
        if (isExcluded(file.depotFile, config.excludePaths)) continue;
        if (!isTextFileType(file.type)) {
          skippedNonText.set(file.depotFile, file.type);
          continue;
        }
        const existing = byDepotFile.get(file.depotFile);
        if (!existing || file.rev > existing.rev) {
          byDepotFile.set(file.depotFile, file);
        }
      }
    }

    // Resumed continuations rebuild the same candidate list; only the fresh
    // sweep reports the skips so they are not double-counted. Deduped by
    // depot file so overlapping depot paths report each skip once.
    if (!isResume) {
      for (const [depotFile, fileType] of skippedNonText) {
        this.trackSkipped({
          itemId: depotFile,
          name: depotFile,
          reason: `unsupported Perforce filetype "${fileType}"`,
        });
      }
    }

    // Sorted by depot path so `filesOffset` resumes are stable. The offset
    // assumes the pinned listing is immutable; an admin `p4 obliterate` or
    // rename mid-sweep can shift it, which heals on the next sweep when the
    // cursor advances.
    return [...byDepotFile.values()].sort((a, b) =>
      a.depotFile < b.depotFile ? -1 : a.depotFile > b.depotFile ? 1 : 0,
    );
  }

  /**
   * Download one file at the sweep target. Oversized files are skipped,
   * connection/auth breakage aborts the run, anything else (e.g. per-file
   * permission errors) is recorded as an item failure and the sweep continues.
   */
  private async fetchFileContent(
    client: P4RestClient,
    file: P4DepotFile,
    target: number,
  ): Promise<string | null> {
    try {
      return await client.readFile(`${file.depotFile}@${target}`);
    } catch (error) {
      if (error instanceof P4FileTooLargeError) {
        this.trackSkipped({
          itemId: file.depotFile,
          name: file.depotFile,
          reason: error.message,
        });
        return null;
      }
      if (isConnectionLevelError(error)) {
        throw error;
      }
      return this.safeItemFetch({
        fetch: async () => {
          throw error;
        },
        fallback: null,
        itemId: file.depotFile,
        resource: "file_content",
      });
    }
  }
}

// ===== Module-level helpers =====

const BATCH_SIZE = 50;

const DEFAULT_FILE_EXTENSIONS = [".md", ".yaml", ".yml"];

function parsePerforceConfig(
  config: Record<string, unknown>,
): PerforceConfig | null {
  const result = PerforceConfigSchema.safeParse(config);
  return result.success ? result.data : null;
}

function getIndexedExtensions(config: PerforceConfig): string[] {
  const extensions =
    config.fileTypes && config.fileTypes.length > 0
      ? config.fileTypes
      : DEFAULT_FILE_EXTENSIONS;

  return extensions
    .map((extension) => extension.trim().toLowerCase())
    .filter(Boolean)
    .map((extension) =>
      extension.startsWith(".") ? extension : `.${extension}`,
    );
}

/**
 * Whether a depot file falls under one of the configured exclude paths.
 * Prefix match on path-segment boundaries: `//depot/docs/gen` excludes
 * `//depot/docs/gen/a.md` but not `//depot/docs/gen-notes/a.md`.
 */
function isExcluded(
  depotFile: string,
  excludePaths: string[] | undefined,
): boolean {
  if (!excludePaths || excludePaths.length === 0) return false;
  return excludePaths.some((prefix) => depotFile.startsWith(`${prefix}/`));
}

/**
 * Whether a Perforce filetype holds printable text. Matches the `text`,
 * `unicode`, and `utf8` base types plus their old-style aliases (ktext,
 * xltext, xunicode, …); excludes binary, symlink, apple, resource, tempobj,
 * and utf16. Modifiers after `+` are irrelevant to printability.
 */
function isTextFileType(fileType: string): boolean {
  const baseType = fileType.split("+")[0].toLowerCase();
  return /text|unicode|utf8/.test(baseType);
}

function depotFileToDocument(
  file: P4DepotFile,
  content: string,
  changelist: number,
): ConnectorDocument {
  const segments = file.depotFile.split("/");
  const fileName = segments.pop() ?? file.depotFile;
  return {
    // The depot path is stable across revisions, so re-syncs update the same
    // document instead of accumulating duplicates.
    id: file.depotFile,
    title: `${fileName} (${segments.join("/")})`,
    content,
    metadata: {
      depotPath: file.depotFile,
      rev: file.rev,
      changelist,
      perforceFileType: file.type,
      kind: "depot_file",
    },
  };
}
