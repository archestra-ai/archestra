import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  runWorkspaceChecks,
  type WorkspaceCheck,
} from "../../../scripts/check-sequence";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "check sequence "));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

test("a later tool starts only after the earlier process releases its resources", () => {
  const completed = path.join(dir, "completed");
  const observed = path.join(dir, "observed");
  const status = runWorkspaceChecks([
    nodeCheck(
      "first",
      "setTimeout(() => require('node:fs').writeFileSync(process.argv[1], 'done'), 100)",
      completed,
    ),
    nodeCheck(
      "second",
      "const fs = require('node:fs'); fs.writeFileSync(process.argv[2], fs.readFileSync(process.argv[1]))",
      completed,
      observed,
    ),
  ]);
  expect(status).toBe(0);
  expect(fs.readFileSync(observed, "utf8")).toBe("done");
});

test("a tool failure preserves its exit code and prevents later tools from running", () => {
  const later = path.join(dir, "later");
  expect(
    runWorkspaceChecks([
      nodeCheck("fails", "process.exit(7)"),
      nodeCheck(
        "never",
        "require('node:fs').writeFileSync(process.argv[1], 'ran')",
        later,
      ),
    ]),
  ).toBe(7);
  expect(fs.existsSync(later)).toBe(false);
});

test("tool arguments containing spaces and shell syntax arrive unchanged", () => {
  const result = path.join(dir, "arguments");
  const args = ["two words", '"quoted"', "$literal", "semi;colon"];
  const check = nodeCheck(
    "arguments",
    "require('node:fs').writeFileSync(process.argv[1], JSON.stringify(process.argv.slice(2)))",
    result,
    ...args,
  );
  check.managesLane = true;
  expect(runWorkspaceChecks([check])).toBe(0);
  expect(JSON.parse(fs.readFileSync(result, "utf8"))).toEqual(args);
});

test("an unavailable tool surfaces its spawn error and stops the sequence", () => {
  const later = path.join(dir, "later");
  expect(() =>
    runWorkspaceChecks([
      {
        ...nodeCheck("missing", ""),
        command: path.join(dir, "missing-tool"),
      },
      nodeCheck(
        "never",
        "require('node:fs').writeFileSync(process.argv[1], 'ran')",
        later,
      ),
    ]),
  ).toThrow(/ENOENT/);
  expect(fs.existsSync(later)).toBe(false);
});

