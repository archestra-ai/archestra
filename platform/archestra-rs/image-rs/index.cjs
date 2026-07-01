"use strict";

const { loadNativeBinding, wrapAsync } = require("@archestra/napi-loader");

const nativeBinding = loadNativeBinding({
  dir: __dirname,
  crateName: "image_rs",
  packageName: "@archestra/image-rs",
});

// explicit per-name assignment so Node's cjs-module-lexer exposes each as a
// named ESM export (consumers do `import { shrinkImageToFit } from ...`)
module.exports.shrinkImageToFit = wrapAsync(nativeBinding, "shrinkImageToFit");
