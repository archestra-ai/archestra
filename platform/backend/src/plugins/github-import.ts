import { GIT_PROVIDER_LABELS, type GitProvider } from "@archestra/shared";
import type { GitAccess } from "@/git-hosts/git-access";
import type { PluginFileInput } from "@/types/plugin";
import {
  PLUGIN_MAX_FILE_BYTES,
  PLUGIN_MAX_TOTAL_BYTES,
} from "@/types/plugin-file-constraints";
import {
  createPluginRepoReader,
  type PluginRepoReader,
  parsePluginRepoUrl,
  pluginSourceHost,
} from "./plugin-repo-reader";
import { collectPluginTreeFiles } from "./plugin-tree-files";

interface ImportedPlugin {
  /** Repository path: `owner/repo`, or a nested GitLab `group/sub/project`. */
  repo: string;
  requestedRef: string | null;
  commitSha: string;
  subdir: string;
  files: PluginFileInput[];
  skippedFiles: string[];
  sourceProvider: GitProvider;
  /** Web address of a self-hosted source; null means the provider's cloud. */
  sourceOrigin: string | null;
}

export class PluginImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluginImportError";
  }
}

/**
 * Normalize any accepted repository URL to the stored repository path
 * (`owner/repo`, or a nested GitLab path) on the access's host.
 */
export function normalizePluginRepoUrl(params: {
  repoUrl: string;
  access?: GitAccess;
}): string {
  return parseSource({
    repoUrl: params.repoUrl,
    reader: createPluginRepoReader(params.access),
  }).path;
}

/**
 * Resolve one repository tree on GitHub or GitLab (cloud or self-hosted) to
 * immutable, by-value plugin bytes. This service never executes or interprets
 * hook configuration and always strips transport configuration (`.mcp.json`)
 * plus repository policy/CI files.
 */
export async function importPluginFromGithub(params: {
  repoUrl: string;
  ref?: string | null;
  /** Branch/tag recorded for future update checks while `ref` may be a SHA. */
  trackingRef?: string | null;
  subdir?: string;
  exclude?: string[];
  /** Host and token; omitted means public github.com. */
  access?: GitAccess;
  deadlineAt?: number;
}): Promise<ImportedPlugin> {
  const deadlineSignal = params.deadlineAt
    ? AbortSignal.timeout(Math.max(1, params.deadlineAt - Date.now()))
    : undefined;
  const reader = createPluginRepoReader(params.access);
  const source = parseSource({ ...params, reader });
  const requestedRef =
    params.trackingRef !== undefined
      ? params.trackingRef
      : (source.ref ?? params.ref ?? null);
  // A pinned commit always wins over the tracking branch at resolution time:
  // the branch may have moved since the review the caller approved, and
  // resolving the branch would race the approval check that follows.
  const ref = params.ref ?? requestedRef ?? null;

  const commitSha = await reader
    .resolveCommit({ repo: source.path, ref, signal: deadlineSignal })
    .catch((error) => {
      throw new PluginImportError(errorMessage(error));
    });
  assertWithinDeadline(params.deadlineAt);
  const tree = await reader
    .readTree({ repo: source.path, commitSha, signal: deadlineSignal })
    .catch((error) => {
      throw new PluginImportError(
        `Could not read repository tree: ${errorMessage(error)}`,
      );
    });
  assertWithinDeadline(params.deadlineAt);
  const collected = collectPluginTreeFiles({
    tree,
    subdir: source.subdir,
    exclude: params.exclude,
  });
  if (collected.unsafePath) {
    throw new PluginImportError(
      `Repository contains unsafe plugin path: ${collected.unsafePath}`,
    );
  }
  const { candidates, skippedFiles } = collected;

  candidates.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  const downloaded = await downloadCandidates({
    candidates,
    reader,
    repo: source.path,
    commitSha,
    deadlineAt: params.deadlineAt,
    signal: deadlineSignal,
  });
  const files: PluginFileInput[] = [];
  let downloadedBytes = 0;
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    const bytes = downloaded[index];
    if (
      bytes === null ||
      bytes.length > PLUGIN_MAX_FILE_BYTES ||
      downloadedBytes + bytes.length > PLUGIN_MAX_TOTAL_BYTES
    ) {
      skippedFiles.push(candidate.relativePath);
      continue;
    }
    downloadedBytes += bytes.length;
    const decoded = decodeContent(bytes);
    files.push({
      path: candidate.relativePath,
      content: decoded.content,
      encoding: decoded.encoding,
      mode: candidate.mode,
    });
  }

  if (files.length === 0) {
    throw new PluginImportError(
      "Imported subtree contains no importable files after exclusions",
    );
  }
  const lowerPaths = files.map((file) => file.path.toLowerCase());
  if (new Set(lowerPaths).size !== lowerPaths.length) {
    throw new PluginImportError(
      "Imported subtree contains file paths that collide ignoring case",
    );
  }

  return {
    repo: source.path,
    requestedRef,
    commitSha,
    subdir: source.subdir,
    files,
    skippedFiles: skippedFiles.sort(),
    ...pluginSourceHost(reader.host),
  };
}

