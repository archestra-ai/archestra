// The backend reaches this addon through an ESM dynamic `import()` and a named
// destructure (`const { plan, decide } = await import(...)`). The CJS smoke
// (`require`) does not exercise that interop path, so this mirrors it: the named
// exports must be exposed to ESM (via cjs-module-lexer) and callable.
import assert from "node:assert/strict";

const { plan, decide, assess, coreVersion, planFormatVersion } = await import("./index.cjs");

assert.equal(typeof plan, "function");
assert.equal(typeof decide, "function");
assert.equal(typeof assess, "function");
assert.match(coreVersion(), /^\d+\.\d+\.\d+/);
assert.ok(Number.isInteger(planFormatVersion()));

// Both bindings are reachable via ESM interop and surface the coded error body.
await assert.rejects(plan("{}"), { code: "ARCHESTRA_ROUTER_INVALID_INPUT" });
assert.throws(() => decide("{}", "{}", "{}", 0.5), { code: "ARCHESTRA_ROUTER_INVALID_PLAN" });

console.log("router-rs esm smoke ok");
