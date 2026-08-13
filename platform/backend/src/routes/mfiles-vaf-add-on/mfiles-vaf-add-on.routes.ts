// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { RouteId } from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import JSZip from "jszip";
import { z } from "zod";
import { isRateLimited } from "@/agents/utils";
import { CacheKey, cacheManager } from "@/cache-manager";
import config from "@/config";
import { ApiError, constructResponseSchema } from "@/types";
import {
  MFILES_VAF_ADD_ON_PACKAGE_PATH,
  MFILES_VAF_ADD_ON_SCRIPT_PATH,
} from "../route-paths";

/**
 * Distribution of the Archestra VAF Add On. The connector form shows one
 * static command — `irm '<origin>/api/mfiles-vaf-add-on/script' | iex` —
 * and the script route below serves a bootstrap that runs the installer
 * with the server-resolved package source. Nothing else rides along: the
 * add-on takes no credentials or identities, the installer picks the vault
 * interactively, so the command needs no per-form parameters, no tokens and
 * no one-time links.
 *
 * The bootstrap and the form's download link install the same package,
 * decided server-side by `resolveVafAddOnDistribution`: the development
 * source-ref override first (branch CI build proxied by the package route,
 * or a source build), then the newest release that actually carries the
 * package — never a URL that is known to 404.
 */
const mfilesVafAddOnRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    MFILES_VAF_ADD_ON_SCRIPT_PATH,
    {
      schema: {
        operationId: RouteId.GetMfilesVafAddOnScript,
        description:
          "Serve the M-Files connector's VAF Add On install bootstrap: a tiny PowerShell " +
          "script that fetches the static installer and runs it with the " +
          "server-resolved package source. Identical for every caller — it " +
          "carries no credentials or per-user state.",
        tags: ["Knowledge Bases"],
        // no `response` schema: returns text/plain PowerShell. The global
        // error handler formats 4xx/5xx as JSON, which `irm | iex` refuses
        // to execute, so error bodies are never run.
      },
    },
    async (request, reply) => {
      assertMfilesConnectorEnabled();
      const limited = await isRateLimited(
        `${CacheKey.MfilesVafAddOnPackageRateLimit}-script-${request.ip}`,
        { windowMs: 60_000, maxRequests: 10 },
      );
      if (limited) throw new ApiError(429, "Too many requests");

      const distribution = await resolveVafAddOnDistribution();
      return reply
        .header("Content-Type", "text/plain; charset=utf-8")
        .header("Cache-Control", "no-store")
        .header("X-Content-Type-Options", "nosniff")
        .send(renderVafAddOnBootstrap(distribution.install));
    },
  );

  fastify.get(
    "/api/mfiles-vaf-add-on/distribution",
    {
      schema: {
        operationId: RouteId.GetMfilesVafAddOnDistribution,
        description:
          "Resolve how the M-Files connector's VAF Add On is distributed to this " +
          "installation: a verified direct package download URL (release " +
          "asset or the dev source-ref CI build proxied by the backend), or " +
          "null when the install script compiles from source instead. The " +
          "connector form probes this for its download link.",
        tags: ["Knowledge Bases"],
        response: constructResponseSchema(
          z.object({
            /**
             * Verified package URL — absolute for release assets, relative
             * (this backend's package route) for dev CI builds. Null when no
             * pre-built package exists for this installation.
             */
            packageDownloadUrl: z.string().nullable(),
          }),
        ),
      },
    },
    async (_request, reply) => {
      assertMfilesConnectorEnabled();
      const distribution = await resolveVafAddOnDistribution();
      return reply.send({ packageDownloadUrl: distribution.downloadUrl });
    },
  );

  fastify.get(
    MFILES_VAF_ADD_ON_PACKAGE_PATH,
    {
      schema: {
        operationId: RouteId.GetMfilesVafAddOnPackage,
        description:
          "Serve the M-Files connector's VAF Add On package built by CI for the " +
          "configured development source ref " +
          "(ARCHESTRA_KNOWLEDGE_BASE_MFILES_VAF_ADD_ON_SOURCE_REF). 404 when " +
          "the override is unset or no CI build exists for it.",
        tags: ["Knowledge Bases"],
        // no `response` schema: streams the binary `.mfappx`.
      },
    },
    async (request, reply) => {
      assertMfilesConnectorEnabled();
      const limited = await isRateLimited(
        `${CacheKey.MfilesVafAddOnPackageRateLimit}-${request.ip}`,
        { windowMs: 60_000, maxRequests: 10 },
      );
      if (limited) throw new ApiError(429, "Too many requests");

      const bytes = await fetchCiPackageBytes();
      if (!bytes) {
        throw new ApiError(
          404,
          "No CI-built add-on package for the configured source ref.",
        );
      }
      return reply
        .header("Content-Type", "application/octet-stream")
        .header(
          "Content-Disposition",
          `attachment; filename="${VAF_ADD_ON_ASSET_NAME}"`,
        )
        .header("Cache-Control", "no-store")
        .send(bytes);
    },
  );
};

