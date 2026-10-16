import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, test } from "vitest";
import {
  bindLaunchScope,
  closeBoundScope,
  DevelopmentExecutorError,
  executeOperation,
  parseLaunchArgs,
  planOperation,
  rejectToolInput,
  verifyIsolation,
} from "./development-executor";

const roots: string[] = [];
const configuredBwrap = process.env.ARCHESTRA_OPENAPPA_DEV_BWRAP;
const sandboxBwrap =
  configuredBwrap ??
  (existsSync("/usr/bin/bwrap") ? "/usr/bin/bwrap" : undefined);
const sandboxSelected =
  configuredBwrap !== undefined || sandboxBwrap !== undefined;

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function futureExpiry(): string {
  return new Date(Date.now() + 60 * 60 * 1000).toISOString();
}

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "openappa-dev-"));
  roots.push(dir);
  return dir;
}

function launchArgv(
  workspace: string,
  allow = "git_status,git_diff_summary,git_log",
): string[] {
  return [
    "--workspace",
    workspace,
    "--task-id",
    "task-1",
    "--expires",
    futureExpiry(),
    "--allow",
    allow,
    "--bwrap",
    sandboxBwrap ?? "/usr/bin/bwrap",
  ];
}

function initRepo(dir: string): void {
  const git = (args: string[]) => {
    const result = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    if (result.status !== 0)
      throw new Error(result.stderr || "git fixture failed");
  };
  git(["init", "-q"]);
  git(["config", "user.email", "dev@example.com"]);
  git(["config", "user.name", "dev"]);
  writeFileSync(path.join(dir, "file.txt"), "hello\n");
  git(["add", "file.txt"]);
  git(["commit", "-q", "-m", "init"]);
}

describe("launch parser", () => {
  test("refuses empty, unknown, and extra arguments without a sandbox", () => {
    expect(() => parseLaunchArgs([])).toThrow(/missing --workspace/);
    expect(() => parseLaunchArgs(["--not-a-scope", "x"])).toThrow(
      /refusing launch flag/,
    );
    expect(() => parseLaunchArgs(["positional"])).toThrow(
      /extra arguments are refused/,
    );
  });

  test("refuses an expired scope, a root workspace, and a test operation", () => {
    expect(() =>
      parseLaunchArgs([
        "--workspace",
        "/tmp/not-opened",
        "--task-id",
        "task-1",
        "--expires",
        "2020-01-01T00:00:00Z",
        "--allow",
        "git_status",
        "--bwrap",
        "/usr/bin/bwrap",
      ]),
    ).toThrow(/expired/);
    expect(() =>
      parseLaunchArgs([
        "--workspace",
        "/",
        "--task-id",
        "task-1",
        "--expires",
        futureExpiry(),
        "--allow",
        "git_status",
        "--bwrap",
        "/usr/bin/bwrap",
      ]),
    ).toThrow(/filesystem root/);
    expect(() =>
      parseLaunchArgs([
        "--workspace",
        "/tmp/not-opened",
        "--task-id",
        "task-1",
        "--expires",
        futureExpiry(),
        "--allow",
        "test",
        "--bwrap",
        "/usr/bin/bwrap",
      ]),
    ).toThrow(/refusing operation test/);
  });

  test("rejects extra tool input before any sandbox call", () => {
    expect(() =>
      rejectToolInput({ path: "/etc", argv: ["sh"], workspace: "/" }),
    ).toThrow(DevelopmentExecutorError);
  });

  test("refuses a linked worktree and a symlinked git config", () => {
    const dir = tempDir();
    initRepo(dir);
    rmSync(path.join(dir, ".git"), { recursive: true, force: true });
    writeFileSync(path.join(dir, ".git"), "gitdir: /tmp/outside\n");
    expect(() => bindLaunchScope(parseLaunchArgs(launchArgv(dir)))).toThrow(
      /linked worktrees are refused/,
    );

    const linked = tempDir();
    initRepo(linked);
    const outside = path.join(tempDir(), "outside.cfg");
    writeFileSync(outside, "[core]\n");
    rmSync(path.join(linked, ".git", "config"));
    symlinkSync(outside, path.join(linked, ".git", "config"));
    expect(() => bindLaunchScope(parseLaunchArgs(launchArgv(linked)))).toThrow(
      /symlinks are refused/,
    );
  });
});

