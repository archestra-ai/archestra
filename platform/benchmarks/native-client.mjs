import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { withDeployment } from "./live-ab.mjs";

export function buildClientLaunch({
  client,
  base,
  agent,
  session,
  passthroughKey,
  gatewayToken,
  mcpConfig,
  args,
  env,
}) {
  assert.ok(["claude", "codex"].includes(client), "Unsupported native client.");
  assert.ok(
    typeof agent === "string" && /^[a-z0-9-]+$/i.exec(agent)?.[0] === agent,
    "Invalid native client agent ID.",
  );
  assert.ok(
    typeof session === "string" &&
      /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/.exec(session)?.[0] === session,
    "Invalid native client session ID.",
  );
  assert.ok(
    passthroughKey && gatewayToken,
    "Native passthrough credentials are missing.",
  );
  const childEnv = {
    ...Object.fromEntries(
      Object.entries(env).filter(
        ([key]) =>
          [
            "HOME",
            "PATH",
            "USER",
            "LOGNAME",
            "SHELL",
            "LANG",
            "TERM",
            "COLORTERM",
            "NO_COLOR",
            "TMPDIR",
            "SSH_AUTH_SOCK",
            "DISPLAY",
            "WAYLAND_DISPLAY",
            "BROWSER",
            "DBUS_SESSION_BUS_ADDRESS",
            "SSL_CERT_FILE",
            "SSL_CERT_DIR",
            "NODE_EXTRA_CA_CERTS",
            "HTTP_PROXY",
            "HTTPS_PROXY",
            "ALL_PROXY",
            "NO_PROXY",
            "CODEX_HOME",
            "CLAUDE_CONFIG_DIR",
            "CLAUDE_CODE_OAUTH_TOKEN",
          ].includes(key) ||
          key.startsWith("LC_") ||
          key.startsWith("XDG_"),
      ),
    ),
    ARCHESTRA_BENCHMARK_PASSTHROUGH_KEY: passthroughKey,
    ARCHESTRA_BENCHMARK_GATEWAY_TOKEN: gatewayToken,
    ARCHESTRA_BENCHMARK_SESSION_ID: session,
  };
  // Only OS/native-login settings and the two scoped transport credentials
  // reach the client. Platform database, signing and administrative secrets do not.
  if (client === "claude") {
    assert.ok(mcpConfig);
    childEnv.ANTHROPIC_BASE_URL = `${base}/v1/anthropic/${agent}`;
    childEnv.ANTHROPIC_CUSTOM_HEADERS = `X-Archestra-Virtual-Key: ${passthroughKey}\nX-Appa-Session-ID: ${session}\nX-Archestra-Session-Id: ${session}`;
    childEnv.ENABLE_TOOL_SEARCH = "false";
    return {
      command:
        env.ARCHESTRA_BENCHMARK_CLAUDE_BINARY ??
        join(env.HOME, ".local/bin/claude"),
      args: ["--mcp-config", mcpConfig, "--strict-mcp-config", ...args],
      env: childEnv,
    };
  }
  const toml = (value) => JSON.stringify(value);
  const settings = {
    model_provider: "appa_benchmark",
    "model_providers.appa_benchmark.name": "T-1605 subscription benchmark",
    "model_providers.appa_benchmark.base_url": `${base}/v1/openai/${agent}`,
    "model_providers.appa_benchmark.wire_api": "responses",
    "model_providers.appa_benchmark.requires_openai_auth": true,
    "model_providers.appa_benchmark.supports_websockets": false,
    "model_providers.appa_benchmark.env_http_headers": {
      "X-Archestra-Virtual-Key": "ARCHESTRA_BENCHMARK_PASSTHROUGH_KEY",
      "X-Appa-Session-ID": "ARCHESTRA_BENCHMARK_SESSION_ID",
      "X-Archestra-Session-Id": "ARCHESTRA_BENCHMARK_SESSION_ID",
    },
    "mcp_servers.appa_benchmark.url": `${base}/v1/mcp/${agent}`,
    "mcp_servers.appa_benchmark.bearer_token_env_var":
      "ARCHESTRA_BENCHMARK_GATEWAY_TOKEN",
    "mcp_servers.appa_benchmark.http_headers": {
      "X-Appa-Session-ID": session,
      "X-Archestra-Session-Id": session,
    },
  };
  const encode = (value) =>
    value && typeof value === "object"
      ? `{${Object.entries(value)
          .map(([key, item]) => `${toml(key)}=${toml(item)}`)
          .join(",")}}`
      : toml(value);
  return {
    command:
      env.ARCHESTRA_BENCHMARK_CODEX_BINARY ??
      join(env.HOME, ".local/bin/codex"),
    args: [
      ...Object.entries(settings).flatMap(([key, value]) => [
        "-c",
        `${key}=${encode(value)}`,
      ]),
      ...args,
    ],
    env: childEnv,
  };
}