test.each([
  { mode: "all-commit", task: "check:commit" },
  { mode: "all-ci", task: "check:ci" },
  { mode: "all-type-check", task: "type-check" },
  { mode: "all-test", task: "test" },
  { mode: "all-knip", task: "knip" },
  { mode: "all-build", task: "build" },
  { mode: "all-lint", task: "lint" },
])("$mode works without native TypeScript support and limits workspace concurrency", ({
  mode,
  task,
}) => {
  const recorded = path.join(dir, "turbo-arguments");
  const turbo = path.join(dir, "turbo");
  fs.writeFileSync(
    turbo,
    `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(recorded)}, JSON.stringify(process.argv.slice(2)));\n`,
  );
  fs.chmodSync(turbo, 0o755);
  const platform = path.resolve(__dirname, "../../..");
  const result = spawnSync(
    process.execPath,
    [
      ...(process.features.typescript ? ["--no-experimental-strip-types"] : []),
      path.join(platform, "scripts/check-workspace.mjs"),
      mode,
      "--filter=@backend",
    ],
    {
      cwd: platform,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${dir}${path.delimiter}${process.env.PATH}`,
        ARCHESTRA_AGENT_RUNTIME_POD_MEMORY_LIMIT: "4Gi",
        ARCHESTRA_AGENT_RUNTIME_POD_CPU_REQUEST: "1",
        ARCHESTRA_DEV_LITE_STATE_DIR: path.join(dir, "dev-lite"),
        ARCHESTRA_HEAVY_LANE: "held",
      },
    },
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(fs.readFileSync(recorded, "utf8"))).toEqual([
    task,
    "--filter=@backend",
    "--concurrency=1",
  ]);
});

test.each([
  { args: [], override: false },
  { args: ["--webpack", "--profile"], override: true },
])("frontend builds fit the container and preserve explicit build options ($override)", ({
  args,
  override,
}) => {
  const recorded = path.join(dir, "next-build");
  const cached = path.join(dir, "cache-command");
  const bash = path.join(dir, "bash");
  fs.writeFileSync(
    bash,
    `#!${process.execPath}\nconst fs = require("node:fs");
      const args = process.argv.slice(2);
      fs.writeFileSync(${JSON.stringify(cached)}, JSON.stringify(args));
      const result = require("node:child_process").spawnSync("next", ["build", ...args.slice(3)], { stdio: "inherit" });
      process.exit(result.status ?? 1);\n`,
  );
  fs.chmodSync(bash, 0o755);
  const next = path.join(dir, "next");
  fs.writeFileSync(
    next,
    `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(recorded)}, JSON.stringify({
      args: process.argv.slice(2),
      workers: process.env.CIRCLE_NODE_TOTAL,
      maps: process.env.ARCHESTRA_DEV_LITE_SOURCE_MAPS,
      node: process.env.NODE_OPTIONS,
    }));\n`,
  );
  fs.chmodSync(next, 0o755);
  const platform = path.resolve(__dirname, "../../..");
  const result = spawnSync(
    process.execPath,
    [path.join(platform, "scripts/check-workspace.mjs"), "build", ...args],
    {
      cwd: path.join(platform, "frontend"),
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${dir}${path.delimiter}${process.env.PATH}`,
        ARCHESTRA_AGENT_RUNTIME_POD_MEMORY_LIMIT: "4Gi",
        ARCHESTRA_AGENT_RUNTIME_POD_CPU_REQUEST: "1",
        ARCHESTRA_HEAVY_LANE: "held",
        NODE_OPTIONS: override ? "--max-old-space-size=3072" : "",
        CIRCLE_NODE_TOTAL: override ? "3" : undefined,
        ARCHESTRA_DEV_LITE_SOURCE_MAPS: override ? "true" : undefined,
      },
    },
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  const built = JSON.parse(fs.readFileSync(recorded, "utf8"));
  expect(built.args).toEqual(
    override ? ["build", "--webpack", "--profile"] : ["build", "--turbopack"],
  );
  if (override) expect(fs.existsSync(cached)).toBe(false);
  else {
    expect(JSON.parse(fs.readFileSync(cached, "utf8"))).toEqual([
      path.join(platform, "scripts/dev-lite.sh"),
      "frontend-artifact",
      "build",
      "--turbopack",
    ]);
  }
  expect(built.node).toBe(
    override ? "--max-old-space-size=3072" : "--max-old-space-size=2048",
  );
  expect(built.workers).toBe(override ? "3" : "2");
  expect(built.maps).toBe(override ? "true" : "false");
});

function nodeCheck(
  label: string,
  code: string,
  ...args: string[]
): WorkspaceCheck {
  return {
    label,
    command: process.execPath,
    args: ["-e", code, ...args],
    // Lane behavior has its own subprocess suite. Exercise sequencing directly
    // even when this test itself runs inside a small container's lane.
    env: { ...process.env, ARCHESTRA_HEAVY_LANE: "held" },
  };
}

