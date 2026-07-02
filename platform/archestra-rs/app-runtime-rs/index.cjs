"use strict";

const { loadNativeBinding, wrapSync } = require("@archestra/napi-loader");

const nativeBinding = loadNativeBinding({
  dir: __dirname,
  crateName: "app_runtime_rs",
  packageName: "@archestra/app-runtime-rs",
});

// explicit per-name assignment so Node's cjs-module-lexer exposes each as a
// named ESM export (consumers do `import { prepareAppEnvelope } from ...`)
module.exports.prepareAppEnvelope = wrapSync(nativeBinding, "prepareAppEnvelope");
module.exports.scanAppHtml = wrapSync(nativeBinding, "scanAppHtml");
module.exports.escapeAngleBrackets = wrapSync(nativeBinding, "escapeAngleBrackets");
module.exports.capDiagnosticEntries = wrapSync(nativeBinding, "capDiagnosticEntries");
module.exports.mergeDiagnosticEntries = wrapSync(nativeBinding, "mergeDiagnosticEntries");
module.exports.formatDiagnosticEntryLines = wrapSync(
  nativeBinding,
  "formatDiagnosticEntryLines",
);
