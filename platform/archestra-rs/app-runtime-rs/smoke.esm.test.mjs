// The backend reaches this addon through an ESM dynamic `import()` and a named
// destructure (`const { prepareAppEnvelope } = await import(...)`). The CJS
// smoke (`require`) does not exercise that interop path, so this mirrors it:
// the named export must be exposed to ESM (via cjs-module-lexer) and callable.
import assert from "node:assert/strict";

const { prepareAppEnvelope, scanAppHtml, escapeAngleBrackets } = await import(
  "./index.cjs"
);

assert.equal(typeof prepareAppEnvelope, "function");
assert.equal(typeof scanAppHtml, "function");
assert.equal(typeof escapeAngleBrackets, "function");

const out = prepareAppEnvelope(
  "<html><head></head><body></body></html>",
  JSON.stringify({ user: { id: "u1", name: "Alice" }, tools: [] }),
  "",
  "",
);
assert.ok(out.includes('"user":{"id":"u1","name":"Alice"}'));
assert.ok(out.includes('src="/_sandbox/archestra-app-sdk.js"'));
assert.equal(escapeAngleBrackets("</x>"), "&lt;/x&gt;");

console.log("app-runtime-rs esm smoke ok");