export default mfilesVafAddOnRoutes;

// ===================================================================
// Internal helpers
// ===================================================================

/**
 * These routes are public (the install command must be fetchable from the
 * M-Files server without a session), so while the M-Files connector beta
 * flag is off they answer 404 — indistinguishable from the feature not
 * existing.
 */
function assertMfilesConnectorEnabled(): void {
  if (!config.kb.mfilesConnectorEnabled) {
    throw new ApiError(404, "Not found");
  }
}

/** Single-quote a value for PowerShell (embedded quotes double). */
function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * The bootstrap the copyable command pipes into `iex`: fetch the static
 * installer from the public frontend origin and run it with the resolved
 * package source. With no source resolved the installer runs on its own
 * defaults (its vault picker asks for everything else interactively).
 */
function renderVafAddOnBootstrap(source: VafAddOnInstallSource | null): string {
  const origin = config.frontendBaseUrl.replace(/\/+$/, "");
  const lines = [
    "# VAF Add On install (from the M-Files connector form)",
    '$ErrorActionPreference = "Stop"',
    `$installer = Invoke-RestMethod ${psQuote(`${origin}/scripts/install-m-files-vaf-add-on.ps1`)}`,
    "$vafAddOnParams = @{",
  ];
  if (source) {
    if ("buildFromSource" in source) {
      lines.push("    BuildFromSource = $true");
    } else {
      const packageUrl = source.packageUrl.startsWith("/")
        ? `${origin}${source.packageUrl}`
        : source.packageUrl;
      lines.push(`    PackageUrl = ${psQuote(packageUrl)}`);
    }
    lines.push(`    Ref = ${psQuote(source.ref)}`);
  }
  lines.push("}", "& ([scriptblock]::Create($installer)) @vafAddOnParams", "");
  return lines.join("\n");
}

const execFileAsync = promisify(execFile);

const GITHUB_REPO = "archestra-ai/archestra";
const GITHUB_API_BASE = `https://api.github.com/repos/${GITHUB_REPO}`;
const VAF_ADD_ON_ASSET_NAME = "archestra-m-files-vaf-add-on.mfappx";
const VAF_ADD_ON_WORKFLOW_FILE = "build-m-files-vaf-add-on.yml";
const VAF_ADD_ON_CI_ARTIFACT_NAME = "m-files-vaf-add-on";
const RELEASE_PIN_TTL_MS = 60 * 60 * 1000;
/** Short — "last known CI build" should pick up a fresh push quickly. */
const CI_ARTIFACT_TTL_MS = 5 * 60 * 1000;
const GITHUB_FETCH_TIMEOUT_MS = 3_000;

/** What the install command distributes, beyond the installer's defaults. */
type VafAddOnInstallSource =
  /**
   * Pre-built package; ref doubles as the build-from-source fallback. A
   * packageUrl starting with `/` is this backend's package proxy route and
   * is made absolute against the public frontend origin at render time.
   */
  | { packageUrl: string; ref: string }
  /** Dev override without a CI build: compile from this git ref. */
  | { buildFromSource: true; ref: string };

interface VafAddOnDistribution {
  /** Installer parameters; null = the installer's own defaults. */
  install: VafAddOnInstallSource | null;
  /**
   * Verified direct package download; absolute for release assets, relative
   * for the backend package proxy; null = no pre-built package exists.
   */
  downloadUrl: string | null;
}

