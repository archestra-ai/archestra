import type { GitAccess } from "@/git-hosts/git-access";
import type {
  ClientType,
  PluginMarketplaceDiscovery,
  PluginPlatform,
} from "@/types";
import { importPluginFromGithub } from "./github-import";
import {
  discoverGithubMarketplace,
  MarketplaceDiscoveryError,
  marketplaceSourceAccess,
} from "./github-marketplace";

interface GithubMarketplaceImportSelection {
  name: string;
  displayName: string;
  description: string;
  clientType: ClientType;
  supportedPlatforms: PluginPlatform[];
  sourceRepoUrl: string;
  sourceRef: string | null;
  sourceSubdir: string;
  approvedSourceSha: string;
  exclude: string[];
}

export class GithubMarketplaceChangedError extends Error {
  constructor() {
    super(
      "GitHub resolved a different commit than the one reviewed; preview again",
    );
    this.name = "GithubMarketplaceChangedError";
  }
}

/**
 * Re-resolve a reviewed marketplace snapshot and import the selected entries.
 * `marketplacePath: null` imports plugin folders discovered in a repository
 * without a marketplace manifest.
 */
export async function prepareGithubMarketplaceImports(params: {
  repoUrl: string;
  ref?: string | null;
  marketplacePath: string | null;
  approvedCommitSha: string;
  trackingRef: string | null;
  selections: GithubMarketplaceImportSelection[];
  /** Host and token of the marketplace; omitted means public github.com. */
  access?: GitAccess;
  deadlineAt?: number;
  reviewedSnapshot?: PluginMarketplaceDiscovery;
}): Promise<{
  marketplace: { repoUrl: string; path: string | null };
  prepared: Array<{
    selection: GithubMarketplaceImportSelection;
    imported: Awaited<ReturnType<typeof importPluginFromGithub>>;
    /**
     * The manifest that advertised the plugin: the marketplace manifest, or
     * the folder's own `plugin.json` when the repository has no marketplace.
     */
    manifestPath: string;
  }>;
  failed: Array<{ name: string; error: string }>;
}> {
  const canReuseReviewedSnapshot =
    params.reviewedSnapshot?.commitSha.toLowerCase() ===
      params.approvedCommitSha.toLowerCase() &&
    params.trackingRef?.toLowerCase() ===
      params.approvedCommitSha.toLowerCase() &&
    normalizeRepoUrl(params.reviewedSnapshot.repoUrl) ===
      normalizeRepoUrl(params.repoUrl) &&
    params.reviewedSnapshot.marketplacePath === params.marketplacePath;
  const trackingSnapshot = canReuseReviewedSnapshot
    ? (params.reviewedSnapshot as PluginMarketplaceDiscovery)
    : await discoverGithubMarketplace({
        repoUrl: params.repoUrl,
        ref: params.trackingRef,
        marketplacePath: params.marketplacePath ?? undefined,
        access: params.access,
      });
  assertApprovedCommit(trackingSnapshot.commitSha, params.approvedCommitSha);
  const pinnedSnapshot = canReuseReviewedSnapshot
    ? (params.reviewedSnapshot as PluginMarketplaceDiscovery)
    : await discoverGithubMarketplace({
        repoUrl: params.repoUrl,
        ref: params.approvedCommitSha,
        marketplacePath: params.marketplacePath ?? undefined,
        access: params.access,
      });
  assertApprovedCommit(pinnedSnapshot.commitSha, params.approvedCommitSha);
  if (pinnedSnapshot.reason) {
    throw new MarketplaceDiscoveryError(pinnedSnapshot.reason);
  }
  if (pinnedSnapshot.marketplacePath !== params.marketplacePath) {
    throw new MarketplaceDiscoveryError(
      params.marketplacePath
        ? "Marketplace manifest was not found"
        : "The repository now has a marketplace manifest; discover it again",
    );
  }
  const allowedSelections = new Map(
    pinnedSnapshot.entries
      .filter((entry) => entry.supported)
      .map((entry) => [entry.name.toLowerCase(), entry]),
  );

  const prepared = [];
  const failed: Array<{ name: string; error: string }> = [];
  const deadlineAt =
    params.deadlineAt ?? Date.now() + MARKETPLACE_IMPORT_DEADLINE_MS;
  let importedFileCount = 0;
  let importedBytes = 0;
  let exhaustedReason: string | null = null;
  for (const selection of params.selections) {
    if (!exhaustedReason && Date.now() >= deadlineAt) {
      exhaustedReason =
        "Marketplace import time budget was exhausted; retry with fewer plugins selected";
    }
    if (exhaustedReason) {
      failed.push({ name: selection.name, error: exhaustedReason });
      continue;
    }
    try {
      const advertised = allowedSelections.get(selection.name.toLowerCase());
      if (
        !advertised ||
        !advertised.sourceRepoUrl ||
        !advertised.sourceCommitSha
      ) {
        throw new Error("Selection is not an importable marketplace entry");
      }
      const expectedSourceRef =
        advertised.sourceRepoUrl === pinnedSnapshot.repoUrl &&
        advertised.sourceCommitSha === pinnedSnapshot.commitSha
          ? trackingSnapshot.ref
          : advertised.sourceRef;
      if (
        normalizeRepoUrl(advertised.sourceRepoUrl) !==
          normalizeRepoUrl(selection.sourceRepoUrl) ||
        normalizeSubdir(advertised.sourceSubdir) !==
          normalizeSubdir(selection.sourceSubdir) ||
        expectedSourceRef !== selection.sourceRef ||
        advertised.sourceCommitSha.toLowerCase() !==
          selection.approvedSourceSha.toLowerCase() ||
        !isImportableAs({
          advertised: advertised.clientType,
          selected: selection.clientType,
        })
      ) {
        throw new Error(
          "Selection source does not match the reviewed marketplace snapshot",
        );
      }
      const source = marketplaceSourceAccess({
        sourceRepoUrl: selection.sourceRepoUrl,
        access: params.access,
      });
      const imported = await runWithDeadline({
        deadlineAt,
        operation: () =>
          importPluginFromGithub({
            repoUrl: source.repoUrl,
            ref: selection.approvedSourceSha,
            trackingRef: selection.sourceRef,
            subdir: selection.sourceSubdir,
            exclude: selection.exclude,
            access: source.access,
            deadlineAt,
          }),
      });
      assertApprovedCommit(imported.commitSha, selection.approvedSourceSha);
      const candidateBytes = imported.files.reduce(
        (total, file) =>
          total +
          Buffer.byteLength(
            file.content,
            file.encoding === "base64" ? "base64" : "utf8",
          ),
        0,
      );
      if (
        importedFileCount + imported.files.length >
          MARKETPLACE_IMPORT_MAX_FILES ||
        importedBytes + candidateBytes > MARKETPLACE_IMPORT_MAX_BYTES
      ) {
        exhaustedReason =
          "Marketplace import aggregate payload budget was exhausted";
        throw new Error(exhaustedReason);
      }
      prepared.push({
        selection,
        imported,
        manifestPath: advertised.marketplacePath,
      });
      importedFileCount += imported.files.length;
      importedBytes += candidateBytes;
    } catch (error) {
      failed.push({
        name: selection.name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return {
    marketplace: {
      repoUrl: pinnedSnapshot.repoUrl,
      path: pinnedSnapshot.marketplacePath,
    },
    prepared,
    failed,
  };
}

// === Internal helpers ===

const MARKETPLACE_IMPORT_DEADLINE_MS = 45_000;
const MARKETPLACE_IMPORT_MAX_FILES = 5_000;
const MARKETPLACE_IMPORT_MAX_BYTES = 100 * 1024 * 1024;

function assertApprovedCommit(actual: string, approved: string): void {
  if (actual.toLowerCase() !== approved.toLowerCase()) {
    throw new GithubMarketplaceChangedError();
  }
}

function normalizeRepoUrl(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^github\.com\//, "")
    .replace(/\.git$/, "")
    .replace(/\/$/, "");
}

function normalizeSubdir(value: string): string {
  return value.trim().replace(/^\/+|\/+$/g, "");
}

async function runWithDeadline<Value>(params: {
  deadlineAt: number;
  operation: () => Promise<Value>;
}): Promise<Value> {
  const remainingMs = params.deadlineAt - Date.now();
  if (remainingMs <= 0) throw new Error("Marketplace import timed out");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      params.operation(),
      new Promise<Value>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Marketplace import timed out")),
          remainingMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Claude Code and Claude Desktop share one plugin format, so an entry a
 * marketplace advertises for either can be imported for the other.
 */
function isImportableAs(params: {
  advertised: ClientType | null;
  selected: ClientType;
}): boolean {
  if (params.advertised === params.selected) return true;
  const claudeFormat: ReadonlySet<ClientType | null> = new Set([
    "claude-code",
    "claude-desktop",
  ]);
  return (
    claudeFormat.has(params.advertised) && claudeFormat.has(params.selected)
  );
}
