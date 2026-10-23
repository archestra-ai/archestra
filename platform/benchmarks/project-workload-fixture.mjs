import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { projectToolError } from "./project-error-classification.mjs";
import { createSequentialWorkload } from "./sequential-project-workload.mjs";

const exec = promisify(execFile);
const hash = (value) => createHash("sha256").update(value).digest("hex");
export const CHECKER_IMAGE =
  "sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402";

export async function createProjectFixture({
  namespace,
  image = CHECKER_IMAGE,
  checkRunner = dockerCheck,
  workload = "short",
}) {
  assert.match(namespace, /^[a-z][a-z0-9-]{7,39}$/);
  assert.ok(["short", "sequential"].includes(workload));
  const sequential =
    workload === "sequential" ? createSequentialWorkload() : null;
  const seedFiles = sequential?.files ?? SEED_FILES;
  const root = await mkdtemp(join(tmpdir(), "appa-project-bench-"));
  const project = join(root, "project");
  const checks = join(root, "checks");
  await mkdir(join(project, "src"), { recursive: true, mode: 0o755 });
  await chmod(project, 0o755);
  await mkdir(checks, { mode: 0o755 });
  for (const [name, text] of Object.entries(seedFiles))
    await writeFile(join(project, name), text, { mode: 0o644 });
  const checkFile = join(checks, "checks.spec.mjs");
  const checkData = sequential ? join(checks, "checks.json") : undefined;
  const initialChecks = sequential?.checks();
  await writeFile(checkFile, initialChecks?.source ?? CHECKS, { mode: 0o644 });
  if (initialChecks)
    await writeFile(checkData, initialChecks.data, { mode: 0o644 });
  const writable = Object.keys(seedFiles).filter(
    (name) => name.startsWith("src/") && name !== "src/index.mjs",
  );
  const readable = [...Object.keys(seedFiles), "checks.spec.mjs"];
  const tools = projectTools({
    namespace,
    readable,
    writable,
    sequential: !!sequential,
  });
  const calls = [];
  const modified = new Set();
  const containers = new Set();
  const authorityCalls = [];
  let failedBeforeEditing = false;
  let lastCheck = null;
  let published = false;
  let queue = Promise.resolve();
  let closed = false;
  const sourceDigest = async () =>
    hash(
      JSON.stringify(
        await Promise.all(
          Object.keys(seedFiles)
            .sort()
            .map(async (name) => [
              name,
              await readFile(join(project, name), "utf8"),
            ]),
        ),
      ),
    );
  const read = async (name) => {
    assert.ok(readable.includes(name), "path_not_allowed");
    const path = name === "checks.spec.mjs" ? checkFile : join(project, name);
    const info = await lstat(path);
    assert.ok(
      info.isFile() && !info.isSymbolicLink(),
      "not_an_owned_regular_file",
    );
    return readFile(path, "utf8");
  };
  const dispatch = async (method, params) => {
    assert.ok(!closed, "fixture_closed");
    if (method === "initialize")
      return {
        protocolVersion: "2025-11-25",
        capabilities: { tools: {} },
        serverInfo: { name: "isolated-project-benchmark", version: "1" },
      };
    if (method === "ping") return {};
    if (method === "tools/list") return { tools };
    assert.equal(method, "tools/call");
    const { name } = params;
    let args = params.arguments ?? {};
    assert.ok(
      tools.some((tool) => tool.name === name),
      "unknown_project_tool",
    );
    const start = performance.now();
    const startedUnixMs = Date.now();
    const entry = {
      index: calls.length,
      name,
      startedUnixMs,
      ok: false,
      argumentBytes: Buffer.byteLength(JSON.stringify(args)),
      path: readable.includes(args.path) ? args.path : undefined,
    };
    calls.push(entry);
    try {
      if (sequential) args = sequential.before({ name, args, entry });
      let value;
      if (name === "project_list") {
        assert.equal(Object.keys(args).length, 0);
        value = {
          files: readable,
          writable,
          task: "ticket.txt",
          checks: "checks.spec.mjs",
        };
      } else if (name === "project_read") {
        assert.deepEqual(Object.keys(args).sort(), ["path"]);
        value = { path: args.path, text: await read(args.path) };
      } else if (name === "project_search") {
        assert.deepEqual(Object.keys(args).sort(), ["text"]);
        assert.ok(
          typeof args.text === "string" &&
            args.text.length > 0 &&
            args.text.length <= 200,
        );
        const matches = [];
        for (const path of readable)
          for (const [index, line] of (await read(path)).split("\n").entries())
            if (line.includes(args.text) && matches.length < 40)
              matches.push({ path, line: index + 1, text: line.slice(0, 500) });
        value = { matches };
      } else if (name === "project_edit") {
        assert.ok(!published, "already_published");
        assert.deepEqual(Object.keys(args).sort(), ["after", "before", "path"]);
        assert.ok(writable.includes(args.path), "write_path_not_allowed");
        assert.ok(
          typeof args.before === "string" &&
            args.before.length > 0 &&
            args.before.length <= 32768 &&
            typeof args.after === "string" &&
            args.after.length <= 32768 &&
            args.before !== args.after,
        );
        const original = await read(args.path);
        assert.equal(
          original.split(args.before).length,
          2,
          "replacement_must_match_exactly_once",
        );
        const updated = original.replace(args.before, () => args.after);
        assert.ok(Buffer.byteLength(updated) <= 65536, "file_size_limit");
        await writeFile(join(project, args.path), updated, { mode: 0o644 });
        modified.add(args.path);
        lastCheck = null;
        entry.beforeHash = hash(original);
        entry.afterHash = hash(updated);
        value = { path: args.path, changed: true, sha256: entry.afterHash };
      } else if (name === "project_check") {
        assert.equal(Object.keys(args).length, 0);
        const digest = await sourceDigest();
        if (sequential) {
          const nextChecks = sequential.checks();
          await writeFile(checkFile, nextChecks.source, { mode: 0o644 });
          await writeFile(checkData, nextChecks.data, { mode: 0o644 });
        }
        const result = await checkRunner({
          project,
          checkFile,
          checkData,
          image,
          containers,
          expectedTests: sequential?.expectedTests() ?? 10,
        });
        assert.ok(typeof result.passed === "boolean");
        if (!modified.size && !result.passed) failedBeforeEditing = true;
        lastCheck = { passed: result.passed, sourceHash: digest };
        entry.checkPassed = result.passed;
        value = {
          passed: result.passed,
          exitCode: result.exitCode ?? null,
          output: sequential
            ? String(result.output ?? "")
            : String(result.output ?? "").slice(0, 10000),
          sourceHash: digest,
        };
      } else {
        assert.equal(name, "project_publish");
        assert.deepEqual(Object.keys(args).sort(), ["summary"]);
        assert.ok(
          typeof args.summary === "string" &&
            args.summary.length >= 20 &&
            args.summary.length <= 8000,
        );
        assert.ok(
          failedBeforeEditing &&
            modified.size >= 3 &&
            lastCheck?.passed &&
            lastCheck.sourceHash === (await sourceDigest()),
          "verified_complete_work_required",
        );
        assert.ok(!published, "already_published");
        published = true;
        value = {
          published: true,
          modified: [...modified].sort(),
          sourceHash: lastCheck.sourceHash,
          summaryHash: hash(args.summary),
        };
      }
      if (sequential) value = sequential.after({ name, value, entry });
      const text = JSON.stringify(value);
      entry.ok = true;
      entry.resultHash = hash(text);
      entry.resultBytes = Buffer.byteLength(text);
      return { content: [{ type: "text", text }], isError: false };
    } catch (error) {
      entry.error = String(error.message ?? "project_tool_failed")
        .split("\n")[0]
        .slice(0, 120);
      const refusal = projectToolError(error);
      entry.errorKind = refusal.kind;
      const errorText = `Project tool refused: ${refusal.code}`;
      entry.resultBytes = Buffer.byteLength(errorText);
      entry.resultHash = hash(errorText);
      throw error;
    } finally {
      entry.latencyMs = performance.now() - start;
    }
  };
  const execute = (method, params) => {
    const work = queue.then(() => dispatch(method, params));
    queue = work.catch(() => {});
    return work;
  };
  const server = createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    let id = null;
    try {
      if (req.method === "GET" && req.url === "/health") {
        res.end(JSON.stringify({ ok: true, tools: tools.length }));
        return;
      }
      const authority = req.url === "/authority" && req.method === "POST";
      if (req.url !== "/mcp" && !authority) {
        res.statusCode = 404;
        res.end();
        return;
      }
      if (req.method !== "POST") {
        res.statusCode = 405;
        res.end();
        return;
      }
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        assert.ok(size <= (authority ? 1048576 : 131072));
        chunks.push(chunk);
      }
      const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (authority) {
        assert.ok(value && typeof value === "object" && !Array.isArray(value));
        authorityCalls.push({
          queryHash: hash(JSON.stringify(value)),
          ruling: "approve",
        });
        res.end(JSON.stringify({ version: 1, answer: { ruling: "approve" } }));
        return;
      }
      id = value.id ?? null;
      if (value.method === "notifications/initialized") {
        res.statusCode = 202;
        res.end();
        return;
      }
      assert.equal(value.jsonrpc, "2.0");
      const result = await execute(value.method, value.params);
      res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
    } catch (error) {
      if (req.url === "/authority") {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: "invalid_authority_request" }));
        return;
      }
      const refusal = projectToolError(error);
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          result: {
            isError: true,
            _meta: { benchmark_error: refusal },
            content: [
              { type: "text", text: `Project tool refused: ${refusal.code}` },
            ],
          },
        }),
      );
    }
  });
  const status = async () => ({
    failedBeforeEditing,
    modified: [...modified].sort(),
    published,
    lastCheck,
    sourceHash: await sourceDigest(),
    calls: structuredClone(calls),
    authorityCalls: structuredClone(authorityCalls),
    workload: sequential?.status() ?? { id: "ledger-short" },
  });
  const close = async () => {
    closed = true;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    for (const name of containers) await removeContainer(name);
    await queue;
    await rm(root, { recursive: true, force: true });
  };
  return {
    server,
    tools,
    execute,
    status,
    close,
    isComplete: () => published && lastCheck?.passed === true,
  };
}

