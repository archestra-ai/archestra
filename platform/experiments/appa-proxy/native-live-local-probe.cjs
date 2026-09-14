#!/usr/bin/env node
"use strict";

const { isIP } = require("node:net");

const MAX_TIMEOUT_MS = 3_000;
const MAX_RESULT_BYTES = 1_024;
const RUN_ID = /^run-[a-z0-9][a-z0-9-]{7,95}$/;
const REQUEST_KEY = /^synthetic-[a-zA-Z0-9_-]{1,100}$/;
const EFFECT = "SYNTHETIC_LOCAL_PUBLIC_EFFECT";
const PROBE = "fixed-node-local-probe/v1";

void main();

async function main() {
  try {
    parseArguments(process.argv.slice(2));
    const runId = requiredEnvironment("APPA_NATIVE_LOCAL_PROBE_RUN_ID");
    const requestKey = requiredEnvironment("APPA_NATIVE_LOCAL_PROBE_REQUEST_KEY");
    if (!RUN_ID.test(runId) || !REQUEST_KEY.test(requestKey)) {
      throw new Error("invalid run scope");
    }
    const observerUrl = parseObserverUrl(requiredEnvironment("APPA_NATIVE_LOCAL_PROBE_OBSERVER_URL"));
    const capability = requiredEnvironment("APPA_NATIVE_LOCAL_CALLBACK_CAPABILITY");
    if (!/^[a-f0-9]{64}$/.test(capability)) throw new Error("invalid local callback capability");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), MAX_TIMEOUT_MS);
    try {
      const response = await fetch(observerUrl, {
        method: "POST",
        headers: {
          authorization: `Bearer ${capability}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          run_id: runId,
          request_key: requestKey,
          effect: EFFECT,
          probe: PROBE,
        }),
        signal: controller.signal,
        redirect: "error",
      });
      const reader = response.body?.getReader();
      if (reader) {
        let received = 0;
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            received += value.byteLength;
            if (received > MAX_RESULT_BYTES) {
              await reader.cancel();
              throw new Error("observer result exceeds bound");
            }
          }
        } finally {
          reader.releaseLock();
        }
      }
      if (response.status !== 201) {
        throw new Error(`observer rejected local callback (${response.status})`);
      }
      process.stdout.write(`${JSON.stringify({ status: "effect_submitted", run_id: runId, request_key: requestKey })}\n`);
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ status: "reply_unknown_or_submission_failed", error: boundedError(error) })}\n`);
    process.exitCode = 1;
  }
}

function parseArguments(args) {
  if (args.length !== 0) {
    throw new Error("usage: native-live-local-probe.cjs");
  }
}

function parseObserverUrl(value) {
  const url = new URL(value);
  if (
    url.protocol !== "http:"
    || url.pathname !== "/observer/local-effect"
    || url.search
    || url.hash
    || url.username
    || url.password
    || !isPrivateFixtureHost(url.hostname)
  ) {
    throw new Error("observer URL must be a loopback or private fixture callback URL");
  }
  return url;
}

function isPrivateFixtureHost(hostname) {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host === "::1") return true;
  const family = isIP(host);
  if (family === 4) {
    const [first, second] = host.split(".").map(Number);
    return first === 127 || first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168);
  }
  return family === 6 && /^(fc|fd)/i.test(host);
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value || value.length > 256) throw new Error(`required environment variable is absent: ${name}`);
  return value;
}

function boundedError(error) {
  return String(error?.message || "local callback failed").replace(/[^a-zA-Z0-9 .()_-]/g, "_").slice(0, 160);
}
