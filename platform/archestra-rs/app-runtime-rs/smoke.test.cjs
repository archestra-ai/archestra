"use strict";

const assert = require("node:assert/strict");
const appRuntime = require("./index.cjs");

const html = "<!DOCTYPE html><html><head></head><body></body></html>";

// Happy path: the three references land at the start of <head>, in order, and
// the per-viewer context is embedded.
const out = appRuntime.prepareAppEnvelope(
  html,
  JSON.stringify({ user: { id: "u1", name: "Alice" }, tools: [] }),
  "",
  "",
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
  "",
  "",
);
assert.ok(escaped.includes("\\u003c/script\\u003e"));
assert.ok(!escaped.includes('"name":"</script>"'));

// scanAppHtml: a platform-script self-load is rejected with a structured reason;
// a clean document passes with no rejection.
const rejected = appRuntime.scanAppHtml(
  '<html><head><script src="/_sandbox/archestra-app-sdk.js"></script></head></html>',
);
assert.equal(rejected.rejection.kind, "platform_script_src");
assert.equal(
  appRuntime.scanAppHtml("<html><head></head><body></body></html>").rejection,
  undefined,
);

// Diagnostics: angle brackets escaped, forged type sanitized, lines formatted,
// dedup by type+prefix. Caps are passed in by the caller.
assert.equal(appRuntime.escapeAngleBrackets("</x>"), "&lt;/x&gt;");
assert.equal(
  appRuntime.capDiagnosticEntries([{ type: "BAD!", message: "hi" }], 20, 500)[0]
    .type,
  "unknown",
);
assert.equal(
  appRuntime.formatDiagnosticEntryLines(
    [{ type: "error", message: "<b>" }],
    20,
    500,
  ),
  "- [error] &lt;b&gt;",
);
assert.equal(
  appRuntime.mergeDiagnosticEntries(
    [{ type: "error", message: "a" }],
    [
      { type: "error", message: "a" },
      { type: "warn", message: "b" },
    ],
    20,
    120,
  ).length,
  2,
);

console.log("app-runtime-rs smoke ok");
