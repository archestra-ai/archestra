import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, request as httpRequest, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, expect, test } from "vitest";
import { GROK_MCP_SIGN_IN } from "./grok-mcp-sign-in";

const resources: { home: string; server: Server }[] = [];
afterEach(async () => {
  for (const item of resources.splice(0)) {
    item.server.closeAllConnections();
    await new Promise<void>((resolve) => item.server.close(() => resolve()));
    rmSync(item.home, { recursive: true, force: true });
  }
});

async function fixture(mode: string, force = false) {
  const home = mkdtempSync(path.join(tmpdir(), "grok oauth 日本語 "));
  let origin = "",
    challenge = "",
    exchanges = 0,
    initializes = 0,
    lists = 0,
    registrations = 0;
  const server = createServer(async (request, response) => {
    if (mode === "named-loopback")
      expect(request.headers.host).toBe(new URL(origin).host);
    let body = "";
    for await (const chunk of request) body += chunk;
    response.setHeader("Content-Type", "application/json");
    if (request.url?.startsWith("/.well-known/oauth-protected-resource")) {
      if (mode === "discovery-redirect") {
        response.writeHead(302, { Location: origin + "/issuer" });
        response.end();
        return;
      }
      response.end(
        JSON.stringify({
          resource: origin + (mode === "resource-mixup" ? "/other" : "/mcp"),
          authorization_servers: [origin],
          scopes_supported: ["mcp"],
        }),
      );
    } else if (request.url === "/.well-known/oauth-authorization-server") {
      response.end(
        JSON.stringify({
          issuer: mode === "metadata-issuer-mixup" ? origin + "/other" : origin,
          authorization_endpoint: origin + "/authorize",
          token_endpoint:
            mode === "endpoint-mixup"
              ? "https://unapproved.example/token"
              : origin + "/token",
          registration_endpoint: origin + "/register",
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
          scopes_supported: ["mcp", "offline_access"],
          authorization_response_iss_parameter_supported: true,
        }),
      );
    } else if (request.url === "/register") {
      registrations++;
      expect(JSON.parse(body)).toMatchObject({
        token_endpoint_auth_method: "none",
        response_types: ["code"],
      });
      response.end(
        JSON.stringify({
          client_id: "synthetic-public-client",
          token_endpoint_auth_method: "none",
        }),
      );
    } else if (request.url === "/token") {
      exchanges++;
      const parameters = new URLSearchParams(body);
      expect(parameters.get("resource")).toBe(origin + "/mcp");
      expect(parameters.get("client_id")).toBe("synthetic-public-client");
      const valid =
        parameters.get("grant_type") === "refresh_token" ||
        createHash("sha256")
          .update(parameters.get("code_verifier") ?? "")
          .digest("base64url") === challenge;
      if (
        !valid ||
        mode === "pkce-rejected" ||
        (mode === "refresh-rejected" &&
          parameters.get("grant_type") === "refresh_token")
      ) {
        response.writeHead(400);
        response.end(
          JSON.stringify({ error: "synthetic-private-error-not-for-output" }),
        );
        return;
      }
      response.end(
        JSON.stringify({
          access_token: "synthetic-access",
          refresh_token: "synthetic-refresh",
          token_type: "Bearer",
          expires_in: 3600,
          scope: "mcp offline_access",
        }),
      );
    } else if (request.url === "/mcp") {
      if (
        mode === "cached-revoked" &&
        request.headers.authorization === "Bearer synthetic-revoked"
      ) {
        response.writeHead(401);
        response.end("{}");
        return;
      }
      expect(request.headers.authorization).toBe("Bearer synthetic-access");
      const rpc = JSON.parse(body);
      if (rpc.method === "initialize") initializes++;
      if (rpc.method === "tools/list") lists++;
      response.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: rpc.id,
          ...(mode === "verification-denied"
            ? {
                error: {
                  code: -32001,
                  message: "synthetic-private-error-not-for-output",
                },
              }
            : {
                result:
                  rpc.method === "initialize"
                    ? {
                        protocolVersion: "2026-07-28",
                        capabilities: {},
                        serverInfo: { name: "synthetic", version: "1" },
                      }
                    : {
                        tools: [
                          {
                            name: "synthetic_tool",
                            inputSchema: { type: "object" },
                          },
                        ],
                      },
              }),
        }),
      );
    } else {
      response.writeHead(404);
      response.end("{}");
    }
  });
  resources.push({ home, server });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin =
    (mode === "named-loopback"
      ? "http://stack2.localhost:"
      : "http://127.0.0.1:") + (server.address() as { port: number }).port;
  const cache = path.join(home, "mcp_credentials.json"),
    browserUrl = path.join(home, "browser.private"),
    browser = path.join(home, "open-browser.cjs");
  const unrelated = {
    client_id: "unrelated-client",
    privateSetting: "synthetic-unrelated-value",
  };
  const initial: Record<string, unknown> = {
    "other:https://other.example/mcp": unrelated,
  };
  if (
    force ||
    ["refresh", "cached", "cached-revoked", "refresh-rejected"].includes(mode)
  )
    initial["gateway:" + origin + "/mcp"] = {
      client_id: "synthetic-public-client",
      issuer: origin,
      granted_scopes: ["mcp", "offline_access"],
      token_received_at: 1,
      token_response: {
        access_token:
          mode === "cached-revoked" ? "synthetic-revoked" : "synthetic-access",
        refresh_token: "synthetic-refresh",
        expires_at:
          force || mode.startsWith("cached")
            ? Math.floor(Date.now() / 1000) + 3600
            : 1,
        expires_in: 1,
      },
    };
  writeFileSync(cache, JSON.stringify(initial), { mode: 0o600 });
  if (mode === "corrupt-cache") writeFileSync(cache, "not JSON");
  if (mode === "unknown-record") {
    initial["gateway:" + origin + "/mcp"] = {
      issuer: "https://different.example",
    };
    writeFileSync(cache, JSON.stringify(initial));
  }
  if (mode === "linked-cache") {
    rmSync(cache);
    const target = path.join(home, "unrelated.json");
    writeFileSync(target, JSON.stringify(initial));
    symlinkSync(target, cache);
  }
  const before = readFileSync(cache, "utf8");
  writeFileSync(
    browser,
    `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(browserUrl)}, process.argv[2]);\n`,
    { mode: 0o700 },
  );
  const script = path.join(home, "sign-in.cjs");
  writeFileSync(
    script,
    `${GROK_MCP_SIGN_IN}\nnew GrokMcpSignIn(${JSON.stringify({ serverName: "gateway", url: origin + "/mcp", issuer: origin, timeout: mode === "timeout" ? 500 : 15000 })}).run({force:${force}}).catch(error => { console.error(error.message); process.exitCode=1; });`,
  );
  const child = spawn(process.execPath, [script], {
    env: {
      ...process.env,
      GROK_HOME: home,
      BROWSER:
        mode === "browser-failure"
          ? path.join(home, "missing-browser")
          : browser,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (value) => (output += value));
  child.stderr.on("data", (value) => (output += value));
  const done = new Promise<number | null>((resolve) =>
    child.once("exit", resolve),
  );
  let callbackPort: number | null = null;
  for (let attempt = 0; attempt < 150 && child.exitCode === null; attempt++) {
    if (!existsSync(browserUrl)) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      continue;
    }
    const authorization = new URL(readFileSync(browserUrl, "utf8"));
    challenge = authorization.searchParams.get("code_challenge") ?? "";
    expect(authorization.searchParams.get("code_challenge_method")).toBe(
      "S256",
    );
    expect(authorization.searchParams.get("scope")).toBe("mcp offline_access");
    expect(authorization.searchParams.get("resource")).toBe(origin + "/mcp");
    const callback = new URL(
      authorization.searchParams.get("redirect_uri") as string,
    );
    callbackPort = Number(callback.port);
    callback.searchParams.set(
      "state",
      mode === "state-mismatch"
        ? "wrong"
        : (authorization.searchParams.get("state") as string),
    );
    callback.searchParams.set(
      "iss",
      mode === "callback-issuer-mismatch" ? origin + "/wrong" : origin,
    );
    if (mode === "denied") callback.searchParams.set("error", "access_denied");
    else
      callback.searchParams.set(
        "code",
        mode === "invalid-code" ? "invalid code" : "synthetic-code",
      );
    if (mode === "duplicate-state")
      callback.searchParams.append("state", "another");
    if (mode === "timeout") break;
    if (mode === "cancel") {
      child.kill("SIGINT");
      break;
    }
    if (mode === "concurrent-cache")
      writeFileSync(
        cache,
        JSON.stringify({ ...initial, changedByNative: true }),
      );
    if (mode === "wrong-path") {
      const wrong = new URL(callback);
      wrong.pathname = "/wrong";
      expect((await fetch(wrong)).status).toBe(400);
      expect(exchanges).toBe(0);
    }
    if (mode === "wrong-host") {
      const status = await new Promise<number | undefined>(
        (resolve, reject) => {
          const request = httpRequest(
            callback,
            { headers: { Host: "unapproved.invalid" } },
            (response) => {
              response.resume();
              response.once("end", () => resolve(response.statusCode));
            },
          );
          request.once("error", reject);
          request.end();
        },
      );
      expect(status).toBe(400);
      expect(exchanges).toBe(0);
    }
    const response = await fetch(callback);
    expect(response.status).toBe(
      [
        "state-mismatch",
        "callback-issuer-mismatch",
        "denied",
        "invalid-code",
        "duplicate-state",
      ].includes(mode)
        ? 400
        : 200,
    );
    if (mode === "duplicate-callback") {
      try {
        expect((await fetch(callback)).status).toBe(409);
      } catch (error) {
        if (!(error instanceof TypeError)) throw error;
      }
    }
    break;
  }
  const exit = await done;
  if (callbackPort)
    await expect(fetch("http://127.0.0.1:" + callbackPort)).rejects.toThrow();
  return {
    exit,
    output,
    cache,
    before,
    unrelated,
    origin,
    exchanges,
    initializes,
    lists,
    registrations,
    home,
  };
}

