"use strict";
const assert = require("node:assert/strict");
const { initializeOpenappa, dispatchHook } = require("./index.cjs");
assert.equal(typeof initializeOpenappa, "function");
assert.equal(typeof dispatchHook, "function");
// Exercise the native async boundary without requiring a database or policy.
assert.rejects(dispatchHook("{}"), /missing field/).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
