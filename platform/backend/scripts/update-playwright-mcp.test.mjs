import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const execute = promisify(execFile);
const script = new URL("./update-playwright-mcp.mjs", import.meta.url).pathname;
const initialMetadata = JSON.parse(
  await readFile(
    new URL("../src/playwright-mcp-image.json", import.meta.url),
    "utf8",
  ),
);
const digest = (value) =>
  `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;

async function setup(t, options = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "upstream-playwright-"));
  const file = path.join(dir, "image.json");
  const initial = JSON.stringify({ ...initialMetadata, ...options.previous });
  await writeFile(file, initial);
  t.after(() => rm(dir, { recursive: true, force: true }));
  const routes = new Map();
  const manifests = [];
  for (const architecture of options.missingArm
    ? ["amd64"]
    : ["amd64", "arm64"]) {
    const config = {
      architecture,
      config: {
        Env: [
          `NODE_VERSION=${architecture === "arm64" && options.armNode ? options.armNode : "24.21.0"}`,
        ],
      },
    };
    const configDigest = digest(config);
    routes.set(`/v2/playwright/mcp/blobs/${configDigest}`, config);
    const manifest = { config: { digest: configDigest } },
      manifestDigest = digest(manifest);
    routes.set(
      `/v2/playwright/mcp/manifests/${manifestDigest}`,
      options.tamper ? { invalid: true } : manifest,
    );
    manifests.push({
      digest: manifestDigest,
      platform: { os: "linux", architecture },
    });
  }
  const index = { manifests };
  routes.set("/v2/playwright/mcp/manifests/v0.0.83", index);
  routes.set("/v2/playwright/mcp/manifests/v0.0.84", index);
  const dependencies = {
    playwright: "1.65.0",
    "playwright-core": options.badDependencies ? "1.64.0" : "1.65.0",
  };
  routes.set("/@playwright%2fmcp", {
    "dist-tags": { latest: options.latest || "0.0.85" },
    versions: {
      "0.0.83": { dependencies },
      "0.0.84": { dependencies },
      "0.0.85": { dependencies },
    },
    time: {
      "0.0.83": "2026-09-01T00:00:00Z",
      "0.0.84": "2026-10-01T00:00:00Z",
      "0.0.85": "2026-10-25T00:00:00Z",
    },
  });
  const server = createServer((req, res) => {
    const body = routes.get(new URL(req.url, "http://localhost").pathname);
    if (options.failRegistry) {
      res.writeHead(503).end();
      return;
    }
    if (!body) {
      res.writeHead(404).end();
      return;
    }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(body));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  async function run(...args) {
    try {
      return {
        status: 0,
        ...(await execute(
          process.execPath,
          [script, "--file", file, "--now", "2026-10-26T00:00:00Z", ...args],
          {
            env: {
              ...process.env,
              NPM_CONFIG_REGISTRY: url,
              PLAYWRIGHT_MCR_REGISTRY: url,
            },
          },
        )),
      };
    } catch (error) {
      return { status: error.code, stdout: error.stdout, stderr: error.stderr };
    }
  }
  return { file, initial, index, run };
}

test("pins the mature upstream release and actual runtime metadata, then becomes a no-op", async (t) => {
  const fixture = await setup(t);
  const result = await fixture.run();
  assert.equal(result.status, 0, result.stderr);
  const next = JSON.parse(await readFile(fixture.file, "utf8"));
  assert.equal(next.mcpVersion, "0.0.84"); // 0.0.85 is within the release cooldown
  assert.equal(
    next.image,
    `mcr.microsoft.com/playwright/mcp@${digest(fixture.index)}`,
  );
  assert.equal(next.nodeVersion, "24.21.0"); // Record upstream; do not build a replacement runtime.
  assert.equal(next.playwrightVersion, "1.65.0");
  const saved = await readFile(fixture.file, "utf8");
  assert.equal((await fixture.run()).status, 0);
  assert.equal(await readFile(fixture.file, "utf8"), saved);
});

for (const [name, options, message] of [
  [
    "missing architecture",
    { missingArm: true },
    /Missing or ambiguous linux\/arm64/,
  ],
  [
    "inconsistent architecture runtimes",
    { armNode: "24.22.1" },
    /different Node versions/,
  ],
  ["tampered manifest", { tamper: true }, /manifest digest mismatch/],
  ["registry failure", { failRegistry: true }, /HTTP 503/],
  [
    "unstable latest channel",
    { latest: "0.0.86-beta.1" },
    /not a stable version/,
  ],
  [
    "mismatched Playwright dependencies",
    { badDependencies: true },
    /dependencies disagree/,
  ],
  [
    "MCP downgrade",
    { previous: { mcpVersion: "0.0.86" } },
    /No non-downgrading MCP release/,
  ],
])
  test(`rejects ${name} without changing the pin`, async (t) => {
    const fixture = await setup(t, options);
    const result = await fixture.run();
    assert.equal(result.status, 1);
    assert.match(result.stderr, message);
    assert.equal(await readFile(fixture.file, "utf8"), fixture.initial);
  });

test("offline metadata check does not require registry access or Docker", async (t) => {
  const fixture = await setup(t, { failRegistry: true });
  assert.equal((await fixture.run("--check")).status, 0);
  await writeFile(
    fixture.file,
    JSON.stringify({
      ...initialMetadata,
      image: "mcr.microsoft.com/playwright/mcp:latest",
    }),
  );
  assert.match(
    (await fixture.run("--check")).stderr,
    /Invalid upstream Playwright MCP image metadata/,
  );
});
