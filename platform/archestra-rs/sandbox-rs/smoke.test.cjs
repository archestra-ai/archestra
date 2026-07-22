"use strict";

const assert = require("node:assert/strict");
const sandbox = require("./index.cjs");

// asserts the NAPI binding surfaces validation errors with the right code.
// `cwd` outside the sandbox roots should be rejected before any engine call.
const invalidInput = {
  snapshots: [
    {
      skillName: "test",
      path: "SKILL.md",
      encoding: "utf8",
      content: "test skill",
    },
  ],
  replayEntries: [],
  limits: {
    outputBytesLimit: 1024,
    fileSizeLimitBytes: 1024,
    cpuSeconds: 1,
    memoryBytes: 64 * 1024 * 1024,
  },
  command: "echo hi",
  cwd: "/etc",
  timeoutSeconds: 1,
};

(async () => {
  await assert.rejects(sandbox.runSandbox(invalidInput), (error) => {
    assert.equal(error.code, "ARCHESTRA_INVALID_INPUT");
    assert.match(error.message, /cwd must be under/);
    return true;
  });

  assert.equal(Object.hasOwn(sandbox, "__testPanic"), false);
})();
