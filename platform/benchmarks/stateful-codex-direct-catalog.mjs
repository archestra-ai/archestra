import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  link,
  lstat,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export async function prepareStatefulCodexDirectCatalog({
  env = process.env,
  model = env.ARCHESTRA_BENCHMARK_CODEX_MODEL ?? "gpt-6.1-sol",
  runHelper = runCanonicalHelper,
  timeoutMs = 45000,
} = {}) {
  if (
    typeof model !== "string" ||
    /^[A-Za-z0-9._:/-]{1,128}$/.exec(model)?.[0] !== model ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > 120000
  )
    throw failure("codex_direct_catalog_options_invalid");
  const home = env.CODEX_HOME || join(env.HOME || homedir(), ".codex");
  const auth = join(home, "auth.json");
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  const timer = setTimeout(interrupt, timeoutMs);
  for (const signal of SIGNALS) process.on(signal, interrupt);
  let directory;
  let originalAuth;
  let prepared;
  let stage = "credentials";
  let diagnostics = {};
  let pendingError;
  const unchangedAuth = async () => {
    const current = await lstat(auth, { bigint: true });
    return (
      current.isFile() &&
      current.dev === originalAuth.dev &&
      current.ino === originalAuth.ino
    );
  };
  try {
    // Never read credential bytes or the real user's config. Both temporary
    // generations are beneath native home so every auth link stays on one FS.
    let candidate;
    try {
      candidate = await lstat(auth, { bigint: true });
    } catch {
      throw failure("codex_direct_catalog_auth_unavailable");
    }
    if (!candidate.isFile() || candidate.isSymbolicLink())
      throw failure("codex_direct_catalog_auth_unavailable");
    originalAuth = candidate;
    directory = await mkdtemp(join(home, ".archestra-stateful-direct-"));
    await link(auth, join(directory, "auth.json"));
    const linked = await stat(join(directory, "auth.json"), { bigint: true });
    if (
      linked.dev !== originalAuth.dev ||
      linked.ino !== originalAuth.ino ||
      !(await unchangedAuth())
    )
      throw failure("codex_direct_catalog_auth_changed");
    await writeFile(
      join(directory, "config.toml"),
      'cli_auth_credentials_store = "file"\n',
      { mode: 0o600 },
    );
    stage = "canonical_source";
    const source = await readFile(CANONICAL_SOURCE, "utf8");
    // This payload is a JS-compatible single string export, despite its .ts
    // suffix. Load the exact export without a TS loader or copying its algorithm.
    const match =
      /^\/\*\*[\s\S]*?\*\/\s*export const CODEX_HANDOFF_HELPER = String\.raw`([\s\S]*)`;\s*$/.exec(
        source,
      );
    if (
      Buffer.byteLength(source) > MAX_BYTES ||
      !match ||
      /`|\$\{/.test(match[1])
    )
      throw failure("codex_direct_catalog_source_unsupported");
    const { CODEX_HANDOFF_HELPER } = await import(
      `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
    );
    if (typeof CODEX_HANDOFF_HELPER !== "string")
      throw failure("codex_direct_catalog_source_unsupported");
    const helper = join(directory, "canonical-handoff.cjs");
    await writeFile(helper, CODEX_HANDOFF_HELPER, { mode: 0o600 });
    const childEnv = Object.fromEntries(
      Object.entries(env).filter(
        ([name, value]) =>
          value !== undefined &&
          /^(HOME|PATH|SHELL|USER|LOGNAME|TMPDIR|TMP|TEMP|LANG|LC_.*|TERM|TZ|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|SSL_CERT_DIR|HTTPS?_PROXY|ALL_PROXY|NO_PROXY|XDG_.*|SystemRoot|WINDIR|COMSPEC|PATHEXT|APPDATA|LOCALAPPDATA|USERPROFILE|HOMEDRIVE|HOMEPATH)$/i.test(
            name,
          ),
      ),
    );
    childEnv.CODEX_HOME = directory;
    // No gateway credentials, refresh-token values or inherited nested-shell
    // markers enter discovery. The helper must fetch, never reuse an old catalog.
    stage = "canonical_helper";
    controller.signal.throwIfAborted();
    const result = await runHelper(
      {
        command: process.execPath,
        args: [
          helper,
          "--direct",
          env.ARCHESTRA_BENCHMARK_CODEX_BINARY ?? "codex",
          "--model",
          model,
        ],
        cwd: directory,
        env: childEnv,
      },
      { signal: controller.signal, timeoutMs },
    );
    diagnostics = safeHelperDiagnostics(result);
    if (controller.signal.aborted)
      throw failure("codex_direct_catalog_aborted");
    if (!(await unchangedAuth()))
      throw failure("codex_direct_catalog_auth_changed");
    if (result?.exitCode !== 0) {
      if (diagnostics.freshCatalogMissing)
        throw failure("codex_direct_catalog_not_fresh");
      if (diagnostics.authChanged)
        throw failure("codex_direct_catalog_auth_changed");
      if (diagnostics.modelMissing)
        throw failure("codex_direct_catalog_model_unavailable");
      throw failure("codex_direct_catalog_helper_failed");
    }
    stage = "catalog_validation";
    const filename = join(directory, "archestra-direct-model-catalog.json");
    const info = await lstat(filename);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.size > MAX_BYTES ||
      (info.mode & 0o777) !== 0o600
    )
      throw failure("codex_direct_catalog_invalid");
    const bytes = await readFile(filename);
    const catalog = JSON.parse(bytes);
    if (
      !Array.isArray(catalog.models) ||
      !catalog.models.length ||
      catalog.models.some(
        (entry) =>
          typeof entry.slug !== "string" ||
          /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.exec(entry.slug)?.[0] !==
            entry.slug ||
          entry.tool_mode !== "direct" ||
          entry.supports_search_tool !== false,
      )
    )
      throw failure("codex_direct_catalog_invalid");
    prepared = {
      filename,
      evidence: {
        mode: "canonical-connection-direct-catalog",
        source:
          "backend/src/services/agent-connection-setup/payloads/codex-handoff.ts:prepareDirectCatalog",
        canonicalSourceHash: digest(source),
        helperHash: digest(CODEX_HANDOFF_HELPER),
        catalogHash: digest(bytes),
        requestedModel: model,
        freshCatalogValidatedByCanonicalHelper: true,
        authSharedByHardlink: true,
        models: catalog.models.map((entry) => ({
          slug: entry.slug,
          toolMode: entry.tool_mode,
          supportsSearchTool: entry.supports_search_tool,
        })),
      },
      close: async () => {
        try {
          await rm(directory, { recursive: true, force: true });
        } catch {
          throw failure("codex_direct_catalog_cleanup_failed");
        }
      },
    };
  } catch (error) {
    pendingError = failure(
      ERROR_CODES.has(error?.code)
        ? error.code
        : controller.signal.aborted
          ? "codex_direct_catalog_aborted"
          : "codex_direct_catalog_prepare_failed",
    );
  } finally {
    clearTimeout(timer);
    controller.abort();
    if (originalAuth) {
      try {
        if (!(await unchangedAuth()))
          pendingError = failure("codex_direct_catalog_auth_changed");
      } catch {
        pendingError = failure("codex_direct_catalog_auth_changed");
      }
    }
    if (pendingError && directory) {
      try {
        await rm(directory, { recursive: true, force: true });
      } catch {
        pendingError = failure("codex_direct_catalog_cleanup_failed");
      }
    }
    for (const signal of SIGNALS) process.off(signal, interrupt);
  }
  if (pendingError) {
    pendingError.diagnostics = { stage, ...diagnostics };
    throw pendingError;
  }
  return prepared;
}

