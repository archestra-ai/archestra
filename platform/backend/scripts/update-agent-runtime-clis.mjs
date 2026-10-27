import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { gunzipSync } from "node:zlib";

/**
 * Raises the agent CLIs pinned in the agent catalog image to their newest
 * stable release that has been public for at least the cooldown. The
 * scheduled client-version workflow runs it against an automation worktree.
 *
 * A release is eligible when it is a plain stable version, no newer than the
 * upstream channel pointer, older than the cooldown, and newer than the pin.
 * Each CLI resolves on its own, so one unreachable registry does not hold back
 * the others; the script still exits non-zero after writing the rest.
 *
 * Prints one `Updated <label> <from> -> <to>` line per raised pin.
 */

const { values: options } = parseArgs({
  options: {
    "agent-dir": { type: "string" },
    "cooldown-days": { type: "string", default: "7" },
    now: { type: "string" },
  },
});

const agentDir =
  options["agent-dir"] ??
  path.resolve(import.meta.dirname, "../../docker_images/agent");
const dockerfilePath = path.join(agentDir, "Dockerfile");
const openclawPackagePath = path.join(agentDir, "openclaw/package.json");
const cooldownDays = Number(options["cooldown-days"]);
if (!Number.isFinite(cooldownDays) || cooldownDays < 0) {
  throw new Error(`Invalid cooldown: ${options["cooldown-days"]}`);
}
const now = options.now ? new Date(options.now) : new Date();
if (Number.isNaN(now.getTime())) {
  throw new Error(`Invalid --now: ${options.now}`);
}
const publishedBefore = now.getTime() - cooldownDays * 24 * 60 * 60 * 1000;

const STABLE_SEMVER = /^\d+\.\d+\.\d+$/;
const HERMES_REPOSITORY = "NousResearch/hermes-agent";
const GROK_ARCHES = [
  ["amd64", "x64"],
  ["arm64", "arm64"],
];

const npmRegistry = (
  process.env.NPM_CONFIG_REGISTRY || "https://registry.npmjs.org"
).replace(/\/+$/, "");
// GitHub Actions sets GITHUB_API_URL; a token lifts the anonymous rate limit.
const githubApiUrl = (
  process.env.GITHUB_API_URL || "https://api.github.com"
).replace(/\/+$/, "");
const githubToken = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "";
// The same channel pointer and fallback that https://x.ai/cli/install.sh reads.
const grokStableUrls = (
  process.env.GROK_STABLE_URLS ||
  "https://x.ai/cli/stable https://storage.googleapis.com/grok-build-public-artifacts/cli/stable"
).split(/\s+/);

/**
 * One entry per agent catalog Dockerfile target. A test fails when a target is
 * added to the Dockerfile without an entry here.
 */