// === Internal helpers ===

const FILE_DOWNLOAD_CONCURRENCY = 6;

function parseSource(params: {
  repoUrl: string;
  subdir?: string;
  reader: PluginRepoReader;
}): { path: string; ref: string | null; subdir: string } {
  let location: ReturnType<typeof parsePluginRepoUrl>;
  try {
    location = parsePluginRepoUrl({
      repoUrl: params.repoUrl,
      host: params.reader.host,
    });
  } catch (error) {
    throw new PluginImportError(errorMessage(error));
  }
  return {
    path: location.path,
    ref: location.ref,
    // an empty subdir defers to a folder named in the URL
    subdir: normalizeSubdir(params.subdir || location.subpath),
  };
}

function normalizeSubdir(value: string): string {
  const normalized = value.trim().replace(/^\/+|\/+$/g, "");
  if (
    normalized.includes("\\") ||
    normalized.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    throw new PluginImportError("Subdirectory must be a safe relative path");
  }
  return normalized;
}

async function fetchRawFile(params: {
  reader: PluginRepoReader;
  repo: string;
  commitSha: string;
  path: string;
  maxBytes: number;
  deadlineAt?: number;
  signal?: AbortSignal;
}): Promise<Buffer | null> {
  const timeoutMs = params.deadlineAt
    ? Math.min(10_000, params.deadlineAt - Date.now())
    : 10_000;
  if (timeoutMs <= 0) throw new PluginImportError("Plugin import timed out");
  try {
    return await params.reader.readFile({
      repo: params.repo,
      commitSha: params.commitSha,
      path: params.path,
      maxBytes: params.maxBytes,
      timeoutMs,
      signal: params.signal,
    });
  } catch (error) {
    throw new PluginImportError(
      `Could not fetch ${params.path} from ${GIT_PROVIDER_LABELS[params.reader.host.provider]} (${errorMessage(error)}); retry the import`,
    );
  }
}

/**
 * Downloads every candidate with bounded concurrency. Serial fetches let one
 * slow network eat the batch deadline a file at a time; a small worker pool
 * keeps the per-file timeout the failure unit instead. The pool stops once
 * enough bytes are in flight to fill the aggregate budget — the assembly pass
 * then applies the per-file and total limits in sorted path order, exactly as
 * a serial loop would.
 */
async function downloadCandidates(params: {
  candidates: ReturnType<typeof collectPluginTreeFiles>["candidates"];
  reader: PluginRepoReader;
  repo: string;
  commitSha: string;
  deadlineAt?: number;
  signal?: AbortSignal;
}): Promise<Array<Buffer | null>> {
  const { candidates } = params;
  const downloaded: Array<Buffer | null> = new Array(candidates.length).fill(
    null,
  );
  let nextCandidate = 0;
  let budgetedBytes = 0;
  const workerCount = Math.min(FILE_DOWNLOAD_CONCURRENCY, candidates.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextCandidate < candidates.length) {
        if (budgetedBytes >= PLUGIN_MAX_TOTAL_BYTES) return;
        assertWithinDeadline(params.deadlineAt);
        const index = nextCandidate;
        nextCandidate += 1;
        const candidate = candidates[index];
        const bytes = await fetchRawFile({
          reader: params.reader,
          repo: params.repo,
          commitSha: params.commitSha,
          path: candidate.repoPath,
          maxBytes: PLUGIN_MAX_FILE_BYTES,
          deadlineAt: params.deadlineAt,
          signal: params.signal,
        });
        downloaded[index] = bytes;
        budgetedBytes += bytes?.length ?? 0;
      }
    }),
  );
  return downloaded;
}

function decodeContent(bytes: Buffer): {
  content: string;
  encoding: "utf8" | "base64";
} {
  try {
    return {
      content: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      encoding: "utf8",
    };
  } catch {
    return { content: bytes.toString("base64"), encoding: "base64" };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertWithinDeadline(deadlineAt: number | undefined): void {
  if (deadlineAt !== undefined && Date.now() >= deadlineAt) {
    throw new PluginImportError("Plugin import timed out");
  }
}
