"use strict";

const { loadNativeBinding, wrapAsync, wrapSync } = require("@archestra/napi-loader");

const nativeBinding = loadNativeBinding({
  dir: __dirname,
  crateName: "router_rs",
  packageName: "@archestra/router-rs",
});

// explicit per-name assignment so Node's cjs-module-lexer exposes each as a
// named ESM export (consumers do `import { plan, decide } from ...`)
module.exports.plan = wrapAsync(nativeBinding, "plan");
module.exports.decide = wrapSync(nativeBinding, "decide");
module.exports.assess = wrapSync(nativeBinding, "assess");
module.exports.coreVersion = wrapSync(nativeBinding, "coreVersion");
module.exports.planFormatVersion = wrapSync(nativeBinding, "planFormatVersion");
