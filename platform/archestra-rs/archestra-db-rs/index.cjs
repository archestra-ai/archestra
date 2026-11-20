"use strict";

const { loadNativeBinding, wrapAsync } = require("@archestra/napi-loader");

const binding = loadNativeBinding({
  dir: __dirname,
  crateName: "archestra_db_rs",
  packageName: "@archestra/archestra-db-rs",
});

module.exports.listAuditRows = wrapAsync(binding, "listAuditRows");
