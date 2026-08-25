import type {
  ClientType,
  PluginMarketplaceDiscovery,
  PluginPlatform,
} from "@/types";
import { importPluginFromGithub } from "./github-import";
import {
  discoverGithubMarketplace,
  MarketplaceDiscoveryError,
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

export async function prepareGithubMarketplaceImports(params: {
  repoUrl: string;
  ref?: string | null;
  marketplacePath: string;
  approvedCommitSha: string;
  trackingRef: string | null;
  selections: GithubMarketplaceImportSelection[];
  githubToken?: string;
  deadlineAt?: number;
  reviewedSnapshot?: PluginMarketplaceDiscovery;
}): Promise<{
  marketplace: { repoUrl: string; path: string };
  prepared: Array<{
    selection: GithubMarketplaceImportSelection;
    imported: Awaited<ReturnType<typeof importPluginFromGithub>>;
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
        marketplacePath: params.marketplacePath,
        githubToken: params.githubToken,
      });
  assertApprovedCommit(trackingSnapshot.commitSha, params.approvedCommitSha);
  const pinnedSnapshot = canReuseReviewedSnapshot
    ? (params.reviewedSnapshot as PluginMarketplaceDiscovery)
    : await discoverGithubMarketplace({
        repoUrl: params.repoUrl,
        ref: params.approvedCommitSha,
        marketplacePath: params.marketplacePath,
        githubToken: params.githubToken,
      });
  assertApprovedCommit(pinnedSnapshot.commitSha, params.approvedCommitSha);
  if (!pinnedSnapshot.marketplacePath || pinnedSnapshot.reason) {
    throw new MarketplaceDiscoveryError(
      pinnedSnapshot.reason ?? "Marketplace manifest was not found",
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
        advertised.clientType !== selection.clientType
      ) {
        throw new Error(
          "Selection source does not match the reviewed marketplace snapshot",
        );
      }
      const imported = await runWithDeadline({
        deadlineAt,
        operation: () =>
          importPluginFromGithub({
            repoUrl: selection.sourceRepoUrl,
            ref: selection.approvedSourceSha,
            trackingRef: selection.sourceRef,
            subdir: selection.sourceSubdir,
            exclude: selection.exclude,
            githubToken: params.githubToken,
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
      prepared.push({ selection, imported });
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
