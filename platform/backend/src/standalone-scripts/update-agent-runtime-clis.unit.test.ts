import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";

const scriptPath = path.resolve(
  import.meta.dirname,
  "../../scripts/update-agent-runtime-clis.mjs",
);
const realAgentDir = path.resolve(
  import.meta.dirname,
  "../../../docker_images/agent",
);
const NOW = "2026-10-25T00:00:00Z";
const OLD = "2026-10-01T00:00:00Z";
const RECENT = "2026-10-24T00:00:00Z";

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

test("raises each CLI to its newest stable release outside the cooldown", async () => {
  const agentDir = makeAgentDir();
  const grok = makeGrokTarball("new grok binary");
  const registry = await startRegistry({
    npm: {
      "@anthropic-ai/claude-code": packument({
        tags: { stable: "2.1.300", latest: "2.1.310" },
        versions: { "2.1.299": OLD, "2.1.300": OLD, "2.1.310": OLD },
      }),
      "@openai/codex": packument({
        tags: { latest: "0.164.0" },
        versions: {
          "0.160.0": OLD,
          "0.160.0-linux-x64": OLD,
          "0.163.0-alpha.2": OLD,
          "0.164.0": RECENT,
        },
      }),
      "opencode-ai": packument({
        tags: { latest: "1.19.4" },
        versions: { "1.19.3": OLD, "0.0.0-dev-202610250607": OLD },
      }),
      openclaw: packument({
        tags: { latest: "2026.10.7" },
        versions: {
          "2026.10.6": OLD,
          "2026.10.6-2": OLD,
          "2026.10.10-beta.3": OLD,
        },
      }),
      ...grokPackuments({ "1.0.70": OLD, "1.0.71": OLD }, { "1.0.70": OLD }),
    },
    grokTarball: grok.tarball,
    pypi: {
      "hermes-agent": pypiProject({
        latest: "0.21.0",
        releases: {
          "0.20.0": [{ time: OLD }],
          "0.21.0": [{ time: OLD, yanked: true }],
        },
      }),
    },
    grokStable: "1.0.71",
  });

  const result = await runUpdater(agentDir, registry);

  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  expect(result.stdout.split("\n").filter(Boolean)).toEqual([
    "Updated Claude Code 2.1.285 -> 2.1.300",
    "Updated Codex 0.153.0 -> 0.160.0",
    "Updated OpenCode 1.18.23 -> 1.19.3",
    "Updated Hermes 0.19.0 -> 0.20.0",
    "Updated OpenClaw 2026.7.1-2 -> 2026.10.6-2",
    "Updated Grok CLI 1.0.67 -> 1.0.70",
  ]);
  expect(readFileSync(path.join(agentDir, "Dockerfile"), "utf8")).toBe(
    FIXTURE_DOCKERFILE.replaceAll("2.1.285", "2.1.300")
      .replace("@openai/codex@0.153.0", "@openai/codex@0.160.0")
      .replace("opencode-ai@1.18.23", "opencode-ai@1.19.3")
      .replace("[mcp]==0.19.0", "[mcp]==0.20.0")
      .replaceAll("1.0.67", "1.0.70")
      .replace(/checksum=a{64}/, `checksum=${grok.binarySha256}`)
      .replace(/checksum=b{64}/, `checksum=${grok.binarySha256}`),
  );
  expect(
    JSON.parse(
      readFileSync(path.join(agentDir, "openclaw/package.json"), "utf8"),
    ),
  ).toEqual({ private: true, dependencies: { openclaw: "2026.10.6-2" } });
});

test("never moves a pin backwards past the channel pointer", async () => {
  const agentDir = makeAgentDir();
  const registry = await startRegistry({
    npm: {
      ...allNpmAt({ codex: "0.150.0" }),
      "@openai/codex": packument({
        tags: { latest: "0.150.0" },
        versions: { "0.150.0": OLD },
      }),
    },
    pypi: { "hermes-agent": pypiProject({ latest: "0.19.0", releases: {} }) },
    grokStable: "1.0.67",
  });

  const result = await runUpdater(agentDir, registry);

  expect(result.status).toBe(0);
  expect(result.stdout).toContain("Codex remains 0.153.0");
  expect(readFileSync(path.join(agentDir, "Dockerfile"), "utf8")).toBe(
    FIXTURE_DOCKERFILE,
  );
});

