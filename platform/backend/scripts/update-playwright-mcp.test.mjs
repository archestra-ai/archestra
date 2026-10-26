import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const execute = promisify(execFile);
const fixture = new URL("../../docker_images/playwright_mcp/", import.meta.url);
const script = new URL("./update-playwright-mcp.mjs", import.meta.url).pathname;
const jsonDigest = (value) =>
  `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;

async function setup(t, options = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "playwright-updater-"));
  await cp(fixture, dir, { recursive: true });
  t.after(() => rm(dir, { recursive: true, force: true }));
  const initial = await readFile(path.join(dir, "versions.json"), "utf8");
  const dockerfile = await readFile(path.join(dir, "Dockerfile"), "utf8");
  const routes = new Map();
  function registry(repository, nodeVersion, missingArm = false) {
    const manifests = [];
    for (const architecture of missingArm ? ["amd64"] : ["amd64", "arm64"]) {
      const config = {
        architecture,
        config: {
          Env: [
            `NODE_VERSION=${repository === "library/node" && architecture === "arm64" && options.nodeArmVersion ? options.nodeArmVersion : nodeVersion}`,
          ],
        },
      };
      const configDigest = jsonDigest(config);
      routes.set(`/v2/${repository}/blobs/${configDigest}`, config);
      const manifest = { config: { digest: configDigest } };
      const digest = jsonDigest(manifest);
      routes.set(
        `/v2/${repository}/manifests/${digest}`,
        options.tamper ? { invalid: true } : manifest,
      );
      manifests.push({ digest, platform: { os: "linux", architecture } });
    }
    return { manifests };
  }
  const mcp = registry("playwright/mcp", "24.21.0", options.missingArm);
  routes.set("/v2/playwright/mcp/manifests/v0.0.84", mcp);
  routes.set("/v2/playwright/mcp/manifests/v0.0.83", mcp);
  const node = registry("library/node", options.node || "24.22.2");
  routes.set("/v2/library/node/manifests/24-bookworm-slim", node);
  routes.set("/token", { token: "public-registry-pull-token" });
  const dependencies = { playwright: "1.65.0", "playwright-core": "1.65.0" };
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
  const docker = path.join(dir, "fake-docker");
  await writeFile(
    docker,
    `#!/usr/bin/env node
