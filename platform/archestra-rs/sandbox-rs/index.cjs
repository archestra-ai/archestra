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
  triple && `sandbox_rs.${triple}.node`,
  triple && `index.${triple}.node`,
  "sandbox_rs.node",
  "index.node",
].filter(Boolean);

const nativeBinding = loadBinding();

// explicit per-name assignments so Node's cjs-module-lexer can expose them
// as named ESM exports (consumers do `import { runSandbox } from ...`)
module.exports.checkSession = wrapNative("checkSession");
module.exports.runSandbox = wrapNative("runSandbox");
module.exports.readArtifact = wrapNative("readArtifact");
module.exports.flushTelemetry = wrapNativeSync("flushTelemetry");

if (typeof nativeBinding.__testPanic === "function") {
  module.exports.__testPanic = wrapNativeSync("__testPanic");
}

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
    `Unable to load @archestra/sandbox-rs for ${process.platform}/${process.arch}.${details ? `\n${details}` : ""}`,
  );
}

function isMusl() {
  if (process.platform !== "linux") return false;
  const report = process.report && process.report.getReport();
  return !report?.header?.glibcVersionRuntime;
}

function wrapNative(name) {
  return async (...args) => {
    try {
      return await nativeBinding[name](...args);
    } catch (error) {
      throw normalizeNativeError(error);
    }
  };
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