test("updates the reachable CLIs and fails for an unreachable registry", async () => {
  const agentDir = makeAgentDir();
  const registry = await startRegistry({
    npm: {
      ...allNpmAt({}),
      "@openai/codex": packument({
        tags: { latest: "0.160.0" },
        versions: { "0.160.0": OLD },
      }),
    },
    pypi: {},
    grokStable: "1.0.67",
  });

  const result = await runUpdater(agentDir, registry);

  expect(result.status).toBe(1);
  expect(result.stdout).toContain("Updated Codex 0.153.0 -> 0.160.0");
  expect(result.stderr).toContain("Could not update Hermes");
  expect(result.stderr).toContain("Unresolved agent runtime CLIs: Hermes");
  expect(readFileSync(path.join(agentDir, "Dockerfile"), "utf8")).toContain(
    "@openai/codex@0.160.0",
  );
});

test("refuses a Dockerfile target it does not know how to update", async () => {
  const agentDir = makeAgentDir(
    `${FIXTURE_DOCKERFILE}\nFROM agent-base AS agent-newcomer\n`,
  );
  const registry = await startRegistry({ npm: {}, pypi: {}, grokStable: "" });

  const result = await runUpdater(agentDir, registry);

  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("agent-newcomer");
});

// Pins the contract with the real image: every catalog target is registered
// and every pin the updater edits is found exactly once.
test("reads every pin in the real agent catalog Dockerfile", async () => {
  const agentDir = mkdtempSync(path.join(tmpdir(), "agent-runtime-real-"));
  cleanups.push(() => rmSync(agentDir, { recursive: true, force: true }));
  cpSync(
    path.join(realAgentDir, "Dockerfile"),
    path.join(agentDir, "Dockerfile"),
  );
  mkdirSync(path.join(agentDir, "openclaw"));
  cpSync(
    path.join(realAgentDir, "openclaw/package.json"),
    path.join(agentDir, "openclaw/package.json"),
  );
  // Every channel points at a version below any real pin.
  const registry = await startRegistry({
    npm: allNpmAt({
      claude: "0.0.1",
      codex: "0.0.1",
      opencode: "0.0.1",
      openclaw: "0.0.1",
    }),
    pypi: { "hermes-agent": pypiProject({ latest: "0.0.1", releases: {} }) },
    grokStable: "0.0.1",
  });

  const result = await runUpdater(agentDir, registry);

  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  expect(result.stdout.match(/ remains /g)).toHaveLength(6);
});

// =============================================================================
// Fixtures
// =============================================================================

const FIXTURE_DOCKERFILE = `FROM node:24 AS agent-base
FROM agent-base AS agent-claude-code
RUN pnpm --config.ignore-scripts=false add --global @anthropic-ai/claude-code@2.1.285 \\
 && printf '%s\\n' '{"hasCompletedOnboarding":true,"lastOnboardingVersion":"2.1.285"}' > /home/node/.claude.json
FROM agent-base AS agent-codex
RUN pnpm add --global @openai/codex@0.153.0
FROM agent-base AS agent-opencode
RUN pnpm add --global opencode-ai@1.18.23 \\
 && OPENCODE_PACKAGE_DIR="$(pnpm list --global --json opencode-ai)"
FROM agent-base AS agent-hermes
RUN /opt/hermes/bin/pip install --no-cache-dir 'hermes-agent[mcp]==0.19.0'
FROM agent-base AS agent-openclaw
COPY docker_images/agent/openclaw /opt/agent-openclaw
FROM agent-base AS agent-grok
RUN case "$TARGETARCH" in \\
      amd64) grok_arch=x64; checksum=${"a".repeat(64)} ;; \\
      arm64) grok_arch=arm64; checksum=${"b".repeat(64)} ;; \\
    esac \\
 && npm pack --silent "@xai-official/grok-linux-\${grok_arch}@1.0.67" \\
 && tar -xzf "xai-official-grok-linux-\${grok_arch}-1.0.67.tgz"
`;