const AGENT_RUNTIME_CLIS = [
  {
    target: "agent-claude-code",
    label: "Claude Code",
    // Anthropic's stable channel trails `latest` by about a week.
    resolve: () =>
      resolveNpm({ name: "@anthropic-ai/claude-code", channel: "stable" }),
    read: (files) =>
      readSingleVersion(files.dockerfile, [
        /@anthropic-ai\/claude-code@(\d+\.\d+\.\d+)\b/g,
        /"lastOnboardingVersion":"(\d+\.\d+\.\d+)"/g,
      ]),
    write: (files, version) => {
      files.dockerfile = replaceVersion(
        files.dockerfile,
        [
          /(@anthropic-ai\/claude-code@)\d+\.\d+\.\d+\b/g,
          /("lastOnboardingVersion":")\d+\.\d+\.\d+(?=")/g,
        ],
        version,
      );
    },
  },
  {
    target: "agent-codex",
    label: "Codex",
    resolve: () => resolveNpm({ name: "@openai/codex", channel: "latest" }),
    read: (files) =>
      readSingleVersion(files.dockerfile, [
        /@openai\/codex@(\d+\.\d+\.\d+)\b/g,
      ]),
    write: (files, version) => {
      files.dockerfile = replaceVersion(
        files.dockerfile,
        [/(@openai\/codex@)\d+\.\d+\.\d+\b/g],
        version,
      );
    },
  },
  {
    target: "agent-opencode",
    label: "OpenCode",
    resolve: () => resolveNpm({ name: "opencode-ai", channel: "latest" }),
    read: (files) =>
      readSingleVersion(files.dockerfile, [
        /add --global opencode-ai@(\d+\.\d+\.\d+)\b/g,
      ]),
    write: (files, version) => {
      files.dockerfile = replaceVersion(
        files.dockerfile,
        [/(add --global opencode-ai@)\d+\.\d+\.\d+\b/g],
        version,
      );
    },
  },
  {
    target: "agent-hermes",
    label: "Hermes",
    // Hermes ships only from source; PyPI stopped at 0.19.0. The image builds
    // the release commit, so the pin carries the tag's version and commit.
    resolve: () => resolveGithubReleases(HERMES_REPOSITORY),
    read: (files) =>
      readSingleVersion(files.dockerfile, [
        /\bhermes_version=(\d+\.\d+\.\d+)\b/g,
      ]),
    write: async (files, version) => {
      const commit = await githubTagCommit(HERMES_REPOSITORY, `v${version}`);
      let dockerfile = replaceVersion(
        files.dockerfile,
        [/(\bhermes_version=)\d+\.\d+\.\d+\b/g],
        version,
      );
      dockerfile = replaceExactlyOnce(
        dockerfile,
        /(\bhermes_commit=)[0-9a-f]{40}\b/g,
        `$1${commit}`,
      );
      files.dockerfile = dockerfile;
    },
  },
  {
    target: "agent-openclaw",
    label: "OpenClaw",
    // OpenClaw republishes a release as `<version>-<n>`.
    resolve: () =>
      resolveNpm({
        name: "openclaw",
        channel: "latest",
        pattern: /^\d+\.\d+\.\d+(?:-\d+)?$/,
      }),
    read: (files) => {
      const version = JSON.parse(files.openclawPackage).dependencies?.openclaw;
      if (!/^\d+\.\d+\.\d+(?:-\d+)?$/.test(version ?? "")) {
        throw new Error(`Expected an exact openclaw pin, found ${version}`);
      }
      return version;
    },
    write: (files, version) => {
      const manifest = JSON.parse(files.openclawPackage);
      manifest.dependencies.openclaw = version;
      files.openclawPackage = `${JSON.stringify(manifest, null, 2)}\n`;
    },
  },
  {
    target: "agent-grok",
    label: "Grok CLI",
    resolve: resolveGrok,
    read: (files) =>
      readSingleVersion(files.dockerfile, [
        /@xai-official\/grok-linux-\$\{grok_arch\}@(\d+\.\d+\.\d+)\b/g,
        /xai-official-grok-linux-\$\{grok_arch\}-(\d+\.\d+\.\d+)\.tgz/g,
      ]),
    write: async (files, version) => {
      let dockerfile = replaceVersion(
        files.dockerfile,
        [
          /(@xai-official\/grok-linux-\$\{grok_arch\}@)\d+\.\d+\.\d+\b/g,
          /(xai-official-grok-linux-\$\{grok_arch\}-)\d+\.\d+\.\d+(?=\.tgz)/g,
        ],
        version,
      );
      for (const [dockerArch, grokArch] of GROK_ARCHES) {
        const checksum = await grokBinaryChecksum(grokArch, version);
        dockerfile = replaceExactlyOnce(
          dockerfile,
          new RegExp(
            `(${dockerArch}\\) grok_arch=${grokArch}; checksum=)[0-9a-f]{64}`,
            "g",
          ),
          `$1${checksum}`,
        );
      }
      files.dockerfile = dockerfile;
    },
  },
  {
    target: "agent-kimi",
    label: "Kimi Code",
    resolve: () =>
      resolveNpm({ name: "@moonshot-ai/kimi-code", channel: "latest" }),
    read: (files) =>
      readSingleVersion(files.dockerfile, [
        /@moonshot-ai\/kimi-code@(\d+\.\d+\.\d+)\b/g,
      ]),
    write: async (files, version) => {
      const checksum = await npmTarballSha512(
        "@moonshot-ai/kimi-code",
        version,
      );
      let dockerfile = replaceVersion(
        files.dockerfile,
        [/(@moonshot-ai\/kimi-code@)\d+\.\d+\.\d+\b/g],
        version,
      );
      dockerfile = replaceExactlyOnce(
        dockerfile,
        /(echo ")[0-9a-f]{128}(  kimi-code\.tgz")/g,
        `$1${checksum}$2`,
      );
      files.dockerfile = dockerfile;
    },
  },
];

// =============================================================================
// Main
// =============================================================================

const files = {
  dockerfile: readFileSync(dockerfilePath, "utf8"),
  openclawPackage: readFileSync(openclawPackagePath, "utf8"),
};
const dockerfileTargets = [
  ...files.dockerfile.matchAll(/^FROM \S+ AS (agent-(?!base\b)\S+)$/gm),
].map((match) => match[1]);
const registeredTargets = AGENT_RUNTIME_CLIS.map((cli) => cli.target);
const unregistered = dockerfileTargets.filter(
  (target) => !registeredTargets.includes(target),
);
if (unregistered.length > 0) {
  throw new Error(
    `Register these Dockerfile targets in update-agent-runtime-clis.mjs: ${unregistered.join(", ")}`,
  );
}