if (process.env.TEST_OS_FAILURE) process.exit(1);
console.log(process.env.TEST_OS_VERSIONS);
`,
    { mode: 0o755 },
  );
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (options.failRegistry && url.pathname.startsWith("/v2/")) {
      res.writeHead(503).end();
      return;
    }
    const body = routes.get(url.pathname);
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
          [
            script,
            "--image-dir",
            dir,
            "--now",
            "2026-10-26T00:00:00Z",
            ...args,
          ],
          {
            env: {
              ...process.env,
              NPM_CONFIG_REGISTRY: url,
              PLAYWRIGHT_MCR_REGISTRY: url,
              PLAYWRIGHT_NODE_REGISTRY: url,
              PLAYWRIGHT_NODE_AUTH: url,
              PLAYWRIGHT_DOCKER_BIN: docker,
              TEST_OS_FAILURE: options.osFailure ? "true" : "",
              TEST_OS_VERSIONS: JSON.stringify(
                options.osVersions ?? {
                  "perl-base": "5.36.0-7+deb12u4",
                  libexpat1: "2.5.0-1+deb12u5",
                  libssl3: "3.0.22-1~deb12u2",
                },
              ),
            },
          },
        )),
      };
    } catch (error) {
      return { status: error.code, stdout: error.stdout, stderr: error.stderr };
    }
  }
  return { dir, initial, dockerfile, run, node, mcp };
}

test("selects a mature MCP release and pins both image indexes; check mode round-trips", async (t) => {
  const fixture = await setup(t);
  const result = await fixture.run();
  assert.equal(result.status, 0, result.stderr);
  const next = JSON.parse(
    await readFile(path.join(fixture.dir, "versions.json"), "utf8"),
  );
  assert.equal(next.mcpVersion, "0.0.84"); // latest 0.0.85 is inside the cooldown
  assert.equal(next.nodeVersion, "24.22.2");
  assert.equal(next.sourceNodeVersion, "24.21.0"); // final runtime uses the patched replacement
  assert.equal(
    next.mcpImage,
    `mcr.microsoft.com/playwright/mcp@${jsonDigest(fixture.mcp)}`,
  );
  assert.equal(
    next.nodeImage,
    `node:24.22.2-bookworm-slim@${jsonDigest(fixture.node)}`,
  );
  assert.equal((await fixture.run("--check")).status, 0);
  const before = await readFile(
    path.join(fixture.dir, "versions.json"),
    "utf8",
  );
  assert.equal((await fixture.run()).status, 0);
  assert.equal(
    await readFile(path.join(fixture.dir, "versions.json"), "utf8"),
    before,
  );
});

for (const [name, options, message] of [
  ["vulnerable Node", { node: "24.21.0" }, /not an approved patched runtime/],
  ["missing ARM image", { missingArm: true }, /no linux\/arm64/],
  [
    "different ARM Node version",
    { nodeArmVersion: "24.21.0" },
    /different Node versions/,
  ],
  ["tampered platform bytes", { tamper: true }, /digest mismatch/],
  ["registry failure", { failRegistry: true }, /HTTP 503/],
  [
    "unstable latest channel",
    { latest: "0.0.86-beta.1" },
    /not a stable version/,
  ],
]) {
  test(`rejects ${name} without changing either input`, async (t) => {
    const fixture = await setup(t, options);
    const result = await fixture.run();
    assert.equal(result.status, 1);
    assert.match(result.stderr, message);
    assert.equal(
      await readFile(path.join(fixture.dir, "versions.json"), "utf8"),
      fixture.initial,
    );
    assert.equal(
      await readFile(path.join(fixture.dir, "Dockerfile"), "utf8"),
      fixture.dockerfile,
    );
  });
}

test("refuses a Node downgrade even when both versions include the CVE fix", async (t) => {
  const fixture = await setup(t, { node: "24.22.1" });
  const metadata = JSON.parse(fixture.initial);
  metadata.nodeVersion = "24.22.2";
  metadata.nodeImage = metadata.nodeImage.replace("24.22.1", "24.22.2");
  await writeFile(
    path.join(fixture.dir, "versions.json"),
    JSON.stringify(metadata),
  );
  const result = await fixture.run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Refusing Node downgrade/);
});

test("check mode rejects Dockerfile drift and missing version arguments", async (t) => {
  const fixture = await setup(t);
  await writeFile(
    path.join(fixture.dir, "Dockerfile"),
    fixture.dockerfile.replace(
      "ENV NODE_VERSION=24.22.1",
      "ENV NODE_VERSION=24.21.0",
    ),
  );
  assert.match((await fixture.run("--check")).stderr, /does not match/);
  await writeFile(
    path.join(fixture.dir, "Dockerfile"),
    fixture.dockerfile.replace(/^ARG MCP_IMAGE=.*\n/m, ""),
  );
  assert.match(
    (await fixture.run("--check")).stderr,
    /Expected exactly one ARG MCP_IMAGE/,
  );
});

for (const [name, options, message] of [
  [
    "vulnerable Debian candidate",
    {
      osVersions: {
        "perl-base": "5.36.0-7+deb12u3",
        libexpat1: "2.5.0-1+deb12u5",
        libssl3: "3.0.22-1~deb12u2",
      },
    },
    /below the fixed Debian version/,
  ],
  [
    "missing Debian candidate",
    { osVersions: { "perl-base": "5.36.0-7+deb12u4" } },
    /Missing or unexpected Debian package pins/,
  ],
  ["failed signed APT query", { osFailure: true }, /Command failed/],
]) {
  test(`rejects ${name} without changing image inputs`, async (t) => {
    const fixture = await setup(t, options);
    const result = await fixture.run();
    assert.equal(result.status, 1);
    assert.match(result.stderr, message);
    assert.equal(
      await readFile(path.join(fixture.dir, "versions.json"), "utf8"),
      fixture.initial,
    );
    assert.equal(
      await readFile(path.join(fixture.dir, "Dockerfile"), "utf8"),
      fixture.dockerfile,
    );
  });
}

test("updates and round-trips Debian patch pins without an MCP release", async (t) => {
  const fixture = await setup(t, {
    latest: "0.0.83",
    osVersions: {
      "perl-base": "5.36.0-7+deb12u5",
      libexpat1: "2.5.0-1+deb12u6",
      libssl3: "3.0.22-1~deb12u3",
    },
  });
  assert.equal((await fixture.run()).status, 0);
  assert.equal(
    JSON.parse(await readFile(path.join(fixture.dir, "versions.json"), "utf8"))
      .mcpVersion,
    "0.0.83",
  );
  assert.match(
    await readFile(path.join(fixture.dir, "Dockerfile"), "utf8"),
    /ARG PERL_BASE_VERSION=5\.36\.0-7\+deb12u5/,
  );
  assert.equal((await fixture.run("--check")).status, 0);
});

test("refuses Debian patch downgrades above the security floor", async (t) => {
  const fixture = await setup(t);
  const metadata = JSON.parse(fixture.initial);
  metadata.osPackages["perl-base"] = "5.36.0-7+deb12u5";
  await writeFile(
    path.join(fixture.dir, "versions.json"),
    JSON.stringify(metadata),
  );
  const result = await fixture.run();
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /Refusing Debian package downgrade for perl-base/,
  );
});
