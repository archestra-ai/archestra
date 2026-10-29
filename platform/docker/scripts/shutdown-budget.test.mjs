import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
const drain = "ARCHESTRA_SERVER_REQUEST_DRAIN_SECONDS";
const cleanup = "ARCHESTRA_SERVER_SHUTDOWN_CLEANUP_SECONDS";
const worker = "ARCHESTRA_KNOWLEDGE_BASE_TASK_WORKER_SHUTDOWN_TIMEOUT_SECONDS";
function budget(env = {}) {
  return spawnSync(process.execPath, ["docker/scripts/shutdown-budget.mjs"], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, ...env },
  });
}
test("supervisor reserves cleanup and ten seconds beyond request or task drain", () => {
  assert.equal(budget().stdout.trim(), "90");
  assert.equal(budget({ [drain]: "200" }).stdout.trim(), "230");
  assert.equal(budget({ [worker]: "240" }).stdout.trim(), "270");
  assert.equal(
    budget({ [drain]: "0008", [cleanup]: "5", [worker]: "1" }).stdout.trim(),
    "23",
  );
});
for (const [name, value] of [
  [drain, "0"],
  [drain, "1.5"],
  [cleanup, "4"],
  [worker, "-1"],
  [drain, "86401"],
  [drain, ""],
]) {
  test(`rejects invalid ${name}=${value}`, () =>
    assert.notEqual(budget({ [name]: value }).status, 0));
}
