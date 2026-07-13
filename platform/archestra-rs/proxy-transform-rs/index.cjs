"use strict";

const { loadNativeBinding, wrapAsync } = require("@archestra/napi-loader");

const nativeBinding = loadNativeBinding({
  dir: __dirname,
  crateName: "proxy_transform_rs",
  packageName: "@archestra/proxy-transform-rs",
});

// explicit per-name assignment so Node's cjs-module-lexer exposes each as a
// named ESM export (consumers do `import { toonEncodeToolResults } from ...`)
module.exports.toonEncodeToolResults = wrapAsync(
  nativeBinding,
  "toonEncodeToolResults",
);
