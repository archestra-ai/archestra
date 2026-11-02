import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  heavyLaneActive,
  heavyLaneCeilings,
  pausesServers,
  resourceEnvelope,
} from "../../../vitest.resources";

// scripts/heavy-lane.ts, as a module and as the command line the package
// scripts and dev-lite.sh call, against fake commands that log what they do.
const PLATFORM_DIR = path.resolve(__dirname, "../../..");
const LANE = path.join(PLATFORM_DIR, "scripts/heavy-lane.ts");
const GIB = 1024 ** 3;
// As dev-lite.sh runs it: Node strips the types, quietly.
const NODE_FLAGS = ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON"];
const hasFlock =
  process.platform === "linux" &&
  spawnSync("flock", ["--version"], { stdio: "ignore" }).status === 0;

describe("heavy lane", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  test("is active only in a container below 16 GiB", () => {
    expect(heavyLaneActive(envelope(4))).toBe(true);
    expect(heavyLaneActive(envelope(12))).toBe(true);
    expect(heavyLaneActive(envelope(24))).toBe(false);
    expect(
      heavyLaneActive(
        resourceEnvelope({
          hostParallelism: 8,
          hostMemoryBytes: 8 * GIB,
          constrainedMemoryBytes: undefined,
        }),
      ),
    ).toBe(false);
  });

  test("in a 4 GiB pod, about 1.8 GiB fits beside the servers and 2.7 with them paused", () => {
    const { besideServersBytes, serversPausedBytes } = heavyLaneCeilings(
      envelope(4),
    );
    expect(besideServersBytes / GIB).toBeCloseTo(1.83, 2);
    expect(serversPausedBytes / GIB).toBeCloseTo(2.68, 2);
    expect(pausesServers(envelope(4), 2.8 * GIB)).toBe(true);
    expect(pausesServers(envelope(4), 1.3 * GIB)).toBe(false);
    expect(pausesServers(envelope(4), undefined)).toBe(false);
    expect(pausesServers(envelope(24), 5 * GIB)).toBe(false);
  });

  test.skipIf(!hasFlock)(
    "heavy commands started together run one at a time, and a waiter says for whom",
    async () => {
      const { log, env, root } = scratch();
      const release = path.join(root, "release");
      // The first holds the lane until both others have said they wait.
      const first = runCli(env, [
        "--label",
        "first",
        "--",
        "sh",
        "-c",
        `echo "start first" >> ${log}; while [ ! -e ${release} ]; do sleep 0.05; done; echo "end first" >> ${log}`,
      ]);
      await waitFor(() => readIfExists(log).includes("start first"));
      const waiters = ["second", "third"].map((name) =>
        runCli(env, ["--label", name, "--", "sh", "-c", logged(log, name)]),
      );
      await waitFor(() =>
        waiters.every((waiter) => waiter.stderr().includes("waits for")),
      );
      writeFileSync(release, "");
      const results = await Promise.all([first, ...waiters]);
      expect(results.map((result) => result.status)).toEqual([0, 0, 0]);
      const lines = readFileSync(log, "utf8").trim().split("\n");
      expect(lines).toHaveLength(6);
      for (let i = 0; i < lines.length; i += 2) {
        const name = lines[i].split(" ")[1];
        expect(lines[i + 1]).toBe(`end ${name}`);
      }
      for (const waiter of results.slice(1)) {
        expect(waiter.stderr).toMatch(
          /^heavy-lane: (second|third) waits for first \(pid \d+, running \d+ s\): one memory-heavy command runs at a time in this pod\.$/m,
        );
      }
      expect(results.map((result) => result.stderr).join("")).not.toContain(
        "Warning",
      );
    },
    30_000,
  );

  test.skipIf(!hasFlock)(
    "a command under the lane runs its own heavy commands without waiting for itself",
    async () => {
      const { log, env } = scratch();
      const nested = `node ${NODE_FLAGS.join(" ")} ${LANE} --label inner -- sh -c 'echo inner >> ${log}'`;
      const result = await runCli(env, [
        "--label",
        "outer",
        "--",
        "sh",
        "-c",
        nested,
      ]);
      expect(result.status).toBe(0);
      expect(readFileSync(log, "utf8").trim()).toBe("inner");
    },
    30_000,
  );

  test.skipIf(!hasFlock)(
    "a command too big to fit beside the servers has them paused, and resumed when it ends",
    async () => {
      const { log, env, devLite, paused } = scratch();
      const result = await runCli(env, [
        ...bigCommand(devLite),
        "sh",
        "-c",
        `echo command >> ${log}; exit 3`,
      ]);
      expect(result.status).toBe(3);
      expect(result.stderr).toContain(
        "heavy-lane: stopped the dev stack's backend and frontend while type-check (frontend) runs: it needs about 2.8 GiB, and beside them this pod has 1.8 GiB for it.",
      );
      expect(readFileSync(log, "utf8").trim().split("\n")).toEqual([
        "pause",
        "command",
        "resume",
      ]);
      expect(existsSync(paused)).toBe(false);
    },
  );

  test.skipIf(!hasFlock)(
    "a command that fits, or a stack someone else paused, leaves the servers alone",
    async () => {
      const { log, env, devLite, paused } = scratch();
      const small = await runCli(env, [
        "--label",
        "knip (shared)",
        "--peak-gib",
        "0.7",
        "--dev-lite",
        devLite,
        "--",
        "sh",
        "-c",
        `echo small >> ${log}`,
      ]);
      expect(small.status).toBe(0);
      writeFileSync(paused, "");
      const big = await runCli(env, [
        ...bigCommand(devLite),
        "sh",
        "-c",
        `echo big >> ${log}`,
      ]);
      expect(big.status).toBe(0);
      expect(readFileSync(log, "utf8").trim().split("\n")).toEqual([
        "small",
        "big",
      ]);
      expect(existsSync(paused)).toBe(true);
    },
  );

  test.skipIf(!hasFlock)(
    "a process a heavy command leaves running does not keep the lane",
    async () => {
      const { log, env } = scratch();
      // As a tmux server started by `resume` would: still alive after the command.
      const first = await runCli(env, [
        "--label",
        "first",
        "--",
        "sh",
        "-c",
        "sleep 5 > /dev/null 2>&1 &",
      ]);
      expect(first.status).toBe(0);
      const started = Date.now();
      const second = await runCli(env, [
        "--label",
        "second",
        "--",
        "sh",
        "-c",
        `echo second >> ${log}`,
      ]);
      expect(second.status).toBe(0);
      expect(second.stderr).not.toContain("waits for");
      expect(Date.now() - started).toBeLessThan(4_000);
    },
    30_000,
  );

  test.skipIf(!hasFlock)(
    "a waiter whose caller went away does not run its command later",
    async () => {
      const { log, env, root } = scratch();
      const release = path.join(root, "release");
      const first = runCli(env, [
        "--label",
        "first",
        "--",
        "sh",
        "-c",
        `echo first >> ${log}; while [ ! -e ${release} ]; do sleep 0.05; done`,
      ]);
      await waitFor(() => readIfExists(log).includes("first"));
      const second = runCli(env, [
        "--label",
        "second",
        "--",
        "sh",
        "-c",
        `echo second >> ${log}`,
      ]);
      await waitFor(() => second.stderr().includes("waits for"));
      // Only the Node process: its waiting shell is left to notice. The
      // shell still holds the stderr pipe, so `second` settles when it exits.
      second.kill("SIGTERM");
      writeFileSync(release, "");
      expect((await first).status).toBe(0);
      await second;
      expect(readFileSync(log, "utf8").trim()).toBe("first");
    },
    30_000,
  );

  test.skipIf(!hasFlock)(
    "a command already under the lane neither waits nor pauses the servers",
    async () => {
      const { log, env, devLite } = scratch();
      env.ARCHESTRA_HEAVY_LANE = "held";
      const result = await runCli(env, [
        ...bigCommand(devLite),
        "sh",
        "-c",
        `echo direct >> ${log}`,
      ]);
      expect(result.status).toBe(0);
      expect(readFileSync(log, "utf8").trim()).toBe("direct");
    },
  );

  test("refuses a command line without the -- before the command, or a peak it cannot read", async () => {
    const { env } = scratch();
    for (const args of [
      ["pnpm", "exec", "vitest", "--", "run"],
      ["--peak-gib", "2.8GiB", "--", "true"],
    ]) {
      const result = await runCli(env, args);
      expect(result.status).toBe(64);
      expect(result.stderr).toContain("usage:");
    }
  });

  // ===== Helpers =====

  function envelope(gib: number) {
    return resourceEnvelope({
      hostParallelism: 8,
      hostMemoryBytes: 32 * GIB,
      constrainedMemoryBytes: gib * GIB,
    });
  }

  /**
   * A scratch dir with its own lock (TMPDIR), a 4 GiB pod's sizing, and a fake
   * dev-lite.sh whose pause and resume log and keep the paused marker.
   */
  function scratch() {
    const root = mkdtempSync(path.join(tmpdir(), "heavy-lane-"));
    dir = root;
    const log = path.join(root, "log");
    const paused = path.join(root, "paused");
    const devLite = path.join(root, "dev-lite.sh");
    writeFileSync(
      devLite,
      [
        "cmd_pause() { :; }",
        `case "$1" in`,
        `  pause) echo pause >> ${log}; touch ${paused} ;;`,
        `  resume) echo resume >> ${log}; rm -f ${paused} ;;`,
        "esac",
        "",
      ].join("\n"),
    );
    chmodSync(devLite, 0o755);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      TMPDIR: root,
      ARCHESTRA_DEV_LITE_STATE_DIR: root,
      ARCHESTRA_AGENT_RUNTIME_POD_MEMORY_LIMIT: "4Gi",
      ARCHESTRA_AGENT_RUNTIME_POD_CPU_REQUEST: "1",
    };
    delete env.ARCHESTRA_HEAVY_LANE;
    return { root, log, env, devLite, paused };
  }

  /** The lane options of the frontend's type check, with the fake dev stack. */
  function bigCommand(devLite: string): string[] {
    return [
      "--label",
      "type-check (frontend)",
      "--peak-gib",
      "2.8",
      "--dev-lite",
      devLite,
      "--",
    ];
  }

  /** A shell line that logs its start, holds the lane a moment, and logs its end. */
  function logged(log: string, name: string): string {
    return `echo "start ${name}" >> ${log}; sleep 0.6; echo "end ${name}" >> ${log}`;
  }

  async function waitFor(condition: () => boolean): Promise<void> {
    for (let i = 0; i < 400; i++) {
      if (condition()) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("timed out waiting for the condition");
  }

  function readIfExists(file: string): string {
    return existsSync(file) ? readFileSync(file, "utf8") : "";
  }

  /** The lane's command line; `stderr()` reads what it printed so far. */
  function runCli(
    env: NodeJS.ProcessEnv,
    args: string[],
  ): Promise<{ status: number | null; stderr: string }> & {
    stderr: () => string;
    kill: (signal: NodeJS.Signals) => void;
  } {
    let stderr = "";
    let kill: (signal: NodeJS.Signals) => void = () => {};
    const done = new Promise<{ status: number | null; stderr: string }>(
      (resolve, reject) => {
        const child = spawn(process.execPath, [...NODE_FLAGS, LANE, ...args], {
          env,
          stdio: ["ignore", "ignore", "pipe"],
        });
        child.stderr.on("data", (chunk) => {
          stderr += chunk;
        });
        kill = (signal) => child.kill(signal);
        child.on("error", reject);
        child.on("close", (status) => resolve({ status, stderr }));
      },
    );
    return Object.assign(done, {
      stderr: () => stderr,
      kill: (signal: NodeJS.Signals) => kill(signal),
    });
  }
});