describe.skipIf(!sandboxSelected)("bwrap isolation", () => {
  test("uses a real bwrap binary", () => {
    if (!sandboxBwrap || !existsSync(sandboxBwrap)) {
      throw new Error(
        `ARCHESTRA_OPENAPPA_DEV_BWRAP is invalid: ${configuredBwrap ?? sandboxBwrap}`,
      );
    }
  });
  test("blocks host files, network, filter.process, and outside config", async () => {
    const parent = tempDir();
    const dir = path.join(parent, "repo");
    mkdirSync(dir);
    initRepo(dir);
    const script = path.join(dir, ".git", "exec.sh");
    writeFileSync(
      script,
      "#!/usr/bin/python3\nimport sys\nsys.stderr.write('EXEC_RAN\\n')\nsys.exit(1)\n",
    );
    chmodSync(script, 0o755);
    const outside = path.join(parent, "outside.cfg");
    const nested = path.join(parent, "nested.cfg");
    writeFileSync(nested, "SECRETTOKEN123\n");
    writeFileSync(
      outside,
      `[filter "evil"]\n\tprocess = ${script}\n[include]\n\tpath = "${nested}"\n`,
    );
    rmSync(path.join(dir, ".git", "config"));
    linkSync(outside, path.join(dir, ".git", "config"));
    symlinkSync(nested, path.join(dir, ".git", "include-link"));
    writeFileSync(path.join(dir, ".gitattributes"), "* filter=evil\n");
    writeFileSync(path.join(dir, "file.txt"), "hello\nmore\n");

    const scope = bindLaunchScope(parseLaunchArgs(launchArgv(dir)));
    try {
      await verifyIsolation(scope);
      const diff = await executeOperation({
        scope,
        operation: "git_diff_summary",
        input: {},
      });
      expect(diff).toContain("file.txt");
      expect(diff).not.toContain("EXEC_RAN");
      expect(diff).not.toContain("SECRETTOKEN123");
      writeFileSync(path.join(parent, "mutated.cfg"), "MUTATED_OVERLAY\n");
      const again = await executeOperation({
        scope,
        operation: "git_diff_summary",
        input: {},
      });
      expect(again).not.toContain("MUTATED_OVERLAY");
      expect(again).toContain("file.txt");
      await expect(
        executeOperation({
          scope,
          operation: "git_status",
          input: { path: "/etc" },
        }),
      ).rejects.toMatchObject({ code: "unknown_tool_input" });
      await expect(
        executeOperation({
          scope,
          operation: "git_status",
          input: {},
          now: scope.launch.expiresAtMs + 1,
        }),
      ).rejects.toMatchObject({ code: "expired_scope" });
    } finally {
      await closeBoundScope(scope);
    }
  }, 30_000);

  test("keeps the pinned directory after the path is replaced", async () => {
    const parent = tempDir();
    const original = path.join(parent, "A");
    mkdirSync(original);
    initRepo(original);
    const scope = bindLaunchScope(
      parseLaunchArgs(launchArgv(original, "git_status")),
    );
    try {
      const replacement = path.join(parent, "B");
      mkdirSync(replacement);
      initRepo(replacement);
      writeFileSync(path.join(replacement, "SECRET_NAME.txt"), "secret\n");
      renameSync(original, path.join(parent, "A-old"));
      renameSync(replacement, original);
      const status = await executeOperation({
        scope,
        operation: "git_status",
        input: {},
      });

      expect(status).not.toContain("SECRET_NAME");
      const plan = planOperation(scope, "git_status");
      expect(plan.args.join("\n")).toContain("--unshare-net");
      expect(plan.args.join("\n")).not.toContain("--nproc");
      expect(plan.args.join("\n")).not.toContain(original);
    } finally {
      await closeBoundScope(scope);
    }
  }, 30_000);

  test("bounds parallel processes and releases capacity after they finish", async () => {
    const dir = tempDir();
    initRepo(dir);
    const scope = bindLaunchScope(parseLaunchArgs(launchArgv(dir)));
    try {
      const results = await Promise.allSettled(
        Array.from({ length: 8 }, () =>
          executeOperation({ scope, operation: "git_status", input: {} }),
        ),
      );
      expect(
        results.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(4);
      const refused = results.filter((result) => result.status === "rejected");
      expect(refused).toHaveLength(4);
      for (const result of refused) {
        expect(result.reason).toMatchObject({ code: "scope_busy" });
      }
      await expect(
        executeOperation({ scope, operation: "git_status", input: {} }),
      ).resolves.toContain("task=");
    } finally {
      await closeBoundScope(scope);
    }
  });

  test("kills a timed-out sandbox and reaps it before returning", async () => {
    const dir = tempDir();
    initRepo(dir);
    const scope = bindLaunchScope(
      parseLaunchArgs(launchArgv(dir, "git_status")),
    );
    try {
      await expect(
        executeOperation({
          scope,
          operation: "git_status",
          input: {},
          timeoutMs: 1,
        }),
      ).rejects.toMatchObject({ code: "timeout" });
      expect(scope.inflight.size).toBe(0);
    } finally {
      await closeBoundScope(scope);
    }
  }, 30_000);

  test("stdio server rejects extra arguments and unlisted operations", async () => {
    const dir = tempDir();
    initRepo(dir);
    const script = fileURLToPath(
      new URL("../standalone-scripts/openappa-dev-tools.ts", import.meta.url),
    );
    const loader = fileURLToPath(
      new URL("../../node_modules/tsx/dist/esm/index.mjs", import.meta.url),
    );
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", loader, script, ...launchArgv(dir, "git_status")],
      stderr: "pipe",
    });
    const client = new Client({ name: "openappa-dev-test", version: "0" });
    try {
      await client.connect(transport);
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual(["git_status"]);
      writeFileSync(path.join(dir, "file.txt"), "hello\nchanged\n");
      const ok = await client.callTool({ name: "git_status", arguments: {} });
      expect(JSON.stringify(ok)).toContain("file.txt");
      const rejected = await client.callTool({
        name: "git_status",
        arguments: { path: "/etc", command: "sh" },
      });
      expect(rejected).toMatchObject({ isError: true });
      const denied = await client.callTool({ name: "git_log", arguments: {} });
      expect(denied).toMatchObject({ isError: true });
    } finally {
      await client.close();
    }
  }, 30_000);
});
