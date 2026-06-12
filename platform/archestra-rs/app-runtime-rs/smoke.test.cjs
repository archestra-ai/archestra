"use strict";

const assert = require("node:assert/strict");
const appRuntime = require("./index.cjs");

const html = "<!DOCTYPE html><html><head></head><body></body></html>";

// Happy path: the three references land at the start of <head>, in order, and
// the per-viewer context is embedded.
const out = appRuntime.prepareAppEnvelope(
  html,
  JSON.stringify({ user: { id: "u1", name: "Alice" }, tools: [] }),
);
assert.ok(
  out.includes(
    '<head><link rel="stylesheet" href="/_sandbox/archestra-app-base.css" data-archestra-app-base-css><script data-archestra-app-bootstrap>',
  ),
);
assert.ok(out.includes('"user":{"id":"u1","name":"Alice"}'));
assert.ok(out.includes('src="/_sandbox/archestra-app-sdk.js"'));

// Security: a display name containing </script> cannot break out of the inline
// script — the angle brackets are emitted as JS unicode escapes.
const escaped = appRuntime.prepareAppEnvelope(
  html,
  JSON.stringify({ user: { id: "u1", name: "</script>" }, tools: [] }),
);
assert.ok(escaped.includes("\\u003c/script\\u003e"));
assert.ok(!escaped.includes('"name":"</script>"'));

console.log("app-runtime-rs smoke ok");
