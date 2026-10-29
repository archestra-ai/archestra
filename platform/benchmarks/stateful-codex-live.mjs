import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { runCodexBenchmark } from "./stateful-codex-session-ab.mjs";
import { parseOptions } from "./stateful-session-ab.mjs";

// Isolated development authentication only. The new short-lived task key stays
// in memory and is revoked after the runner has restored deployment state.
export async function withDevelopmentKey(options, work, env = process.env) {
  assert.ok(options["isolated-dev"], "isolated_dev_required");
  const base = new URL(options.base);
  assert.ok(
    base.protocol === "http:" &&
      ["127.0.0.1", "localhost", "[::1]"].includes(base.hostname) &&
      base.pathname === "/" &&
      !base.username &&
      !base.password &&
      !base.search &&
      !base.hash,
    "loopback_required",
  );
  const login = await fetch(new URL("/api/auth/dev-auto-login", base), {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(30000),
  });
  assert.ok(login.ok, "development_login_failed");
  const cookie = login.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  assert.ok(cookie, "development_cookie_missing");
  const headers = { cookie, "content-type": "application/json" };
  const response = await fetch(new URL("/api/api-keys", base), {
    method: "POST",
    headers,
    body: JSON.stringify({
      name: "T-1605 bounded Codex session",
      expiresIn: 86400,
    }),
    redirect: "error",
    signal: AbortSignal.timeout(30000),
  });
  assert.ok(response.ok, "task_key_creation_failed");
  const key = await response.json();
  assert.ok(
    typeof key.key === "string" &&
      typeof key.id === "string" &&
      /^[a-zA-Z0-9_-]+$/.test(key.id),
    "task_key_invalid",
  );
  const scoped = { ...env, ARCHESTRA_BENCHMARK_API_AUTH: key.key };
  let passthroughId;
  try {
    const created = await fetch(new URL("/api/llm-virtual-keys", base), {
      method: "POST",
      headers: { authorization: key.key, "content-type": "application/json" },
      body: JSON.stringify({
        name: "T-1605 bounded Codex passthrough",
        keyType: "passthrough",
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
      }),
      redirect: "error",
      signal: AbortSignal.timeout(30000),
    });
    assert.ok(created.ok, "task_passthrough_creation_failed");
    const passthrough = await created.json();
    assert.ok(
      typeof passthrough.id === "string" &&
        /^[a-zA-Z0-9_-]+$/.test(passthrough.id),
      "task_passthrough_invalid",
    );
    passthroughId = passthrough.id;
    assert.ok(
      typeof passthrough.value === "string" && passthrough.value,
      "task_passthrough_invalid",
    );
    scoped.ARCHESTRA_BENCHMARK_PASSTHROUGH_KEY = passthrough.value;
    return await work(options, scoped);
  } finally {
    delete scoped.ARCHESTRA_BENCHMARK_API_AUTH;
    delete scoped.ARCHESTRA_BENCHMARK_PASSTHROUGH_KEY;
    const cleanupLogin = await fetch(
      new URL("/api/auth/dev-auto-login", base),
      { method: "POST", redirect: "error", signal: AbortSignal.timeout(30000) },
    );
    assert.ok(cleanupLogin.ok, "task_key_revocation_failed");
    let cleanupCookie = cleanupLogin.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    assert.ok(cleanupCookie, "task_key_revocation_failed");
    let passthroughRevoked = true;
    if (passthroughId) {
      const response = await fetch(
        new URL(`/api/llm-virtual-keys/${passthroughId}`, base),
        {
          method: "DELETE",
          headers: { cookie: cleanupCookie },
          redirect: "error",
          signal: AbortSignal.timeout(30000),
        },
      );
      passthroughRevoked = response.ok;
      const finalLogin = await fetch(
        new URL("/api/auth/dev-auto-login", base),
        {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(30000),
        },
      );
      assert.ok(finalLogin.ok, "task_key_revocation_failed");
      cleanupCookie = finalLogin.headers
        .getSetCookie()
        .map((value) => value.split(";")[0])
        .join("; ");
      assert.ok(cleanupCookie, "task_key_revocation_failed");
    }
    const revoked = await fetch(new URL(`/api/api-keys/${key.id}`, base), {
      method: "DELETE",
      headers: { cookie: cleanupCookie },
      redirect: "error",
      signal: AbortSignal.timeout(30000),
    });
    assert.ok(revoked.ok, "task_key_revocation_failed");
    assert.ok(passthroughRevoked, "task_passthrough_revocation_failed");
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const result = await withDevelopmentKey(
      parseOptions(process.argv.slice(2)),
      runCodexBenchmark,
    );
    console.info(
      JSON.stringify({
        ...result,
        metrics: result.metrics
          ? { ...result.metrics, timeline: undefined }
          : null,
        taskKeyRevoked: true,
      }),
    );
    if (!result.completed || !result.restored) process.exitCode = 1;
  } catch (error) {
    const allowed = [
      "development_login_failed",
      "development_cookie_missing",
      "task_key_creation_failed",
      "task_key_invalid",
      "task_key_revocation_failed",
    ];
    console.error(
      JSON.stringify({
        completed: false,
        failure: allowed.includes(error.message)
          ? error.message
          : "codex_development_boundary_failed",
      }),
    );
    process.exitCode = 1;
  }
}