test.each([
  {
    command: "build",
    fail: "",
    expected: 0,
    modes: ["cache", "compile", "generate"],
    args: [],
  },
  {
    command: "build",
    fail: "compile",
    expected: 17,
    modes: ["cache", "compile"],
    args: [],
  },
  {
    command: "build",
    fail: "generate",
    expected: 23,
    modes: ["cache", "compile", "generate"],
    args: [],
  },
  {
    command: "build",
    fail: "signal",
    expected: 143,
    modes: ["cache", "compile"],
    args: [],
  },
  {
    command: "build",
    fail: "",
    expected: 0,
    modes: ["cache", "generate"],
    args: ["--experimental-build-mode", "generate"],
  },
  {
    command: "pack",
    fail: "",
    expected: 0,
    modes: ["cache", "compile", "generate", "pack"],
    args: [],
  },
  {
    command: "pack",
    fail: "compile",
    expected: 1,
    modes: ["cache", "compile"],
    args: [],
  },
])("frontend phases release the compiler and preserve failures/options ($command, $fail, $args)", ({
  command,
  fail,
  expected,
  modes,
  args,
}) => {
  const platform = path.join(dir, "frontend fixture");
  const scripts = path.join(platform, "scripts");
  const frontend = path.join(platform, "frontend");
  const next = path.join(frontend, "node_modules/next/dist/bin/next.js");
  fs.mkdirSync(path.dirname(next), { recursive: true });
  fs.mkdirSync(scripts, { recursive: true });
  fs.mkdirSync(path.join(platform, "backend"));
  fs.mkdirSync(path.join(frontend, ".next", "static"), { recursive: true });
  fs.mkdirSync(path.join(frontend, ".next", "standalone", "frontend", ".next"), {
    recursive: true,
  });
  fs.mkdirSync(path.join(frontend, "public"));
  fs.writeFileSync(path.join(platform, "Tiltfile"), "");
  fs.writeFileSync(path.join(platform, ".env.example"), "");
  fs.copyFileSync(
    path.resolve(__dirname, "../../../scripts/dev-lite.sh"),
    path.join(scripts, "dev-lite.sh"),
  );
  const log = path.join(dir, "phases.jsonl");
  fs.writeFileSync(
    path.join(scripts, "frontend-prebuilt.mjs"),
    `import fs from "node:fs";
if (process.argv[2] === "install") process.exit(1);
fs.appendFileSync(process.env.ARCHESTRA_TEST_NEXT_LOG, JSON.stringify({ mode: process.argv[2] === "--pack" ? "pack" : "cache" }) + "\\n");`,
  );
  fs.writeFileSync(
    next,
    String.raw`
const fs = require("node:fs");
const args = process.argv.slice(2);
const flag = args.find(arg => arg.startsWith("--experimental-build-mode="));
const mode = flag ? flag.split("=")[1] : args[args.indexOf("--experimental-build-mode") + 1];
const log = process.env.ARCHESTRA_TEST_NEXT_LOG;
const earlier = fs.readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
const compiler = earlier.find(event => event.mode === "compile");
if (mode === "generate" && compiler) {
  try { process.kill(compiler.pid, 0); process.exit(88); }
  catch (error) { if (error.code !== "ESRCH") throw error; }
}
fs.appendFileSync(log, JSON.stringify({ mode, args, pid: process.pid }) + "\n");
if (mode === process.env.ARCHESTRA_TEST_NEXT_FAIL) process.exit(mode === "compile" ? 17 : 23);
if (mode === "compile" && process.env.ARCHESTRA_TEST_NEXT_FAIL === "signal") process.kill(process.pid, "SIGTERM");
`,
  );
  const result = spawnSync(
    "bash",
    [
      path.join(scripts, "dev-lite.sh"),
      "frontend-artifact",
      command,
      ...(command === "pack"
        ? [dir]
        : [
            "--turbopack",
            "--debug-build-paths",
            "app/page with $literal",
            ...args,
          ]),
    ],
    {
      cwd: platform,
      encoding: "utf8",
      env: {
        ...process.env,
        ARCHESTRA_DEV_LITE_STATE_DIR: path.join(dir, "state"),
        ARCHESTRA_DEV_LITE_SOURCE_MAPS: "false",
        ARCHESTRA_AGENT_RUNTIME_POD_CPU_REQUEST: "1",
        ARCHESTRA_TEST_NEXT_LOG: log,
        ARCHESTRA_TEST_NEXT_FAIL: fail,
      },
    },
  );
  expect(result.status, result.stderr).toBe(expected);
  const events = fs
    .readFileSync(log, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(events.map((event) => event.mode)).toEqual(modes);
  for (const event of events.filter((event) => event.args)) {
    expect(event.args).toContain("--turbopack");
    if (command === "build") {
      expect(event.args).toContain("app/page with $literal");
    }
  }
});
