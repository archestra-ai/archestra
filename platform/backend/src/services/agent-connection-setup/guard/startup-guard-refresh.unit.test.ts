import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { STARTUP_GUARD_FORMAT_VERSION } from "@archestra/shared/consts";
import { afterEach, describe, expect, test } from "vitest";
import { STARTUP_GUARD_REFRESH } from "../payloads/startup-guard-refresh";
import {
  CLAUDE_CODE_GUARD_CLIENT,
  CODEX_GUARD_CLIENT,
  COPILOT_GUARD_CLIENT,
  KILO_GUARD_CLIENT,
  OPENCODE_GUARD_CLIENT,
} from "./clients";
import {
  renderStartupGuardScript,
  type StartupGuardClient,
  type StartupGuardContext,
  startupGuardRefreshInstall,
} from "./startup-guard";
import { renderStartupGuardPowerShell } from "./startup-guard.windows";
import {
  StartupGuardArtifactRequestSchema,
  startupGuardArtifact,
} from "./startup-guard-artifact";

const execute = promisify(execFile);
const hash = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture(
  options: {
    client?: StartupGuardClient;
    platform?: "bash" | "windows";
    proxy?: boolean;
    appName?: string;
    cloneUrl?: string;
  } = {},
) {
  const root = await mkdtemp(path.join(tmpdir(), "guard-refresh-"));
  roots.push(root);
  const client = options.client ?? CLAUDE_CODE_GUARD_CLIENT;
  const platform = options.platform ?? "bash";
  let requests = 0;
  let mode = "ok";
  let requestBody = "";
  let onRequest = async () => {};
  const server = createServer(async (request, response) => {
    if (request.url?.startsWith("/v1/health")) {
      response.end(
        JSON.stringify({
          mcp: "ok",
          guardVersion: STARTUP_GUARD_FORMAT_VERSION,
        }),
      );
      return;
    }
    requests++;
    const parts: Buffer[] = [];
    for await (const part of request) parts.push(Buffer.from(part));
    requestBody = Buffer.concat(parts).toString("utf8");
    await onRequest();
    if (mode === "failure") {
      response.writeHead(503);
      response.end();
      return;
    }
    if (mode === "redirect") {
      response.writeHead(302, { Location: "/other" });
      response.end();
      return;
    }
    if (mode === "timeout") return;
    if (mode === "network") {
      request.socket.destroy();
      return;
    }
    if (mode === "unauthorized") {
      response.writeHead(401);
      response.end();
      return;
    }
    if (mode === "oversized") {
      response.end(Buffer.alloc(1024 * 1024 + 1, 32));
      return;
    }
    if (mode === "malformed") {
      response.end("{");
      return;
    }
    const artifact = startupGuardArtifact(
      StartupGuardArtifactRequestSchema.parse(JSON.parse(requestBody)),
    );
    if (mode === "hash") artifact.sha256 = "0".repeat(64);
    if (mode === "version") artifact.version--;
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(artifact));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("missing fixture port");
  const origin = `http://127.0.0.1:${address.port}`;
  const context: StartupGuardContext = {
    appName: options.appName ?? "Archestra",
    healthUrl: `${origin}/v1/health?mcp=test`,
    mcp: { serverName: "test", url: `${origin}/v1/mcp/test`, ref: "test" },
    proxy: options.proxy
      ? {
          provider: "openai",
          providerLabel: "OpenAI",
          url: `${origin}/v1/openai/test`,
          ref: "test",
          proxyName: "fixture",
          authMode: "provider-key",
          passthroughVirtualKey: "local-key-with-quoted-\"value'",
        }
      : null,
    skills: {
      marketplaceName: "fixture-skills",
      cloneUrl:
        options.cloneUrl ??
        "https://fixture:private-credential's@example.com/skills/m/local.git",
      hasSkills: true,
      pluginNames: ["sample"],
    },
  };
  const guard = path.join(
    root,
    platform === "windows" ? client.psScriptRelpath : client.scriptRelpath,
  );
  await mkdir(path.dirname(guard), { recursive: true, mode: 0o700 });
  const current =
    platform === "windows"
      ? renderStartupGuardPowerShell(context, client)
      : renderStartupGuardScript(context, client);
  const old =
    (platform === "windows" ? "\ufeff" : "") +
    current.replace(
      platform === "windows"
        ? `$GuardFormatVersion = ${STARTUP_GUARD_FORMAT_VERSION}`
        : `GUARD_FORMAT_VERSION=${STARTUP_GUARD_FORMAT_VERSION}`,
      platform === "windows"
        ? `$GuardFormatVersion = ${STARTUP_GUARD_FORMAT_VERSION - 1}`
        : `GUARD_FORMAT_VERSION=${STARTUP_GUARD_FORMAT_VERSION - 1}`,
    );
  await writeFile(guard, old, { mode: 0o700 });
  const updater = `${guard}.update.cjs`;
  await writeFile(updater, STARTUP_GUARD_REFRESH, { mode: 0o600 });
  const state = {
    clientId: client.clientId,
    platform,
    url: `${origin}/api/connection-setups/startup-guard`,
    context,
    updaterHash: hash(STARTUP_GUARD_REFRESH),
    hashes: [hash(old)],
  };
  await writeFile(`${guard}.update.json`, JSON.stringify(state), {
    mode: 0o600,
  });
  return {
    root,
    guard,
    old,
    current: (platform === "windows" ? "\ufeff" : "") + current,
    context,
    requests: () => requests,
    requestBody: () => requestBody,
    mode: (value: string) => {
      mode = value;
    },
    onRequest: (fn: () => Promise<void>) => {
      onRequest = fn;
    },
    run: (version = STARTUP_GUARD_FORMAT_VERSION) =>
      execute(process.execPath, [updater, guard, String(version)]),
  };
}

describe("generated startup check refresh", () => {
  test.each([
    CLAUDE_CODE_GUARD_CLIENT,
    CODEX_GUARD_CLIENT,
    COPILOT_GUARD_CLIENT,
    OPENCODE_GUARD_CLIENT,
    KILO_GUARD_CLIENT,
  ])("updates $clientId without sending credentials or changing user config", async (client) => {
    const f = await fixture({ client });
    const config = path.join(f.root, "settings.json");
    const custom =
      '{"permissions":{"deny":["Bash(*)"]},"env":{"CUSTOM":"kept"}}\n';
    await writeFile(config, custom);
    const { stderr } = await f.run();
    expect(stderr).toContain("Updated Archestra launch check automatically");
    expect(await readFile(f.guard, "utf8")).toBe(f.current);
    expect(await readFile(`${f.guard}.previous`, "utf8")).toBe(f.old);
    expect(await readFile(config, "utf8")).toBe(custom);
    expect(f.requestBody()).not.toContain("private-credential");
    await f.run();
    await f.run(STARTUP_GUARD_FORMAT_VERSION - 1);
    expect(f.requests()).toBe(1);
    expect(await readFile(f.guard, "utf8")).toBe(f.current);
  });

  test.each([
    "bash",
    "windows",
  ] as const)("keeps OpenCode private proxy keys local with %s quoting", async (platform) => {
    const f = await fixture({
      client: OPENCODE_GUARD_CLIENT,
      platform,
      proxy: true,
    });
    expect((await f.run()).stderr).toContain(
      "Updated Archestra launch check automatically",
    );
    expect(f.requestBody()).not.toContain("local-key-with");
    expect(await readFile(f.guard, "utf8")).toBe(f.current);
  });

  test("does not interpret private values as substitution slots", async () => {
    const f = await fixture({
      client: OPENCODE_GUARD_CLIENT,
      proxy: true,
      cloneUrl:
        "https://fixture:ARCH_GUARD_PRIVATE_KEY@example.com/skills/m/local.git",
    });
    expect((await f.run()).stderr).toContain(
      "Updated Archestra launch check automatically",
    );
    expect(await readFile(f.guard, "utf8")).toBe(f.current);
  });

  test("preserves config with reserved markers instead of exposing a private key in a label", async () => {
    const f = await fixture({
      client: OPENCODE_GUARD_CLIENT,
      proxy: true,
      appName: "ARCH_GUARD_PRIVATE_KEY",
    });
    const { stderr } = await f.run();
    expect(stderr).toContain("Ambiguous launch check substitutions");
    expect(stderr).not.toContain("local-key-with");
    expect(f.requests()).toBe(0);
    expect(await readFile(f.guard, "utf8")).toBe(f.old);
  });

  test("the real noninteractive Bash guard automatically refreshes on startup", async () => {
    const f = await fixture();
    const { stderr } = await execute("bash", [f.guard], {
      env: { ...process.env, HOME: f.root },
    });
    expect(stderr).toContain("Updated Archestra launch check automatically");
    expect(stderr).not.toContain("re-run");
    expect(await readFile(f.guard, "utf8")).toBe(f.current);
  });

  test("preserves shell quoting in private clone URLs and PowerShell BOM", async () => {
    const f = await fixture({ platform: "windows" });
    expect((await f.run()).stderr).toContain(
      "Updated Archestra launch check automatically",
    );
    expect(await readFile(f.guard, "utf8")).toBe(f.current);
  });

  test.each([
    "failure",
    "redirect",
    "malformed",
    "hash",
    "version",
    "timeout",
    "network",
    "unauthorized",
    "oversized",
  ])("keeps cached config on %s and retries next startup", async (mode) => {
    const f = await fixture();
    f.mode(mode);
    expect((await f.run()).stderr).toContain("kept the installed config");
    expect(await readFile(f.guard, "utf8")).toBe(f.old);
    f.mode("ok");
    await f.run();
    expect(await readFile(f.guard, "utf8")).toBe(f.current);
  });

  test("preserves edits and symlinks without downloading an update", async () => {
    const f = await fixture();
    const customized = `${f.old}\n# user override\n`;
    await writeFile(f.guard, customized);
    expect((await f.run()).stderr).toContain(
      "Customized launch check was preserved",
    );
    expect(f.requests()).toBe(0);
    const target = path.join(f.root, "custom.sh");
    await writeFile(target, customized);
    await rm(f.guard);
    await symlink(target, f.guard);
    await f.run();
    expect(await readFile(target, "utf8")).toBe(customized);
    expect(f.requests()).toBe(0);
  });

  test("an edit made while downloading wins over the generated update", async () => {
    const f = await fixture();
    const customized = `${f.old}\n# concurrent edit\n`;
    f.onRequest(async () => {
      await writeFile(f.guard, customized);
    });
    expect((await f.run()).stderr).toContain("changed during update");
    expect(await readFile(f.guard, "utf8")).toBe(customized);
  });

  test("concurrent startups publish one complete generation", async () => {
    const f = await fixture();
    await Promise.all([f.run(), f.run(), f.run()]);
    expect(f.requests()).toBe(1);
    expect(await readFile(f.guard, "utf8")).toBe(f.current);
  });

  test("rejects a group-writable installed updater", async () => {
    const f = await fixture();
    await chmod(`${f.guard}.update.cjs`, 0o666);
    await f.run();
    expect(f.requests()).toBe(0);
    expect(await readFile(f.guard, "utf8")).toBe(f.old);
  });

  test("approved Bash installation records the exact generated source", async () => {
    const f = await fixture();
    const section = startupGuardRefreshInstall({
      ctx: f.context,
      client: CLAUDE_CODE_GUARD_CLIENT,
      platform: "bash",
    });
    expect(section).not.toContain("instructions-source");
    // Exercise the actual installer section at a disposable home-relative path.
    const relative = path.relative(f.root, f.guard);
    await execute(
      "bash",
      [
        "-c",
        section.replaceAll(CLAUDE_CODE_GUARD_CLIENT.scriptRelpath, relative),
      ],
      { env: { ...process.env, HOME: f.root } },
    );
    const state = JSON.parse(await readFile(`${f.guard}.update.json`, "utf8"));
    expect(state.hashes).toEqual([hash(f.current)]);
    expect(state.updaterHash).toBe(
      hash(await readFile(`${f.guard}.update.cjs`)),
    );
  });
});
