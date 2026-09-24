"use strict";
const assert = require("node:assert/strict");
const { initializeOpenappa, dispatchHook, loadOfferReview } = require("./index.cjs");
assert.equal(typeof initializeOpenappa, "function");
assert.equal(typeof dispatchHook, "function");
assert.equal(typeof loadOfferReview, "function");
// Exercise the native async boundary without requiring a database.
const policy = { content: "[policy]\nversion = 2\n", credentials: {} };
async function checkNativeBoundary() {
  await assert.rejects(dispatchHook("{}", policy), /missing field/);
  const session = { organization_id: "org", caller_id: "user:alice", session_id: "session" };
  await assert.rejects(dispatchHook(JSON.stringify({ ...session, event: "remedy", operation_id: "remedy:1", arguments: { offer_id: "offer" }, unexpected_field: "value" }), policy), /unknown field.*unexpected_field/);
  await assert.rejects(dispatchHook(JSON.stringify({ ...session, event: "remedy", operation_id: "remedy:1", arguments: { offer_id: "offer" }, ruling: "approve" }), policy), /OpenAPPA is not initialized/);
  await assert.rejects(loadOfferReview("org", "offer", "user:alice"), /OpenAPPA is not initialized/);
  for (const event of ["remedy_review", "resume_tool_call"]) {
    await assert.rejects(dispatchHook(JSON.stringify({ ...session, event }), policy), /unknown variant/);
  }
}
checkNativeBoundary().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
