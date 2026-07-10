// The backend reaches this addon through an ESM dynamic `import()` and a named
// destructure (`const { toonEncodeToolResults } = await import(...)`). The CJS
// smoke (`require`) does not exercise that interop path, so this mirrors it:
// the named export must be exposed to ESM (via cjs-module-lexer) and callable.
import assert from "node:assert/strict";

const { toonEncodeToolResults } = await import("./index.cjs");

assert.equal(typeof toonEncodeToolResults, "function");

// The async binding is reachable via ESM interop and resolves positionally
// (null encoding and counts for non-JSON content).
const results = await toonEncodeToolResults(
  [{ id: "esm", rawContent: "not json", unwrap: true }],
  "Normalized",
);
assert.deepEqual(results, [
  { normalized: "not json", encoded: null, beforeTokens: null, encodedTokens: null },
]);

console.log("proxy-transform-rs esm smoke ok");