async function dockerCheck({
  project,
  checkFile,
  checkData,
  image,
  containers,
  expectedTests = 10,
}) {
  assert.match(image, /^sha256:[0-9a-f]{64}$/);
  assert.ok(
    Number.isInteger(expectedTests) &&
      expectedTests >= 1 &&
      expectedTests <= 200,
  );
  assert.ok(
    ![project, checkFile, checkData]
      .filter(Boolean)
      .some((path) => /[,\r\n]/.test(path)),
  );
  const name = `appa-project-check-${randomUUID()}`;
  containers.add(name);
  try {
    let result;
    try {
      result = await exec(
        "docker",
        [
          "-H",
          "unix:///var/run/docker.sock",
          "run",
          "--pull=never",
          "--rm",
          "--name",
          name,
          "--network",
          "none",
          "--read-only",
          "--cap-drop=ALL",
          "--security-opt=no-new-privileges",
          "--user",
          "65534:65534",
          "--pids-limit",
          "64",
          "--memory",
          "256m",
          "--cpus",
          "1",
          "--tmpfs",
          "/tmp:rw,noexec,nosuid,size=16m",
          "--mount",
          `type=bind,src=${project},dst=/workspace,readonly`,
          "--mount",
          `type=bind,src=${checkFile},dst=/checks/checks.spec.mjs,readonly`,
          ...(checkData
            ? [
                "--mount",
                `type=bind,src=${checkData},dst=/checks/checks.json,readonly`,
              ]
            : []),
          "--workdir",
          "/workspace",
          image,
          "node",
          "--test",
          "--test-reporter=tap",
          "/checks/checks.spec.mjs",
        ],
        {
          timeout: 15000,
          maxBuffer: 131072,
          env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
        },
      );
    } catch (error) {
      if (typeof error.code !== "number")
        throw new Error("checker_process_failed");
      result = {
        stdout: error.stdout ?? "",
        stderr: error.stderr ?? "",
        code: error.code,
      };
    }
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    const tests = Number(/^# tests (\d+)\s*$/m.exec(output)?.[1]);
    const passed = Number(/^# pass (\d+)\s*$/m.exec(output)?.[1]);
    const failed = Number(/^# fail (\d+)\s*$/m.exec(output)?.[1]);
    const skipped = Number(/^# skipped (\d+)\s*$/m.exec(output)?.[1]);
    return {
      passed:
        (result.code ?? 0) === 0 &&
        tests === expectedTests &&
        passed === expectedTests &&
        failed === 0 &&
        skipped === 0,
      exitCode: result.code ?? 0,
      output,
    };
  } finally {
    await removeContainer(name);
    containers.delete(name);
  }
}

async function removeContainer(name) {
  assert.match(name, /^appa-project-check-[0-9a-f-]+$/);
  await exec(
    "docker",
    ["-H", "unix:///var/run/docker.sock", "rm", "-f", name],
    {
      timeout: 5000,
      maxBuffer: 4096,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    },
  ).catch(() => {});
}

function projectTools({ namespace, readable, writable, sequential = false }) {
  const schema = (properties = {}, required = Object.keys(properties)) => ({
    type: "object",
    properties,
    required,
    additionalProperties: false,
  });
  const text = (maxLength) => ({ type: "string", minLength: 1, maxLength });
  return [
    [
      "project_list",
      "List the isolated project's files and editable source paths.",
      schema(),
    ],
    [
      "project_read",
      "Read one project file, ticket, or immutable check file.",
      schema({ path: { type: "string", enum: readable } }),
    ],
    [
      "project_search",
      "Find literal text across the isolated project's files.",
      schema({ text: text(200) }),
    ],
    [
      "project_edit",
      "Replace exactly one occurrence of before with after in one allowed source file. Tests and ticket cannot be changed.",
      schema({
        path: { type: "string", enum: writable },
        before: text(32768),
        after: { type: "string", maxLength: 32768 },
        ...(sequential
          ? { revision: { type: "string", pattern: "^[0-9a-f]{64}$" } }
          : {}),
      }),
    ],
    [
      "project_check",
      "Run the immutable checks in a no-network container. Reproduce failures before editing, then verify the fix.",
      schema(
        sequential
          ? { revision: { type: "string", pattern: "^[0-9a-f]{64}$" } }
          : {},
      ),
    ],
    [
      "project_publish",
      "Publish the final result after a reproduced failure, fixes in at least three modules, and passing checks on the current code.",
      schema({
        summary: text(8000),
        ...(sequential
          ? { revision: { type: "string", pattern: "^[0-9a-f]{64}$" } }
          : {}),
      }),
    ],
  ].map(([name, description, inputSchema]) => ({
    name,
    description: `Benchmark namespace: ${namespace}. ${description}`,
    inputSchema,
  }));
}

const SEED_FILES = {
  "ticket.txt": `Fix the ledger reconciliation library. Reproduce its failing checks before changing code. Inspect the source and immutable checks, fix the underlying bugs, and rerun checks. Do not change tests or weaken requirements.\nRequirements: parseCents accepts trimmed signed decimal strings with zero to two fractional digits, returns exact integer cents, and rejects invalid strings/non-strings/unsafe integer results. filterPeriod includes start, excludes end, compares actual UTC instants including timezone offsets, ignores invalid row timestamps, and rejects invalid windows. uniqueLatest chooses the newest updatedAt per id, the last record on timestamp ties, and returns ids in sorted order. totalByCurrency skips voided rows, parses exact cents, and returns currency keys in sorted order. reconcile chooses the newest record before filtering the time window, removes voided records, and returns {ids,totals} in deterministic order.\nAll checks must pass. Fix at least three source modules. Use only the project tools. project_check is the only allowed test runner. Publish only after the complete task is verified.\n`,
  "src/money.mjs": `export function parseCents(value) { return Math.round(Number.parseFloat(value)); }\n`,
  "src/period.mjs": `export function filterPeriod(rows, start, end) { return rows.filter(row => row.timestamp >= start && row.timestamp <= end); }\n`,
  "src/dedupe.mjs": `export function uniqueLatest(rows) { const byId = new Map(); for (const row of rows) if (!byId.has(row.id)) byId.set(row.id, row); return [...byId.values()]; }\n`,
  "src/totals.mjs": `export function totalByCurrency(rows) { const totals = {}; for (const row of rows) totals[row.currency] = (totals[row.currency] ?? 0) + Number(row.amount) * 100; return totals; }\n`,
  "src/reconcile.mjs": `import { filterPeriod } from './period.mjs';\nimport { uniqueLatest } from './dedupe.mjs';\nimport { totalByCurrency } from './totals.mjs';\nexport function reconcile(rows, start, end) { const selected = uniqueLatest(filterPeriod(rows, start, end)); return { ids: selected.map(row => row.id), totals: totalByCurrency(selected) }; }\n`,
  "src/index.mjs": `export { parseCents } from './money.mjs';\nexport { filterPeriod } from './period.mjs';\nexport { uniqueLatest } from './dedupe.mjs';\nexport { totalByCurrency } from './totals.mjs';\nexport { reconcile } from './reconcile.mjs';\n`,
};

const CHECKS = `import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCents } from '/workspace/src/money.mjs';
import { filterPeriod } from '/workspace/src/period.mjs';
import { uniqueLatest } from '/workspace/src/dedupe.mjs';
import { totalByCurrency } from '/workspace/src/totals.mjs';
import { reconcile } from '/workspace/src/reconcile.mjs';
test('money exact signed decimals', () => { for (const [x,y] of [['12.34',1234],['-0.05',-5],['0',0],[' +1.2 ',120],['001.20',120]]) assert.equal(parseCents(x),y); });
test('money rejects malformed input', () => { for(const x of ['', '1.234','1e2','NaN','1 2',null,12]) assert.throws(()=>parseCents(x)); });
test('money rejects unsafe results', () => { assert.throws(()=>parseCents('999999999999999999999.99')); });
test('period start included end excluded', () => { const rows=[{id:'a',timestamp:'2026-01-01T00:00:00Z'},{id:'b',timestamp:'2026-01-02T00:00:00Z'}]; assert.deepEqual(filterPeriod(rows,'2026-01-01T00:00:00Z','2026-01-02T00:00:00Z').map(x=>x.id),['a']); });
test('period compares instants and validates windows', () => { assert.equal(filterPeriod([{timestamp:'2025-12-31T19:30:00-05:00'},{timestamp:'invalid'}],'2026-01-01T00:00:00Z','2026-01-01T01:00:00Z').length,1); assert.throws(()=>filterPeriod([],'bad','bad')); assert.throws(()=>filterPeriod([],'2026-01-02','2026-01-01')); });
test('dedupe newest wins independent of order', () => { const old={id:'a',updatedAt:'2026-01-01T00:00:00Z'},newer={id:'a',updatedAt:'2026-01-02T00:00:00Z'}; assert.deepEqual(uniqueLatest([old,newer]),[newer]); assert.deepEqual(uniqueLatest([newer,old]),[newer]); });
test('dedupe sorts and last timestamp tie wins', () => { const a={id:'a',updatedAt:'2026-01-01',value:1},b={...a,value:2}; assert.deepEqual(uniqueLatest([{id:'z',updatedAt:'2026-01-01'},a,b]).map(x=>[x.id,x.value]),[['a',2],['z',undefined]]); });
test('totals exact cents and ignores voided values', () => { const x=totalByCurrency([{currency:'USD',amount:'0.10'},{currency:'USD',amount:'0.20'},{currency:'EUR',amount:'-0.05'},{currency:'USD',amount:'invalid',status:'voided'}]); assert.deepEqual(x,{EUR:-5,USD:30}); assert.deepEqual(Object.keys(x),['EUR','USD']); });
test('reconcile dedupes before period filtering', () => { const rows=[{id:'a',updatedAt:'2026-01-01',timestamp:'2026-01-01T00:00:00Z',currency:'USD',amount:'1.00'},{id:'a',updatedAt:'2026-01-03',timestamp:'2026-01-03T00:00:00Z',currency:'USD',amount:'2.00'}]; assert.deepEqual(reconcile(rows,'2026-01-01','2026-01-02'),{ids:[],totals:{}}); });
test('reconcile deterministic result and void exclusion', () => { const rows=[{id:'b',updatedAt:'2026-01-01',timestamp:'2026-01-01T12:00:00Z',currency:'USD',amount:'1.23'},{id:'a',updatedAt:'2026-01-01',timestamp:'2026-01-01T12:00:00Z',currency:'EUR',amount:'-0.05'},{id:'c',updatedAt:'2026-01-01',timestamp:'2026-01-01T12:00:00Z',currency:'USD',amount:'99.00',status:'voided'}]; assert.deepEqual(reconcile(rows,'2026-01-01','2026-01-02'),{ids:['a','b'],totals:{EUR:-5,USD:123}}); });
`;
