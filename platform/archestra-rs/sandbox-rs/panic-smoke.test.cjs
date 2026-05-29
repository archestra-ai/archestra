"use strict";

const assert = require("node:assert/strict");
const sandbox = require("./index.cjs");

assert.throws(
  () => sandbox.__testPanic(),
  (error) => {
    assert(error instanceof Error);
    assert.equal(error.code, "ARCHESTRA_INTERNAL");
    assert.match(error.message, /sandbox-rs panic smoke test/);
    return true;
  },
);
