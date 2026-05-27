"use strict";

const assert = require("node:assert/strict");
const sandbox = require("./index.cjs");

const invalidInput = {
  image: "debian:bookworm-slim",
  defaultCwd: "/skills/test",
  aptPackages: ["bash;curl"],
  snapshots: [
    {
      skillName: "test",
      path: "SKILL.md",
      encoding: "utf8",
      content: "test skill",
    },
  ],
  replayCommands: [],
  limits: {
    outputBytesLimit: 1024,
    fileSizeLimitBytes: 1024,
    cpuSeconds: 1,
    memoryBytes: 64 * 1024 * 1024,
    maxProcesses: 16,
  },
  command: "echo hi",
  cwd: "/skills/test",
  timeoutSeconds: 1,
};

(async () => {
  await assert.rejects(
    sandbox.runSandboxCommand(invalidInput),
    (error) => {
      assert.equal(error.code, "ARCHESTRA_INVALID_INPUT");
      assert.match(error.message, /invalid apt package name/);
      return true;
    },
  );

  assert.throws(
    () => sandbox.__testPanic(),
    (error) => {
      assert(error instanceof Error);
      assert.equal(error.code, "ARCHESTRA_INTERNAL");
      assert.match(error.message, /sandbox-rs panic smoke test/);
      return true;
    },
  );
})();
