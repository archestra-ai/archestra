import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { platformPrograms, Supervisor } from "./supervisor.mjs";

const node = process.execPath;

function quietSupervisor(programs) {
  const lines = [];
  const supervisor = new Supervisor({
    programs,
    log: (line) => lines.push(line),
  });
  return { supervisor, lines };
}

function until(check, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (check()) return resolve();
      if (Date.now() > deadline) return reject(new Error("timed out"));
      setTimeout(poll, 50);
    };
    poll();
  });
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("a program that exits is started again; a one-shot program is not", async () => {
  const dir = mkdtempSync(join(tmpdir(), "supervisor-"));
  const runs = join(dir, "runs");
  writeFileSync(runs, "");
  const { supervisor, lines } = quietSupervisor([
    {
      name: "crashy",
      command: [node, "-e", `require("fs").appendFileSync(${JSON.stringify(runs)}, "x"); process.exit(3)`],
      stopSeconds: 1,
      restart: true,
      stage: "first",
    },
    {
      name: "banner",
      command: [node, "-e", "process.exit(0)"],
      stopSeconds: 1,
      restart: false,
      stage: "first",
    },
  ]);
  supervisor.start();
  // First run, then a restart after 1s.
  await until(() => readFileSync(runs, "utf8").length >= 2, 5000);
  await supervisor.stop();
  assert.ok(lines.some((line) => line === "crashy exited (3); restarting in 1s"));
  assert.ok(!lines.some((line) => line.startsWith("banner")));
});

test("stop kills the whole process group of a program that ignores SIGTERM", async () => {
  const dir = mkdtempSync(join(tmpdir(), "supervisor-"));
  const pidFile = join(dir, "grandchild.pid");
  const script = `
    process.on("SIGTERM", () => {});
    const child = require("child_process").spawn(process.execPath,
      ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" });
    require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
    setInterval(() => {}, 1000);`;
  const { supervisor, lines } = quietSupervisor([
    { name: "stubborn", command: [node, "-e", script], stopSeconds: 0.5, restart: true, stage: "first" },
  ]);
  supervisor.start();
  await until(() => {
    try {
      return readFileSync(pidFile, "utf8").length > 0;
    } catch {
      return false;
    }
  });
  const grandchild = Number(readFileSync(pidFile, "utf8"));
  await supervisor.stop();
  await until(() => !alive(grandchild), 3000);
  assert.ok(lines.includes("stubborn did not stop within 0.5s; killing it"));
});

test("the database stops only after the programs that use it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "supervisor-"));
  const order = join(dir, "order");
  writeFileSync(order, "");
  const program = (name, stage, delayMs) => ({
    name,
    command: [
      node,
      "-e",
      `process.on("SIGTERM", () => setTimeout(() => { require("fs").appendFileSync(${JSON.stringify(order)}, "${name} "); process.exit(0) }, ${delayMs})); setInterval(() => {}, 1000)`,
    ],
    stopSeconds: 5,
    restart: true,
    stage,
  });
  const { supervisor } = quietSupervisor([
    program("postgres", "last", 0),
    program("backend", "first", 400),
    program("frontend", "first", 100),
  ]);
  supervisor.start();
  await new Promise((resolve) => setTimeout(resolve, 300));
  await supervisor.stop();
  assert.equal(readFileSync(order, "utf8"), "frontend backend postgres ");
});

test("the platform's programs: the frontend's own variable names, and the database only when bundled", () => {
  const env = {
    ARCHESTRA_SERVER_SUPERVISOR_STOP_SECONDS: "120",
    ARCHESTRA_HTTP_KEEP_ALIVE_TIMEOUT_MS: "620000",
    ARCHESTRA_API_BASE_URL: "https://archestra.example.com",
    ARCHESTRA_ENTERPRISE_LICENSE_ACTIVATED: "true",
  };
  const programs = platformPrograms({ env, bundledPostgres: false });
  assert.deepEqual(
    programs.map((program) => program.name),
    ["backend", "frontend", "startup-banner"],
  );
  const [backend, frontend, banner] = programs;
  assert.equal(backend.stopSeconds, 120);
  assert.deepEqual(backend.env, {});
  assert.equal(banner.restart, false);
  assert.equal(frontend.env.HOSTNAME, "0.0.0.0");
  assert.equal(frontend.env.KEEP_ALIVE_TIMEOUT, "620000");
  assert.equal(frontend.env.NEXT_PUBLIC_ARCHESTRA_API_BASE_URL, "https://archestra.example.com");
  assert.equal(frontend.env.NEXT_PUBLIC_ARCHESTRA_ENTERPRISE_LICENSE_ACTIVATED, "true");
  assert.equal(frontend.env.NEXT_PUBLIC_ARCHESTRA_SENTRY_FRONTEND_DSN, "");
  // An unusable stop budget falls back to the default.
  assert.equal(
    platformPrograms({ env: { ARCHESTRA_SERVER_SUPERVISOR_STOP_SECONDS: "x" }, bundledPostgres: false })[0]
      .stopSeconds,
    90,
  );
});
