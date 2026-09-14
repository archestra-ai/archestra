"use strict";
const { loadNativeBinding, wrapAsync } = require("@archestra/napi-loader");
const binding = loadNativeBinding({ dir: __dirname, crateName: "openappa_rs", packageName: "@archestra/openappa-rs" });
module.exports.initializeOpenappa = wrapAsync(binding, "initializeOpenappa");
module.exports.dispatchHook = wrapAsync(binding, "dispatchHook");