function makeAgentDir(dockerfile = FIXTURE_DOCKERFILE) {
  const directory = mkdtempSync(path.join(tmpdir(), "agent-runtime-clis-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(path.join(directory, "Dockerfile"), dockerfile);
  mkdirSync(path.join(directory, "openclaw"));
  writeFileSync(
    path.join(directory, "openclaw/package.json"),
    `${JSON.stringify({ private: true, dependencies: { openclaw: "2026.7.1-2" } }, null, 2)}\n`,
  );
  return directory;
}

function makeGrokTarball(binary: string) {
  const directory = mkdtempSync(path.join(tmpdir(), "grok-tarball-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(path.join(directory, "package/bin"), { recursive: true });
  writeFileSync(path.join(directory, "package/bin/grok.br"), binary);
  spawnSync("tar", ["-czf", "grok.tgz", "package"], { cwd: directory });
  return {
    tarball: readFileSync(path.join(directory, "grok.tgz")),
    binarySha256: createHash("sha256").update(binary).digest("hex"),
  };
}

function packument({
  tags,
  versions,
}: {
  tags: Record<string, string>;
  versions: Record<string, string>;
}) {
  return {
    "dist-tags": tags,
    versions: Object.fromEntries(
      Object.keys(versions).map((version) => [version, {}]),
    ),
    time: versions,
  };
}

function grokPackuments(
  x64: Record<string, string>,
  arm64: Record<string, string>,
) {
  return {
    "@xai-official/grok-linux-x64": packument({
      tags: { latest: "0.1.220" },
      versions: x64,
    }),
    "@xai-official/grok-linux-arm64": packument({
      tags: { latest: "0.1.220" },
      versions: arm64,
    }),
  };
}

// Packuments whose channel already sits at (or below) the fixture pins.
function allNpmAt(
  ceilings: Partial<
    Record<"claude" | "codex" | "opencode" | "openclaw", string>
  >,
) {
  const at = (version: string, tag = "latest") =>
    packument({ tags: { [tag]: version }, versions: { [version]: OLD } });
  return {
    "@anthropic-ai/claude-code": at(ceilings.claude ?? "2.1.285", "stable"),
    "@openai/codex": at(ceilings.codex ?? "0.153.0"),
    "opencode-ai": at(ceilings.opencode ?? "1.18.23"),
    openclaw: at(ceilings.openclaw ?? "2026.7.1-2"),
    ...grokPackuments({}, {}),
  };
}

function pypiProject({
  latest,
  releases,
}: {
  latest: string;
  releases: Record<string, { time: string; yanked?: boolean }[]>;
}) {
  return {
    info: { version: latest },
    releases: Object.fromEntries(
      Object.entries(releases).map(([version, uploads]) => [
        version,
        uploads.map(({ time, yanked = false }) => ({
          upload_time_iso_8601: time,
          yanked,
        })),
      ]),
    ),
  };
}

async function startRegistry({
  npm,
  pypi,
  grokStable,
  grokTarball,
}: {
  npm: Record<string, ReturnType<typeof packument>>;
  pypi: Record<string, ReturnType<typeof pypiProject>>;
  grokStable: string;
  grokTarball?: Buffer;
}) {
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://registry");
    const send = (status: number, body: unknown) => {
      response.writeHead(status);
      response.end(
        Buffer.isBuffer(body) || typeof body === "string"
          ? body
          : JSON.stringify(body),
      );
    };
    if (url.pathname === "/grok/stable") return send(200, `${grokStable}\n`);
    if (url.pathname === "/grok.tgz" && grokTarball) {
      return send(200, grokTarball);
    }
    const pypiMatch = /^\/pypi\/(.+)\/json$/.exec(url.pathname);
    if (pypiMatch) {
      const project = pypi[pypiMatch[1]];
      return project ? send(200, project) : send(404, {});
    }
    const npmPath = decodeURIComponent(url.pathname.slice(1));
    const [, name, version] =
      /^(@[^/]+\/[^/]+|[^@/][^/]*)(?:\/(.+))?$/.exec(npmPath) ?? [];
    const document = name ? npm[name] : undefined;
    if (!document) return send(404, {});
    if (!version) return send(200, document);
    if (!grokTarball) return send(404, {});
    const integrity = `sha512-${createHash("sha512").update(grokTarball).digest("base64")}`;
    return send(200, {
      dist: { tarball: `${baseUrl}/grok.tgz`, integrity },
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => server.close());
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return baseUrl;
}

function runUpdater(agentDir: string, registry: string) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>(
    (resolve) => {
      const child = spawn(
        process.execPath,
        [scriptPath, "--agent-dir", agentDir, "--now", NOW],
        {
          env: {
            ...process.env,
            NPM_CONFIG_REGISTRY: registry,
            PYPI_URL: registry,
            GROK_STABLE_URLS: `${registry}/grok/stable`,
          },
        },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("close", (status) => resolve({ status, stdout, stderr }));
    },
  );
}