async function main(argv) {
  const separator = argv.indexOf("--");
  assert.ok(
    separator >= 0,
    "Usage: native-client.mjs --isolated-dev --client claude|codex [--arm off|on] -- <native client arguments>",
  );
  const flags = argv
    .slice(0, separator)
    .filter((value) => value !== "--isolated-dev");
  const options = {};
  assert.equal(flags.length % 2, 0, "Native launcher flags need values.");
  for (let index = 0; index < flags.length; index += 2) {
    assert.ok(
      ["--client", "--arm", "--session"].includes(flags[index]),
      "Unknown native launcher flag.",
    );
    options[flags[index].slice(2)] = flags[index + 1];
  }
  assert.ok(argv.slice(0, separator).includes("--isolated-dev"));
  assert.ok(["claude", "codex"].includes(options.client));
  assert.ok(options.arm === undefined || ["off", "on"].includes(options.arm));
  const base = new URL(
    process.env.ARCHESTRA_BENCHMARK_BASE ?? "http://127.0.0.1:9000",
  );
  assert.equal(base.protocol, "http:");
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(base.hostname));
  assert.ok(!base.username && !base.password && !base.search && !base.hash);
  const api = async (method, path, body) => {
    const response = await fetch(new URL(path, base), {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(30000),
      headers: {
        authorization: process.env.ARCHESTRA_BENCHMARK_API_AUTH,
        "content-type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    assert.ok(
      response.ok,
      `Native setup ${method} ${path}: HTTP ${response.status}`,
    );
    return response.json();
  };
  assert.ok(
    process.env.ARCHESTRA_BENCHMARK_API_AUTH &&
      process.env.ARCHESTRA_BENCHMARK_PASSTHROUGH_KEY,
  );
  await api("GET", "/api/user-tokens/me");
  const { value: gatewayToken } = await api("GET", "/api/user-tokens/me/value");
  const session = options.session ?? randomUUID();
  const agent = process.env.ARCHESTRA_BENCHMARK_AGENT;
  const directory = await mkdtemp(join(tmpdir(), "appa-native-client-"));
  let child;
  let interrupted = false;
  let terminationTimer;
  const forwardSignal = (signal) => {
    interrupted = true;
    child?.kill(signal);
    if (child && !terminationTimer) {
      terminationTimer = setTimeout(() => child.kill("SIGKILL"), 5000);
      terminationTimer.unref();
    }
  };
  const onInterrupt = () => forwardSignal("SIGINT");
  const onTerminate = () => forwardSignal("SIGTERM");
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);
  process.on("SIGHUP", onTerminate);
  try {
    const mcpConfig = join(directory, "mcp.json");
    if (options.client === "claude")
      await writeFile(
        mcpConfig,
        JSON.stringify({
          mcpServers: {
            appa_benchmark: {
              type: "http",
              url: `${base.origin}/v1/mcp/${agent}`,
              headers: {
                Authorization: `Bearer ${gatewayToken}`,
                "X-Appa-Session-ID": session,
                "X-Archestra-Session-Id": session,
              },
            },
          },
        }),
        { mode: 0o600 },
      );
    const launch = buildClientLaunch({
      client: options.client,
      base: base.origin,
      agent,
      session,
      passthroughKey: process.env.ARCHESTRA_BENCHMARK_PASSTHROUGH_KEY,
      gatewayToken,
      mcpConfig,
      args: argv.slice(separator + 1),
      env: process.env,
    });
    const run = async () => {
      assert.ok(!interrupted, "Native client launch interrupted.");
      console.error(
        JSON.stringify({
          client: options.client,
          session,
          arm: options.arm ?? "unchanged",
          auth: "native-client-existing-login",
          toolDiscovery: "real-native-MCP-not-frozen-harness",
        }),
      );
      child = spawn(launch.command, launch.args, {
        env: launch.env,
        stdio: "inherit",
      });
      await new Promise((resolve, reject) => {
        child.once("error", () =>
          reject(new Error("Native client executable unavailable.")),
        );
        child.once("exit", (code, signal) => {
          process.exitCode = code ?? (signal ? 130 : 1);
          resolve();
        });
      });
    };
    if (options.arm)
      await withDeployment({
        api,
        work: async ({ set }) => {
          await set(options.arm === "on");
          await run();
        },
      });
    else await run();
  } finally {
    clearTimeout(terminationTimer);
    process.removeListener("SIGINT", onInterrupt);
    process.removeListener("SIGTERM", onTerminate);
    process.removeListener("SIGHUP", onTerminate);
    await rm(directory, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main(process.argv.slice(2)).catch(() => {
    console.error(
      "Native client setup failed; verify private platform credentials, CLI login and loopback stack.",
    );
    process.exitCode = 1;
  });
}
