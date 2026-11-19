// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { RouteId } from "@archestra/shared";
import type { FastifyReply } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
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
 * decided server-side by `resolveVafAddOnDistribution`: the package compiled
 * into this platform image, else the newest release that actually carries
 * the package — never a URL that is known to 404.
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
          "installation: a verified direct package download URL (the package " +
          "compiled into this platform image, served by the backend's package " +
          "route, or a release asset), or null when the install script " +
          "compiles from source instead. The connector form probes this for " +
          "its download link.",
        tags: ["Knowledge Bases"],
        response: constructResponseSchema(
          z.object({
            /**
             * Verified package URL — absolute for release assets, relative
             * (this backend's package route) for the package compiled into
             * the platform image. Null when no pre-built package exists for
             * this installation.
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
          "Serve the M-Files connector's VAF Add On package compiled into this " +
          "platform image. 404 when the image carries none.",
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

      const packed = await resolvePackedPackage();
      if (packed) {
        // Read per request rather than pinning the bytes in memory: the file
        // is local, ~1MB, and the route is rate-limited. The versioned
        // filename means a file a person keeps says which version it is.
        return sendPackage(reply, packed.filename, await readFile(packed.path));
      }

      throw new ApiError(404, "No add-on package compiled into this image.");
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

/** The package download response. */
function sendPackage(
  reply: FastifyReply,
  filename: string,
  bytes: Buffer,
): FastifyReply {
  return reply
    .header("Content-Type", "application/octet-stream")
    .header("Content-Disposition", `attachment; filename="${filename}"`)
    .header("Cache-Control", "no-store")
    .send(bytes);
}

/** Single-quote a value for PowerShell (embedded quotes double). */
function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * The bootstrap the copyable command pipes into `iex`: fetch the static
 * installer from the public frontend origin and run it with the resolved
 * package source. With no source resolved the installer runs on its own
 * defaults — it compiles from source (its vault picker asks for everything
 * else interactively).
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
    const packageUrl = source.packageUrl.startsWith("/")
      ? `${origin}${source.packageUrl}`
      : source.packageUrl;
    lines.push(`    PackageUrl = ${psQuote(packageUrl)}`);
    lines.push(`    Ref = ${psQuote(source.ref)}`);
  }
  lines.push("}", "& ([scriptblock]::Create($installer)) @vafAddOnParams", "");
  return lines.join("\n");
}

const GITHUB_REPO = "archestra-ai/archestra";
const GITHUB_API_BASE = `https://api.github.com/repos/${GITHUB_REPO}`;
const VAF_ADD_ON_ASSET_NAME = "archestra-m-files-vaf-add-on.mfappx";
const RELEASE_PIN_TTL_MS = 60 * 60 * 1000;
const GITHUB_FETCH_TIMEOUT_MS = 3_000;

/**
 * What the install command distributes, beyond the installer's defaults: a
 * pre-built package, with its release tag as the build-from-source fallback
 * ref. A packageUrl starting with `/` is this backend's package route and is
 * made absolute against the public frontend origin at render time.
 */
interface VafAddOnInstallSource {
  packageUrl: string;
  ref: string;
}

interface VafAddOnDistribution {
  /** Installer parameters; null = the installer's own defaults. */
  install: VafAddOnInstallSource | null;
  /**
   * Verified direct package download; absolute for release assets, relative
   * for the backend package route; null = no pre-built package exists.
   */
  downloadUrl: string | null;
}

/**
 * Decides what the install command and the form's download link distribute,
 * in precedence order:
 *
 * 1. The package compiled into this platform image (the Dockerfile's
 *    vaf-add-on-builder stage): built from the exact source this platform
 *    ships with and served by the package route — no GitHub involved.
 * 2. The newest release that carries the package — for deployments running
 *    outside the image (dev stacks), where the packed directory does not
 *    exist. The add-on publishes on its own `m-files-vaf-add-on-v*` release
 *    track: this repository's releases are immutable, so the package can
 *    never be attached to the platform release, which publishes before the
 *    add-on build runs. Compatibility is negotiated by the extension
 *    protocol's schema version, not by pairing release versions. The
 *    install command fetches the stable-named asset (a temp file — the name
 *    never surfaces), while the download link prefers the versioned twin so
 *    a file a person keeps says which version it is.
 * 3. Installer defaults (compile from source), no download link.
 */
async function resolveVafAddOnDistribution(): Promise<VafAddOnDistribution> {
  const packed = await resolvePackedPackage();
  if (packed) {
    const packageUrl = MFILES_VAF_ADD_ON_PACKAGE_PATH;
    return {
      install: { packageUrl, ref: packed.ref },
      downloadUrl: packageUrl,
    };
  }

  const release = await resolveNewestReleaseAsset();
  if (release) {
    return {
      install: { packageUrl: release.packageUrl, ref: release.ref },
      downloadUrl: release.downloadUrl,
    };
  }
  return { install: null, downloadUrl: null };
}

interface PackedVafAddOnPackage {
  /** Absolute path of the versioned `.mfappx` on disk. */
  path: string;
  /** Its versioned filename — what a downloaded file is called. */
  filename: string;
  /**
   * The version's release tag, `m-files-vaf-add-on-v<version>` — the
   * installer's build-from-source fallback ref.
   */
  ref: string;
}

/**
 * The add-on package compiled into this platform image, or null where the
 * configured directory holds no versioned package — deployments running
 * outside the image (dev stacks). The versioned file is required (the
 * stable-named copy alone carries no version to derive the ref from); the
 * image always writes both. Resolved once per directory — image contents
 * don't change under a running backend.
 */
const packedPackageCache = new Map<
  string,
  Promise<PackedVafAddOnPackage | null>
>();
function resolvePackedPackage(): Promise<PackedVafAddOnPackage | null> {
  const dir = config.kb.mfilesVafAddOnPackageDir;
  let resolved = packedPackageCache.get(dir);
  if (!resolved) {
    resolved = readPackedPackage(dir);
    packedPackageCache.set(dir, resolved);
  }
  return resolved;
}

async function readPackedPackage(
  dir: string,
): Promise<PackedVafAddOnPackage | null> {
  try {
    const versioned = (await readdir(dir))
      .filter(isVersionedVafAddOnAssetName)
      // Newest when several are present (never the case in the image);
      // numeric compare so 1.10.0 sorts above 1.9.0.
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      .pop();
    if (!versioned) return null;
    const version = versioned.slice(
      VAF_ADD_ON_ASSET_NAME.length - ".mfappx".length + 1,
      -".mfappx".length,
    );
    return {
      path: join(dir, versioned),
      filename: versioned,
      ref: `m-files-vaf-add-on-v${version}`,
    };
  } catch {
    return null;
  }
}

interface VafAddOnReleaseAssets {
  /** Stable-named asset: the install command's package source. */
  packageUrl: string;
  /**
   * What the form's download button serves: the versioned twin when the
   * release carries one — a downloaded file then says which version it is,
   * and two versions don't overwrite each other on disk — else the
   * stable-named asset.
   */
  downloadUrl: string;
  /** Release tag; doubles as the build-from-source fallback git ref. */
  ref: string;
}

/**
 * The add-on package on the newest release that actually carries it. The
 * stable-named asset is the marker that a release carries the package at
 * all; a scan is the only safe lookup — `releases/latest` is the platform
 * release, which cannot carry the package — so a link is only offered when
 * the asset is verified to exist. Definitive GitHub answers are cached;
 * transient failures are not, so the next probe retries.
 */
async function resolveNewestReleaseAsset(): Promise<VafAddOnReleaseAssets | null> {
  // `-assets`: earlier deployments cached other shapes under `-newest` (a
  // bare URL string) and `-newest-install` (no downloadUrl) — a fresh key
  // keeps a persisted cache from serving those here.
  const cacheKey =
    `${CacheKey.MfilesVafAddOnReleasePin}-newest-assets` as const;
  const cached = await cacheManager.get<VafAddOnReleaseAssets | "none">(
    cacheKey,
  );
  if (cached) return cached === "none" ? null : cached;

  let source: VafAddOnReleaseAssets | null = null;
  try {
    const response = await fetch(`${GITHUB_API_BASE}/releases?per_page=30`, {
      headers: { Accept: "application/vnd.github.v3+json" },
      signal: AbortSignal.timeout(GITHUB_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const releases = (await response.json()) as Array<{
      tag_name?: string;
      assets?: Array<{ name: string; browser_download_url: string }>;
    }>;
    for (const release of releases) {
      const stable = release.assets?.find(
        (a) => a.name === VAF_ADD_ON_ASSET_NAME,
      );
      if (stable && release.tag_name) {
        const versioned = release.assets?.find((a) =>
          isVersionedVafAddOnAssetName(a.name),
        );
        source = {
          packageUrl: stable.browser_download_url,
          downloadUrl: (versioned ?? stable).browser_download_url,
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

/** `archestra-m-files-vaf-add-on-<version>.mfappx`, e.g. `-1.0.0`. */
function isVersionedVafAddOnAssetName(name: string): boolean {
  const [base, extension] = [
    VAF_ADD_ON_ASSET_NAME.replace(/\.mfappx$/, ""),
    ".mfappx",
  ];
  return (
    name.startsWith(`${base}-`) &&
    name.endsWith(extension) &&
    name.length > base.length + 1 + extension.length
  );
}