function githubHeaders(): Record<string, string> {
  const token = config.kb.mfilesVafAddOnGithubToken;
  return {
    Accept: "application/vnd.github.v3+json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

/**
 * Decides what the install command and the form's download link distribute,
 * in precedence order:
 *
 * 1. `ARCHESTRA_KNOWLEDGE_BASE_MFILES_VAF_ADD_ON_SOURCE_REF` development
 *    override — a git ref of this repo, or `local` for this checkout's HEAD.
 *    With a CI build of that ref available (and the GitHub token needed to
 *    fetch it), both the command and the link go through the backend package
 *    proxy; otherwise the command compiles from the ref's source.
 * 2. The newest release that carries the package. The add-on publishes on
 *    its own `m-files-vaf-add-on-v*` release track: this repository's
 *    releases are immutable, so the package can never be attached to the
 *    platform release, which publishes before the add-on build runs.
 *    Compatibility is negotiated by the extension protocol's schema version,
 *    not by pairing release versions.
 * 3. Installer defaults, no download link.
 */
async function resolveVafAddOnDistribution(): Promise<VafAddOnDistribution> {
  const override = config.kb.mfilesVafAddOnSourceRef;
  if (override) {
    const ref = override === "local" ? await localCheckoutCommit() : override;
    if (ref) {
      const artifact = await resolveCiArtifact(ref);
      if (artifact && config.kb.mfilesVafAddOnGithubToken) {
        const packageUrl = MFILES_VAF_ADD_ON_PACKAGE_PATH;
        return { install: { packageUrl, ref }, downloadUrl: packageUrl };
      }
      return { install: { buildFromSource: true, ref }, downloadUrl: null };
    }
  }

  const release = await resolveNewestReleaseAsset();
  if (release) return { install: release, downloadUrl: release.packageUrl };
  return { install: null, downloadUrl: null };
}

/**
 * HEAD commit of the git checkout this backend runs from (dev stacks); null
 * where there is no checkout (production images). Resolved once — a running
 * backend's code doesn't change commits under it.
 */
let cachedLocalCheckoutCommit: Promise<string | null> | undefined;
function localCheckoutCommit(): Promise<string | null> {
  cachedLocalCheckoutCommit ??= execFileAsync("git", ["rev-parse", "HEAD"], {
    timeout: 3_000,
  }).then(
    ({ stdout }) => {
      const sha = stdout.trim();
      return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
    },
    () => null,
  );
  return cachedLocalCheckoutCommit;
}

interface CiArtifactRef {
  id: number;
  archiveDownloadUrl: string;
}

/**
 * Latest successful CI build of the add-on for the given ref (branch name or
 * full commit SHA): the newest matching run of the build workflow that still
 * has the artifact. Listing is public; only the artifact download itself
 * needs the token. Cached briefly so "last known build" follows new pushes.
 */
async function resolveCiArtifact(ref: string): Promise<CiArtifactRef | null> {
  const cacheKey = `${CacheKey.MfilesVafAddOnCiArtifact}-${ref}` as const;
  const cached = await cacheManager.get<CiArtifactRef | "none">(cacheKey);
  if (cached) return cached === "none" ? null : cached;

  let artifact: CiArtifactRef | null = null;
  try {
    const refParam = /^[0-9a-f]{40}$/.test(ref)
      ? `head_sha=${ref}`
      : `branch=${encodeURIComponent(ref)}`;
    const runsResponse = await fetch(
      `${GITHUB_API_BASE}/actions/workflows/${VAF_ADD_ON_WORKFLOW_FILE}/runs?status=success&per_page=1&${refParam}`,
      {
        headers: githubHeaders(),
        signal: AbortSignal.timeout(GITHUB_FETCH_TIMEOUT_MS),
      },
    );
    if (!runsResponse.ok) return null;
    const runs = (await runsResponse.json()) as {
      workflow_runs?: Array<{ artifacts_url: string }>;
    };
    const artifactsUrl = runs.workflow_runs?.[0]?.artifacts_url;
    if (artifactsUrl) {
      const artifactsResponse = await fetch(artifactsUrl, {
        headers: githubHeaders(),
        signal: AbortSignal.timeout(GITHUB_FETCH_TIMEOUT_MS),
      });
      if (!artifactsResponse.ok) return null;
      const artifacts = (await artifactsResponse.json()) as {
        artifacts?: Array<{
          id: number;
          name: string;
          expired: boolean;
          archive_download_url: string;
        }>;
      };
      const match = artifacts.artifacts?.find(
        (a) => a.name === VAF_ADD_ON_CI_ARTIFACT_NAME && !a.expired,
      );
      if (match) {
        artifact = {
          id: match.id,
          archiveDownloadUrl: match.archive_download_url,
        };
      }
    }
    await cacheManager.set(cacheKey, artifact ?? "none", CI_ARTIFACT_TTL_MS);
  } catch {
    return null;
  }
  return artifact;
}

/**
 * The `.mfappx` bytes of the source ref's CI build. GitHub requires
 * authentication for artifact downloads even on public repositories, and
 * wraps every artifact in a zip — so the backend downloads with the
 * configured token, unwraps, and serves the raw package. The unwrapped bytes
 * are kept for the artifact's cache window (a new build has a new artifact
 * id and replaces them).
 */
let cachedPackage: { artifactId: number; bytes: Buffer } | null = null;
async function fetchCiPackageBytes(): Promise<Buffer | null> {
  const override = config.kb.mfilesVafAddOnSourceRef;
  const token = config.kb.mfilesVafAddOnGithubToken;
  if (!override || !token) return null;
  const ref = override === "local" ? await localCheckoutCommit() : override;
  if (!ref) return null;

  const artifact = await resolveCiArtifact(ref);
  if (!artifact) return null;
  if (cachedPackage?.artifactId === artifact.id) return cachedPackage.bytes;

  try {
    const response = await fetch(artifact.archiveDownloadUrl, {
      headers: githubHeaders(),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) return null;
    const zip = await JSZip.loadAsync(await response.arrayBuffer());
    const entry = zip.file(/\.mfappx$/)[0];
    if (!entry) return null;
    const bytes = await entry.async("nodebuffer");
    cachedPackage = { artifactId: artifact.id, bytes };
    return bytes;
  } catch {
    return null;
  }
}

/**
 * The add-on package on the newest release that actually carries it, as an
 * install source: the verified asset URL, plus the release tag as the
 * build-from-source fallback ref (add-on release tags are ordinary git tags
 * on main commits). A scan is the only safe lookup — `releases/latest` is
 * the platform release, which cannot carry the package — so a link is only
 * offered when the asset is verified to exist. Definitive GitHub answers are
 * cached; transient failures are not, so the next probe retries.
 */
async function resolveNewestReleaseAsset(): Promise<{
  packageUrl: string;
  ref: string;
} | null> {
  // `-install`: the previous shape cached under `-newest` was a bare URL
  // string, indistinguishable from "none"-style sentinels for this shape.
  const cacheKey =
    `${CacheKey.MfilesVafAddOnReleasePin}-newest-install` as const;
  const cached = await cacheManager.get<
    { packageUrl: string; ref: string } | "none"
  >(cacheKey);
  if (cached) return cached === "none" ? null : cached;

  let source: { packageUrl: string; ref: string } | null = null;
  try {
    const response = await fetch(`${GITHUB_API_BASE}/releases?per_page=30`, {
      headers: githubHeaders(),
      signal: AbortSignal.timeout(GITHUB_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const releases = (await response.json()) as Array<{
      tag_name?: string;
      assets?: Array<{ name: string; browser_download_url: string }>;
    }>;
    for (const release of releases) {
      const asset = release.assets?.find(
        (a) => a.name === VAF_ADD_ON_ASSET_NAME,
      );
      if (asset && release.tag_name) {
        source = {
          packageUrl: asset.browser_download_url,
          ref: release.tag_name,
        };
        break;
      }
    }
    await cacheManager.set(cacheKey, source ?? "none", RELEASE_PIN_TTL_MS);
  } catch {
    return null;
  }
  return source;
}
