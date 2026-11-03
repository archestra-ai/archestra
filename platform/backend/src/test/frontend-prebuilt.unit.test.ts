import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
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
import { afterEach, describe, expect, test } from "vitest";

// scripts/frontend-prebuilt.mjs as dev-lite.sh runs it, in a small git
// checkout of its own, against a registry stand-in that serves single-layer
// artifacts and records what was asked for.
const SCRIPT = path.resolve(
  __dirname,
  "../../../scripts/frontend-prebuilt.mjs",
);
const supported = process.platform === "linux" && process.arch === "x64";

describe.skipIf(!supported)("frontend prebuilt", () => {
  let dir: string | undefined;
  let server: Server | undefined;
  afterEach(async () => {
    await new Promise<void>((resolve) =>
      server ? server.close(() => resolve()) : resolve(),
    );
    server = undefined;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  test("a clean checkout installs the published build, and a repeat downloads nothing", async () => {
    const repo = checkout();
    const key = await keyOf(repo);
    const registry = await serve({ [key]: artifact(repo, key) });
    const first = await run(repo, ["install"], registry.env);
    expect(first.status).toBe(0);
    const standalone = path.join(repo, "platform/frontend/.next/standalone");
    expect(
      readFileSync(path.join(standalone, "frontend/server.js"), "utf8"),
    ).toBe("// published\n");
    // The public files come from the checkout, not the artifact.
    expect(existsSync(path.join(standalone, "frontend/public/logo.svg"))).toBe(
      true,
    );
    const asked = registry.requests.length;
    const again = await run(repo, ["install"], registry.env);
    expect(again.status).toBe(0);
    expect(registry.requests.length).toBe(asked);
  });

  test("a frontend dotenv file git does not track means a build here", async () => {
    const repo = checkout();
    const registry = await serve({});
    writeFileSync(
      path.join(repo, "platform/frontend/.env.local"),
      "ARCHESTRA_MCP_CATALOG_API_BASE_URL=http://127.0.0.1:9999\n",
    );
    const result = await run(repo, ["install"], registry.env);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "platform/frontend/.env.local is not in git",
    );
    expect(registry.requests).toEqual([]);
  });

  test("an edited source means a build here, with the cache of the same configuration", async () => {
    const repo = checkout();
    const key = await keyOf(repo);
    const registry = await serve({
      [`cache-${key}`]: artifact(repo, key, "cache"),
    });
    writeFileSync(
      path.join(repo, "platform/frontend/page.ts"),
      "export const x = 2;\n",
    );
    const install = await run(repo, ["install"], registry.env);
    expect(install.status).toBe(1);
    expect(install.stderr).toContain("local changes");
    const cache = await run(repo, ["install-cache"], registry.env);
    expect(cache.status).toBe(0);
    expect(
      existsSync(
        path.join(repo, "platform/frontend/.next/cache/turbopack/seed"),
      ),
    ).toBe(true);
  });

  test("the key follows what the build reads from its environment, and nothing else", async () => {
    const repo = checkout();
    const plain = await keyOf(repo);
    expect(await keyOf(repo, { UNRELATED_SETTING: "1" })).toBe(plain);
    expect(await keyOf(repo, { NEXT_PUBLIC_ANYTHING: "1" })).not.toBe(plain);
    // next.config.ts reads ARCHESTRA_FIXTURE_URL.
    expect(
      await keyOf(repo, { ARCHESTRA_FIXTURE_URL: "http://other" }),
    ).not.toBe(plain);
    expect(await keyOf(repo, { CI: "true" })).toBe(plain);
  });

  // ===== Helpers =====

  /** A committed checkout with the paths the key covers. */
  function checkout(): string {
    const root = mkdtempSync(path.join(tmpdir(), "frontend-prebuilt-"));
    dir = root;
    const write = (relative: string, text: string) => {
      mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
      writeFileSync(path.join(root, relative), text);
    };
    mkdirSync(path.join(root, "platform/scripts"), { recursive: true });
    copyFileSync(
      SCRIPT,
      path.join(root, "platform/scripts/frontend-prebuilt.mjs"),
    );
    write(
      "platform/scripts/dev-lite.sh",
      [
        "frontend_build_env() {",
        "  :",
        "}",
        "frontend_build_node() {",
        "  :",
        "}",
        "build_frontend() {",
        "  :",
        "}",
        "prepare_frontend_standalone() {",
        "  :",
        "}",
        "",
      ].join("\n"),
    );
    write("platform/frontend/package.json", '{"name": "frontend"}\n');
    write(
      "platform/frontend/next.config.ts",
      "export default { url: process.env.ARCHESTRA_FIXTURE_URL };\n",
    );
    write("platform/frontend/page.ts", "export const x = 1;\n");
    write("platform/frontend/public/logo.svg", "<svg/>\n");
    write("platform/shared/consts.ts", "export const y = 1;\n");
    write(
      "platform/package.json",
      '{"name": "platform", "version": "1.0.0"}\n',
    );
    write("platform/pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
    write(".gitignore", ".env.local\n.next/\n");
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", root, ...args], { stdio: "ignore" });
    git("init", "-q");
    git("add", "-A");
    git(
      "-c",
      "user.name=test",
      "-c",
      "user.email=test@localhost",
      "commit",
      "-qm",
      "fixture",
    );
    return root;
  }

  async function keyOf(
    repo: string,
    env: NodeJS.ProcessEnv = {},
  ): Promise<string> {
    const result = await run(repo, ["--key"], env);
    expect(result.status).toBe(0);
    return result.stdout.trim();
  }

  /** A gzipped single layer: manifest.json and the kind's directory. */
  function artifact(
    repo: string,
    key: string,
    kind: "build" | "cache" = "build",
  ): Buffer {
    const layer = path.join(repo, `layer-${kind}`);
    if (kind === "build") {
      mkdirSync(path.join(layer, "standalone/frontend"), { recursive: true });
      writeFileSync(
        path.join(layer, "standalone/frontend/server.js"),
        "// published\n",
      );
    } else {
      mkdirSync(path.join(layer, "cache/turbopack"), { recursive: true });
      writeFileSync(path.join(layer, "cache/turbopack/seed"), "seed\n");
    }
    writeFileSync(
      path.join(layer, "manifest.json"),
      JSON.stringify({ key, kind, commit: "fixture" }),
    );
    const blob = execFileSync("tar", ["-czf", "-", "-C", layer, "."]);
    rmSync(layer, { recursive: true, force: true });
    return blob;
  }

  /** The registry stand-in, serving `tag -> layer`; 404 for anything else. */
  async function serve(
    layers: Record<string, Buffer>,
  ): Promise<{ env: NodeJS.ProcessEnv; requests: string[] }> {
    const requests: string[] = [];
    const blobs = new Map<string, Buffer>();
    for (const blob of Object.values(layers)) {
      blobs.set(
        `sha256:${createHash("sha256").update(blob).digest("hex")}`,
        blob,
      );
    }
    server = createServer((request, response) => {
      const url = request.url ?? "";
      requests.push(url);
      const manifest = /\/manifests\/([^/]+)$/.exec(url);
      if (manifest && layers[manifest[1]]) {
        const blob = layers[manifest[1]];
        const digest = `sha256:${createHash("sha256").update(blob).digest("hex")}`;
        response.writeHead(200, {
          "content-type": "application/vnd.oci.image.manifest.v1+json",
        });
        response.end(
          JSON.stringify({
            schemaVersion: 2,
            layers: [{ digest, size: blob.length }],
          }),
        );
        return;
      }
      const blob = /\/blobs\/(sha256:[0-9a-f]+)$/.exec(url);
      if (blob && blobs.has(blob[1])) {
        response.writeHead(200);
        response.end(blobs.get(blob[1]));
        return;
      }
      response.writeHead(404);
      response.end();
    });
    await new Promise<void>((resolve) =>
      server?.listen(0, "127.0.0.1", () => resolve()),
    );
    const { port } = server.address() as AddressInfo;
    return {
      env: {
        ARCHESTRA_DEV_FRONTEND_PREBUILT_REPOSITORY: `http://127.0.0.1:${port}/frontend-dev-cache`,
      },
      requests,
    };
  }

  function run(
    repo: string,
    args: string[],
    env: NodeJS.ProcessEnv,
  ): Promise<{ status: number | null; stdout: string; stderr: string }> {
    const childEnv: NodeJS.ProcessEnv = { ...process.env, ...env };
    delete childEnv.ARCHESTRA_DEV_FRONTEND_PREBUILT;
    for (const name of Object.keys(childEnv)) {
      if (name.startsWith("NEXT_PUBLIC_") && !(name in env))
        delete childEnv[name];
    }
    return new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [path.join(repo, "platform/scripts/frontend-prebuilt.mjs"), ...args],
        { env: childEnv, stdio: ["ignore", "pipe", "pipe"] },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("error", reject);
      child.on("close", (status) => resolve({ status, stdout, stderr }));
    });
  }
});