test.each([
  "success",
  "named-loopback",
  "wrong-path",
  "wrong-host",
  "duplicate-callback",
  "refresh",
  "cached",
  "cached-revoked",
  "refresh-rejected",
])("installer-owned OAuth verifies and persists native credentials: %s", async (mode) => {
  const result = await fixture(mode);
  expect(result.exit, result.output).toBe(0);
  const entries = JSON.parse(readFileSync(result.cache, "utf8"));
  expect(entries["other:https://other.example/mcp"]).toEqual(result.unrelated);
  expect(entries["gateway:" + result.origin + "/mcp"]).toMatchObject({
    client_id: "synthetic-public-client",
    issuer: result.origin,
    token_response: { access_token: "synthetic-access" },
  });
  expect(result.initializes).toBe(1);
  expect(result.lists).toBe(1);
  expect(result.exchanges).toBe(
    mode === "cached" ? 0 : mode === "refresh-rejected" ? 2 : 1,
  );
  if (mode !== "cached")
    expect(statSync(result.cache).mode & 0o777).toBe(0o600);
});

test("explicit fresh authorization does not reuse a valid cached login", async () => {
  const result = await fixture("cached", true);
  expect(result.exit, result.output).toBe(0);
  expect(result.registrations).toBe(1);
  expect(result.exchanges).toBe(1);
  expect(result.initializes).toBe(1);
  expect(result.lists).toBe(1);
  expect(readFileSync(result.cache, "utf8")).not.toBe(result.before);
  expect(
    JSON.parse(readFileSync(result.cache, "utf8"))[
      "other:https://other.example/mcp"
    ],
  ).toEqual(result.unrelated);
  expect(result.output).not.toContain("Existing native Grok login kept");
});

