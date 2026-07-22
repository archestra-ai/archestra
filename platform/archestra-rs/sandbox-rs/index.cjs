"use strict";

const {
  loadNativeBinding,
  wrapSync,
  wrapAsync,
} = require("@archestra/napi-loader");

const nativeBinding = loadNativeBinding({
  dir: __dirname,
  crateName: "sandbox_rs",
  packageName: "@archestra/sandbox-rs",
});

// explicit per-name assignments so Node's cjs-module-lexer can expose them
// as named ESM exports (consumers do `import { runSandbox } from ...`)
module.exports.checkSession = wrapAsync(nativeBinding, "checkSession");
module.exports.runSandbox = wrapAsync(nativeBinding, "runSandbox");
module.exports.readArtifact = wrapAsync(nativeBinding, "readArtifact");
module.exports.flushTelemetry = wrapSync(nativeBinding, "flushTelemetry");

if (typeof nativeBinding.__testPanic === "function") {
  module.exports.__testPanic = wrapSync(nativeBinding, "__testPanic");
}
