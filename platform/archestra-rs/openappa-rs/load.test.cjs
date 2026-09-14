"use strict";
const assert = require("node:assert/strict");
const { initializeOpenappa, dispatchHook, openappaProxyCapabilities, dispatchOpenappaProxyEvent, dispatchOpenappaCheckpoint } = require("./index.cjs");
assert.equal(typeof initializeOpenappa, "function");
assert.equal(typeof dispatchHook, "function");
assert.equal(typeof openappaProxyCapabilities, "function");
assert.equal(typeof dispatchOpenappaProxyEvent, "function");
assert.equal(typeof dispatchOpenappaCheckpoint, "function");
// Exercise the native async boundary without requiring a database or policy.
async function checkNativeBoundary() {
  await assert.rejects(dispatchHook("{}"), /missing field/);
  const session = { organization_id: "org", caller_id: "user:alice", session_id: "session" };
  await assert.rejects(dispatchHook(JSON.stringify({ ...session, event: "remedy", operation_id: "remedy:1", arguments: { offer_id: "offer" }, ruling: "approve" })), /unknown field.*ruling/);
  for (const event of ["remedy_review", "resume_tool_call"]) {
    await assert.rejects(dispatchHook(JSON.stringify({ ...session, event })), /unsupported OpenAPPA event/);
  }
}
checkNativeBoundary().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