test.each([
  "denied",
  "cancel",
  "browser-failure",
  "timeout",
  "pkce-rejected",
  "state-mismatch",
  "verification-denied",
])("fresh authorization %s preserves the already valid native cache byte-for-byte", async (mode) => {
  const result = await fixture(mode, true);
  expect(result.exit).not.toBe(0);
  expect(readFileSync(result.cache, "utf8")).toBe(result.before);
  expect(result.output).not.toContain("synthetic-access");
  expect(result.output).not.toContain("synthetic-refresh");
});

test("fresh authorization never overwrites a concurrently changed valid native cache", async () => {
  const result = await fixture("concurrent-cache", true);
  expect(result.exit).not.toBe(0);
  const after = JSON.parse(readFileSync(result.cache, "utf8"));
  expect(after.changedByNative).toBe(true);
  expect(after["gateway:" + result.origin + "/mcp"]).toEqual(
    JSON.parse(result.before)["gateway:" + result.origin + "/mcp"],
  );
  expect(after["other:https://other.example/mcp"]).toEqual(result.unrelated);
});

test.each([
  "state-mismatch",
  "callback-issuer-mismatch",
  "metadata-issuer-mixup",
  "resource-mixup",
  "endpoint-mixup",
  "discovery-redirect",
  "denied",
  "duplicate-state",
  "invalid-code",
  "pkce-rejected",
  "browser-failure",
  "timeout",
  "cancel",
  "corrupt-cache",
  "unknown-record",
  "linked-cache",
  "verification-denied",
  "concurrent-cache",
])("OAuth refuses unsafe or unfinished flow and preserves cache: %s", async (mode) => {
  const result = await fixture(mode);
  expect(result.exit, result.output).not.toBe(0);
  if (mode !== "concurrent-cache")
    expect(readFileSync(result.cache, "utf8")).toBe(result.before);
  else
    expect(JSON.parse(readFileSync(result.cache, "utf8"))).toHaveProperty(
      "changedByNative",
      true,
    );
  expect(result.output).not.toContain("synthetic-private-error-not-for-output");
  expect(result.output).not.toContain("synthetic-access");
  if (
    !["pkce-rejected", "verification-denied", "concurrent-cache"].includes(mode)
  )
    expect(result.exchanges).toBe(0);
});

