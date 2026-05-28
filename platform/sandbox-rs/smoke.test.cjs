"use strict";

const assert = require("node:assert/strict");
const sandbox = require("./index.cjs");

const invalidInput = {
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
  extraAptPackages: ["bash;curl"],
};

(async () => {
  await assert.rejects(sandbox.runSandbox(invalidInput), (error) => {
    assert.equal(error.code, "ARCHESTRA_INVALID_INPUT");
    assert.match(error.message, /invalid apt package name/);
    return true;
  });

  assert.equal(Object.hasOwn(sandbox, "__testPanic"), false);
})();