async function runCanonicalHelper(launch, { signal, timeoutMs }) {
  signal.throwIfAborted();
  const group = process.platform !== "win32";
  const child = spawn(launch.command, launch.args, {
    cwd: launch.cwd,
    env: launch.env,
    detached: group,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let killTimer;
  let stopping = false;
  const kill = (name) => {
    try {
      if (group && child.pid) process.kill(-child.pid, name);
      else child.kill(name);
    } catch {
      /* The owned process group may already have exited. */
    }
  };
  const stop = () => {
    stopping = true;
    kill("SIGTERM");
    killTimer ??= setTimeout(() => kill("SIGKILL"), 5000);
    killTimer.unref();
  };
  const timer = setTimeout(stop, timeoutMs);
  signal.addEventListener("abort", stop, { once: true });
  const parts = [];
  const stderrHash = createHash("sha256");
  let stderrBytes = 0;
  let sampleBytes = 0;
  child.stderr.on("data", (part) => {
    stderrHash.update(part);
    stderrBytes += part.length;
    const count = Math.min(part.length, 16384 - sampleBytes);
    if (count > 0) {
      parts.push(Buffer.from(part.subarray(0, count)));
      sampleBytes += count;
    }
  });
  try {
    const exitCode = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    const sample = Buffer.concat(parts, sampleBytes);
    const result = {
      exitCode,
      ...helperStderr(sample.toString("utf8")),
      stderrHash: stderrHash.digest("hex"),
      stderrBytes,
    };
    sample.fill(0);
    return result;
  } finally {
    if (stopping) kill("SIGKILL");
    clearTimeout(timer);
    clearTimeout(killTimer);
    signal.removeEventListener("abort", stop);
    for (const part of parts) part.fill(0);
  }
}

function helperStderr(text) {
  return {
    freshCatalogMissing: /did not fetch a fresh model catalog/.test(text),
    authChanged: /credentials changed during catalog refresh/.test(text),
    modelMissing: /Selected model is missing/.test(text),
  };
}
function safeHelperDiagnostics(value) {
  return {
    exitCode: Number.isInteger(value?.exitCode) ? value.exitCode : null,
    ...(typeof value?.stderr === "string"
      ? {
          ...helperStderr(value.stderr.slice(0, 16384)),
          stderrHash: digest(value.stderr),
          stderrBytes: Buffer.byteLength(value.stderr),
        }
      : {
          freshCatalogMissing: value?.freshCatalogMissing === true,
          authChanged: value?.authChanged === true,
          modelMissing: value?.modelMissing === true,
          stderrHash:
            typeof value?.stderrHash === "string" &&
            /^[a-f0-9]{64}$/.exec(value.stderrHash)?.[0] === value.stderrHash
              ? value.stderrHash
              : null,
          stderrBytes: Number.isFinite(value?.stderrBytes)
            ? value.stderrBytes
            : null,
        }),
  };
}
function failure(code) {
  return Object.assign(new Error(code), { code });
}
function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}
const CANONICAL_SOURCE = new URL(
  "../backend/src/services/agent-connection-setup/payloads/codex-handoff.ts",
  import.meta.url,
);
const MAX_BYTES = 10 * 1024 * 1024;
const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];
const ERROR_CODES = new Set([
  "codex_direct_catalog_options_invalid",
  "codex_direct_catalog_auth_unavailable",
  "codex_direct_catalog_auth_changed",
  "codex_direct_catalog_source_unsupported",
  "codex_direct_catalog_aborted",
  "codex_direct_catalog_not_fresh",
  "codex_direct_catalog_model_unavailable",
  "codex_direct_catalog_helper_failed",
  "codex_direct_catalog_invalid",
  "codex_direct_catalog_cleanup_failed",
]);