test("Windows browser dispatch treats an ampersand-bearing consent URL as one argv and no shell", async () => {
  const calls: unknown[] = [];
  const exported: {
    value?: { new (options: unknown): { open(url: string): Promise<void> } };
  } = {};
  runInNewContext(`${GROK_MCP_SIGN_IN}\nexported.value = GrokMcpSignIn;`, {
    exported,
    URL,
    AbortController,
    setTimeout,
    clearTimeout,
    process: { platform: "win32", env: {} },
    require: (name: string) =>
      name === "node:child_process"
        ? {
            spawn: (...args: unknown[]) => {
              calls.push(args);
              const child = new EventEmitter();
              queueMicrotask(() => child.emit("exit", 0));
              return child;
            },
          }
        : require(name),
  });
  const Constructor = exported.value as NonNullable<typeof exported.value>;
  const instance = new Constructor({
    serverName: "gateway",
    url: "https://api.example/mcp",
    issuer: "https://app.example",
  });
  const url =
    "https://app.example/authorize?state=a&scope=mcp%20offline_access";
  await instance.open(url);
  expect(calls).toEqual([
    [
      "rundll32.exe",
      ["url.dll,FileProtocolHandler", url],
      { shell: false, windowsHide: true, stdio: "ignore" },
    ],
  ]);
});

test.each([
  "success",
  "acl-failure",
  "acl-failure-absent",
])("Windows private native cache replacement preserves unrelated entries: %s", (mode) => {
  const home = mkdtempSync(path.join(tmpdir(), "grok windows cache "));
  try {
    const cache = path.join(home, "mcp_credentials.json");
    const before =
      mode === "acl-failure-absent"
        ? null
        : JSON.stringify({ unrelated: { setting: "synthetic-user-value" } });
    if (before !== null) writeFileSync(cache, before);
    const calls: { command: string; args: string[] }[] = [];
    const exported: {
      value?: {
        new (
          options: unknown,
        ): { before: string | null; save(cache: object, entry: object): void };
      };
    } = {};
    runInNewContext(`${GROK_MCP_SIGN_IN}\nexported.value = GrokMcpSignIn;`, {
      exported,
      URL,
      AbortController,
      process: {
        platform: "win32",
        env: { GROK_HOME: home },
        getuid: process.getuid,
      },
      require: (name: string) =>
        name === "node:child_process"
          ? {
              execFileSync: (command: string, args: string[]) => {
                calls.push({ command, args });
                if (command === "whoami.exe")
                  return '"fixture","S-1-5-21-100-200-300-400"';
                if (mode !== "success")
                  throw new Error("synthetic ACL failure");
                return "";
              },
            }
          : require(name),
    });
    const Constructor = exported.value as NonNullable<typeof exported.value>;
    const instance = new Constructor({
      serverName: "gateway",
      url: "https://api.example/mcp",
      issuer: "https://app.example",
    });
    instance.before = before;
    const save = () =>
      instance.save(before ? JSON.parse(before) : {}, {
        client_id: "synthetic-client",
      });
    if (mode === "success") {
      save();
      expect(JSON.parse(readFileSync(cache, "utf8"))).toEqual({
        unrelated: { setting: "synthetic-user-value" },
        "gateway:https://api.example/mcp": { client_id: "synthetic-client" },
      });
    } else {
      expect(save).toThrow("could not be stored privately");
      expect(existsSync(cache) ? readFileSync(cache, "utf8") : null).toBe(
        before,
      );
    }
    expect(calls[0]).toEqual({
      command: "whoami.exe",
      args: ["/user", "/fo", "csv", "/nh"],
    });
    expect(calls[1].command).toBe("icacls.exe");
    expect(calls[1].args.slice(1)).toEqual([
      "/inheritance:r",
      "/grant:r",
      "*S-1-5-21-100-200-300-400:F",
    ]);
    expect(readdirSync(home).some((name) => name.endsWith(".tmp"))).toBe(false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
