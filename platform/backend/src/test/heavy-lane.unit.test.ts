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
  runHeavy,
} from "../../../scripts/heavy-lane";
import { resourceEnvelope } from "../../../vitest.resources";

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
      const { log, env } = scratch();
      const runs = ["first", "second", "third"].map((name) =>
        runCli(env, ["--label", name, "--", "sh", "-c", logged(log, name)]),
      );
      const results = await Promise.all(runs);
      expect(results.map((result) => result.status)).toEqual([0, 0, 0]);
      const lines = readFileSync(log, "utf8").trim().split("\n");
      expect(lines).toHaveLength(6);
      for (let i = 0; i < lines.length; i += 2) {
        const name = lines[i].split(" ")[1];
        expect(lines[i + 1]).toBe(`end ${name}`);
      }
      const waits = results
        .map((result) => result.stderr)
        .filter((stderr) => stderr.includes("waits for"));
      expect(waits.length).toBeGreaterThan(0);
      expect(results.map((result) => result.stderr).join("")).not.toContain(
        "Warning",
      );
      expect(waits[0]).toMatch(
        /^heavy-lane: \w+ waits for (\w+ \(pid \d+, running \d+ s\)|another memory-heavy command): one memory-heavy command runs at a time in this pod\.$/m,
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
    () => {
      const { log, env, devLite, paused } = scratch();
      const result = runHeavy({
        command: "sh",
        args: ["-c", `echo command >> ${log}; exit 3`],
        label: "type-check (frontend)",
        peakBytes: 2.8 * GIB,
        env,
        devLiteScript: devLite,
      });
      expect(result.status).toBe(3);
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
    () => {
      const { log, env, devLite, paused } = scratch();
      const small = runHeavy({
        command: "sh",
        args: ["-c", `echo small >> ${log}`],
        label: "knip (shared)",
        peakBytes: 0.7 * GIB,
        env,
        devLiteScript: devLite,
      });
      expect(small.status).toBe(0);
      writeFileSync(paused, "");
      const big = runHeavy({
        command: "sh",
        args: ["-c", `echo big >> ${log}`],
        label: "type-check (frontend)",
        peakBytes: 2.8 * GIB,
        env,
        devLiteScript: devLite,
      });
      expect(big.status).toBe(0);
      expect(readFileSync(log, "utf8").trim().split("\n")).toEqual([
        "small",
        "big",
      ]);
      expect(existsSync(paused)).toBe(true);
    },
  );

  test("without the lane the command runs directly", () => {
    const { log, env, devLite } = scratch();
    const result = runHeavy({
      command: "sh",
      args: ["-c", `echo direct >> ${log}`],
      label: "type-check (frontend)",
      peakBytes: 2.8 * GIB,
      env,
      lane: false,
      devLiteScript: devLite,
    });
    expect(result.status).toBe(0);
    expect(readFileSync(log, "utf8").trim()).toBe("direct");
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
    return { log, env, devLite, paused };
  }

  /** A shell line that logs its start, holds the lane a moment, and logs its end. */
  function logged(log: string, name: string): string {
    return `echo "start ${name}" >> ${log}; sleep 0.4; echo "end ${name}" >> ${log}`;
  }

  function runCli(
    env: NodeJS.ProcessEnv,
    args: string[],
  ): Promise<{ status: number | null; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [...NODE_FLAGS, LANE, ...args], {
        env,
        stdio: ["ignore", "ignore", "pipe"],
      });
      let stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("error", reject);
      child.on("close", (status) => resolve({ status, stderr }));
    });
  }
});
