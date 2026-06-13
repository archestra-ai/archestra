"use strict";

const { existsSync } = require("node:fs");
const path = require("node:path");

const triples = {
  "darwin:arm64": "darwin-arm64",
  "darwin:x64": "darwin-x64",
  "linux:arm64": isMusl() ? "linux-arm64-musl" : "linux-arm64-gnu",
  "linux:x64": isMusl() ? "linux-x64-musl" : "linux-x64-gnu",
};

const triple = triples[`${process.platform}:${process.arch}`];
const candidates = [
  triple && `app_runtime_rs.${triple}.node`,
  triple && `index.${triple}.node`,
  "app_runtime_rs.node",
  "index.node",
].filter(Boolean);

const nativeBinding = loadBinding();

// explicit per-name assignment so Node's cjs-module-lexer exposes each as a
// named ESM export (consumers do `import { prepareAppEnvelope } from ...`)
module.exports.prepareAppEnvelope = wrapNativeSync("prepareAppEnvelope");
module.exports.scanAppHtml = wrapNativeSync("scanAppHtml");
module.exports.escapeAngleBrackets = wrapNativeSync("escapeAngleBrackets");
module.exports.capDiagnosticEntries = wrapNativeSync("capDiagnosticEntries");
module.exports.mergeDiagnosticEntries = wrapNativeSync("mergeDiagnosticEntries");
module.exports.formatDiagnosticEntryLines = wrapNativeSync("formatDiagnosticEntryLines");

function loadBinding() {
  const errors = [];
  for (const candidate of candidates) {
    const bindingPath = path.join(__dirname, candidate);
    if (!existsSync(bindingPath)) continue;
    try {
      return require(bindingPath);
    } catch (error) {
      errors.push(error);
    }
  }

  const details = errors.map((error) => error && error.message).join("\n");
  throw new Error(
    `Unable to load @archestra/app-runtime-rs for ${process.platform}/${process.arch}.${details ? `\n${details}` : ""}`,
  );
}

function isMusl() {
  if (process.platform !== "linux") return false;
  const report = process.report && process.report.getReport();
  return !report?.header?.glibcVersionRuntime;
}

function wrapNativeSync(name) {
  return (...args) => {
    try {
      return nativeBinding[name](...args);
    } catch (error) {
      throw normalizeNativeError(error);
    }
  };
}

function normalizeNativeError(error) {
  if (!(error instanceof Error)) return error;

  let payload;
  try {
    payload = JSON.parse(error.message);
  } catch {
    return error;
  }

  if (
    !payload ||
    typeof payload.code !== "string" ||
    typeof payload.message !== "string"
  ) {
    return error;
  }

  const normalized = new Error(payload.message);
  normalized.code = payload.code;
  normalized.cause = error;
  return normalized;
}
