"use strict";

// Shared scaffolding for the hand-maintained `index.cjs` loaders of the NAPI
// cdylib crates (app-runtime-rs, sandbox-rs, image-rs). Each crate's loader is
// identical apart from its crate/package name and which functions it exports
// (sync vs async), so that boilerplate lives here — one place to fix the
// platform-triple resolution and the panic→Error normalization.

const { existsSync } = require("node:fs");
const path = require("node:path");

const TRIPLES = {
  "darwin:arm64": "darwin-arm64",
  "darwin:x64": "darwin-x64",
  "linux:arm64": isMusl() ? "linux-arm64-musl" : "linux-arm64-gnu",
  "linux:x64": isMusl() ? "linux-x64-musl" : "linux-x64-gnu",
};

/**
 * Load a crate's compiled `.node` addon from `dir` (the crate's own package
 * directory — pass `__dirname`). `crateName` is the Rust crate name used in the
 * built filenames (e.g. `image_rs`); `packageName` is only used for the error.
 */
function loadNativeBinding({ dir, crateName, packageName }) {
  const triple = TRIPLES[`${process.platform}:${process.arch}`];
  const candidates = [
    triple && `${crateName}.${triple}.node`,
    triple && `index.${triple}.node`,
    `${crateName}.node`,
    "index.node",
  ].filter(Boolean);

  const errors = [];
  for (const candidate of candidates) {
    const bindingPath = path.join(dir, candidate);
    if (!existsSync(bindingPath)) continue;
    try {
      return require(bindingPath);
    } catch (error) {
      errors.push(error);
    }
  }

  const details = errors.map((error) => error && error.message).join("\n");
  throw new Error(
    `Unable to load ${packageName} for ${process.platform}/${process.arch}.${details ? `\n${details}` : ""}`,
  );
}

/** Wrap a synchronous native function so its panic payload becomes a clean Error. */
function wrapSync(binding, name) {
  return (...args) => {
    try {
      return binding[name](...args);
    } catch (error) {
      throw normalizeNativeError(error);
    }
  };
}

/** Wrap an async native function so its rejected panic payload becomes a clean Error. */
function wrapAsync(binding, name) {
  return async (...args) => {
    try {
      return await binding[name](...args);
    } catch (error) {
      throw normalizeNativeError(error);
    }
  };
}

module.exports = { loadNativeBinding, wrapSync, wrapAsync };

function isMusl() {
  if (process.platform !== "linux") return false;
  const report = process.report && process.report.getReport();
  return !report?.header?.glibcVersionRuntime;
}

// The adapter crates serialize a `{ code, message }` JSON body into the JS Error
// message on a Rust panic; recover it into a first-class Error with `.code` and
// the original as `.cause`. Non-JSON messages pass through untouched.
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