const failures = [];
for (const cli of AGENT_RUNTIME_CLIS) {
  try {
    const current = cli.read(files);
    const { releases, ceiling, pattern } = await cli.resolve();
    const next = pickEligibleVersion({ releases, ceiling, pattern, current });
    if (!next) {
      process.stdout.write(`${cli.label} remains ${current}\n`);
      continue;
    }
    await cli.write(files, next);
    process.stdout.write(`Updated ${cli.label} ${current} -> ${next}\n`);
  } catch (error) {
    failures.push(cli.label);
    process.stderr.write(
      `Could not update ${cli.label}: ${error instanceof Error ? error.message : error}\n`,
    );
  }
}

writeFileSync(dockerfilePath, files.dockerfile);
writeFileSync(openclawPackagePath, files.openclawPackage);

if (failures.length > 0) {
  process.stderr.write(
    `Unresolved agent runtime CLIs: ${failures.join(", ")}\n`,
  );
  process.exitCode = 1;
}

// =============================================================================
// Internal helpers
// =============================================================================

function pickEligibleVersion({ releases, ceiling, pattern, current }) {
  let best = null;
  for (const { version, publishedAt } of releases) {
    if (
      pattern.test(version) &&
      publishedAt <= publishedBefore &&
      compareVersions(version, ceiling) <= 0 &&
      compareVersions(version, current) > 0 &&
      (best === null || compareVersions(version, best) > 0)
    ) {
      best = version;
    }
  }
  return best;
}

async function resolveNpm({ name, channel, pattern = STABLE_SEMVER }) {
  const packument = await fetchJson(`${npmRegistry}/${encodeNpmName(name)}`);
  const ceiling = packument["dist-tags"]?.[channel];
  if (!pattern.test(ceiling ?? "")) {
    throw new Error(
      `npm ${name}@${channel} is not a stable version: ${ceiling}`,
    );
  }
  return { releases: npmReleases(packument), ceiling, pattern };
}

// Releases tagged `vX.Y.Z`; `releases/latest` is the ceiling, which also keeps
// older calendar-versioned tags (`v2026.9.24`) out of the comparison.
async function resolveGithubReleases(repository) {
  const latest = await fetchGithub(`/repos/${repository}/releases/latest`);
  const ceiling = /^v(\d+\.\d+\.\d+)$/.exec(latest.tag_name ?? "")?.[1];
  if (!ceiling) {
    throw new Error(
      `${repository} latest release is not a vX.Y.Z tag: ${latest.tag_name}`,
    );
  }
  const releases = (
    await fetchGithub(`/repos/${repository}/releases?per_page=100`)
  ).flatMap((release) => {
    const version = /^v(\d+\.\d+\.\d+)$/.exec(release.tag_name ?? "")?.[1];
    const publishedAt = Date.parse(release.published_at ?? "");
    return version &&
      !release.draft &&
      !release.prerelease &&
      !Number.isNaN(publishedAt)
      ? [{ version, publishedAt }]
      : [];
  });
  return { releases, ceiling, pattern: STABLE_SEMVER };
}

async function githubTagCommit(repository, tag) {
  const { sha } = await fetchGithub(`/repos/${repository}/commits/${tag}`);
  if (!/^[0-9a-f]{40}$/.test(sha ?? "")) {
    throw new Error(`${repository} ${tag} has no commit`);
  }
  return sha;
}

