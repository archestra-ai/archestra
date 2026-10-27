import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { comparisonProfile } from "./profile.mjs";

const report = fileURLToPath(new URL("./report.mjs", import.meta.url));
test("report pools matching request metrics and refuses incomplete or failed evidence", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "proxy-report-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const dir = path.join(cwd, "benchmarks/results/cross-proxy");
  await mkdir(dir, { recursive: true });
  const fixture = (repeat) => ({
    blocks: [false, true].map((streaming) => ({
      target: "archestra",
      repeat,
      streaming,
      count: 1,
      errors: 0,
      requestsPerSecond: 100,
      samples: [
        {
          ok: true,
          clientAddedMs: repeat * 10,
          totalMs: repeat * 10 + 2,
          firstContentMs: repeat + 5,
          firstContentAddedMs: repeat,
          gatewayTiming: { overheadMs: repeat },
        },
      ],
    })),
  });
  for (const target of ["archestra", "litellm", "litellm-default"])
    for (let repeat = 1; repeat <= 4; repeat++) {
      const value = fixture(repeat);
      value.blocks.forEach((b) => {
        b.target = target;
      });
      await writeFile(
        path.join(dir, `${target}-${repeat}.json`),
        JSON.stringify(value),
      );
    }
  execFileSync(process.execPath, [report], { cwd, stdio: "pipe" });
  const summary = JSON.parse(await readFile(path.join(dir, "summary.json")));
  assert.equal(summary.length, 6);
  assert.equal(summary[0].clientAddedMs.p50, 20);
  assert.equal(summary[0].clientAddedMs.p99, 40);
  assert.equal(summary[0].samples, 4);
  // Current runs select the conservative two-profile comparison; original
  // three-profile archives above must continue to work unchanged.
  for (let repeat = 1; repeat <= 4; repeat++)
    await unlink(path.join(dir, `litellm-${repeat}.json`));
  await writeFile(
    path.join(dir, "profile.json"),
    JSON.stringify(comparisonProfile()),
  );
  execFileSync(process.execPath, [report], { cwd, stdio: "pipe" });
  const selected = JSON.parse(await readFile(path.join(dir, "summary.json")));
  assert.equal(selected.length, 4);
  assert.deepEqual(
    [...new Set(selected.map((r) => r.target))],
    ["archestra", "litellm-default"],
  );
  assert.equal(selected[0].clientAddedMs.p50, summary[0].clientAddedMs.p50);
  const invalid = fixture(4);
  invalid.blocks[0].errors = 1;
  await writeFile(path.join(dir, "archestra-4.json"), JSON.stringify(invalid));
  assert.throws(() =>
    execFileSync(process.execPath, [report], { cwd, stdio: "pipe" }),
  );
  await unlink(path.join(dir, "archestra-4.json"));
  assert.throws(() =>
    execFileSync(process.execPath, [report], { cwd, stdio: "pipe" }),
  );
});
