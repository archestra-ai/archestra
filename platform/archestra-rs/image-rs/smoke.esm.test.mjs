// The backend reaches this addon through an ESM dynamic `import()` and a named
// destructure (`const { shrinkImageToFit } = await import(...)`). The CJS smoke
// (`require`) does not exercise that interop path, so this mirrors it: the named
// export must be exposed to ESM (via cjs-module-lexer) and callable.
import assert from "node:assert/strict";

const { shrinkImageToFit } = await import("./index.cjs");

assert.equal(typeof shrinkImageToFit, "function");

// The async binding is reachable via ESM interop and resolves (null for garbage).
assert.equal(await shrinkImageToFit(Buffer.from("not an image"), 1000, 100), null);

console.log("image-rs esm smoke ok");