// The npm `latest` tag of the Grok binary packages is stale; xAI's stable
// channel pointer is the ceiling, and both architectures must have shipped.
async function resolveGrok() {
  let ceiling = "";
  const errors = [];
  for (const url of grokStableUrls) {
    try {
      ceiling = (await fetchText(url)).trim().split(/\s+/)[0];
      break;
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (!STABLE_SEMVER.test(ceiling)) {
    throw new Error(
      `No valid stable Grok CLI version (${ceiling || errors.join("; ")})`,
    );
  }
  const perArch = await Promise.all(
    GROK_ARCHES.map(async ([, grokArch]) =>
      npmReleases(
        await fetchJson(
          `${npmRegistry}/${encodeNpmName(`@xai-official/grok-linux-${grokArch}`)}`,
        ),
      ),
    ),
  );
  const [first, ...rest] = perArch;
  const releases = first.flatMap(({ version, publishedAt }) => {
    const others = rest.map((list) =>
      list.find((release) => release.version === version),
    );
    if (others.some((release) => !release)) return [];
    return [
      {
        version,
        publishedAt: Math.max(
          publishedAt,
          ...others.map((release) => release.publishedAt),
        ),
      },
    ];
  });
  return { releases, ceiling, pattern: STABLE_SEMVER };
}

// The Dockerfile verifies the unpacked `package/bin/grok.br`, not the tarball.
async function grokBinaryChecksum(grokArch, version) {
  const name = `@xai-official/grok-linux-${grokArch}`;
  const manifest = await fetchJson(
    `${npmRegistry}/${encodeNpmName(name)}/${version}`,
  );
  const { tarball, integrity } = manifest.dist ?? {};
  const match = /^sha512-(.+)$/.exec(integrity ?? "");
  if (!tarball || !match) {
    throw new Error(`${name}@${version} has no sha512 integrity`);
  }
  const archive = Buffer.from(await (await fetchOk(tarball)).arrayBuffer());
  const digest = createHash("sha512").update(archive).digest("base64");
  if (digest !== match[1]) {
    throw new Error(`${name}@${version} tarball does not match its integrity`);
  }
  const binary = readTarEntry(gunzipSync(archive), "package/bin/grok.br");
  return createHash("sha256").update(binary).digest("hex");
}

// The Dockerfile verifies the packed tarball against the registry's own
// integrity, which is its SHA-512.
async function npmTarballSha512(name, version) {
  const manifest = await fetchJson(
    `${npmRegistry}/${encodeNpmName(name)}/${version}`,
  );
  const match = /^sha512-(.+)$/.exec(manifest.dist?.integrity ?? "");
  if (!match) {
    throw new Error(`${name}@${version} has no sha512 integrity`);
  }
  const digest = Buffer.from(match[1], "base64");
  if (digest.length !== 64) {
    throw new Error(`${name}@${version} has a malformed sha512 integrity`);
  }
  return digest.toString("hex");
}

function readTarEntry(tar, wanted) {
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const field = (start, end) =>
      header.subarray(start, end).toString("utf8").replace(/\0.*$/s, "");
    const prefix = field(345, 500);
    const name = prefix ? `${prefix}/${field(0, 100)}` : field(0, 100);
    const size = Number.parseInt(field(124, 136).trim() || "0", 8);
    const start = offset + 512;
    if (name === wanted) return tar.subarray(start, start + size);
    offset = start + Math.ceil(size / 512) * 512;
  }
  throw new Error(`Tarball has no ${wanted}`);
}

function npmReleases(packument) {
  return Object.keys(packument.versions ?? {}).flatMap((version) => {
    const publishedAt = Date.parse(packument.time?.[version] ?? "");
    return Number.isNaN(publishedAt) ? [] : [{ version, publishedAt }];
  });
}

function readSingleVersion(source, patterns) {
  const found = new Set();
  for (const pattern of patterns) {
    const matches = [...source.matchAll(pattern)];
    if (matches.length !== 1) {
      throw new Error(`Expected exactly one match for ${pattern}`);
    }
    found.add(matches[0][1]);
  }
  if (found.size !== 1) {
    throw new Error(`Pins disagree: ${[...found].join(", ")}`);
  }
  return [...found][0];
}

function replaceVersion(source, patterns, version) {
  return patterns.reduce(
    (text, pattern) => replaceExactlyOnce(text, pattern, `$1${version}`),
    source,
  );
}

function replaceExactlyOnce(source, pattern, replacement) {
  const count = [...source.matchAll(pattern)].length;
  if (count !== 1) {
    throw new Error(
      `Expected exactly one match for ${pattern}, found ${count}`,
    );
  }
  return source.replace(pattern, replacement);
}

function compareVersions(left, right) {
  const leftParts = left.split(/[.-]/).map(BigInt);
  const rightParts = right.split(/[.-]/).map(BigInt);
  for (
    let index = 0;
    index < Math.max(leftParts.length, rightParts.length);
    index++
  ) {
    const difference = (leftParts[index] ?? 0n) - (rightParts[index] ?? 0n);
    if (difference !== 0n) return difference > 0n ? 1 : -1;
  }
  return 0;
}

function encodeNpmName(name) {
  return name.replace("/", "%2F");
}

async function fetchJson(url) {
  return (await fetchOk(url)).json();
}

async function fetchGithub(path) {
  const headers = { accept: "application/vnd.github+json" };
  if (githubToken) headers.authorization = `Bearer ${githubToken}`;
  return (await fetchOk(`${githubApiUrl}${path}`, headers)).json();
}

async function fetchText(url) {
  return (await fetchOk(url)).text();
}

async function fetchOk(url, headers = {}) {
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    throw new Error(`GET ${url} returned ${response.status}`);
  }
  return response;
}
