import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { expect, test } from "vitest";
import { GROK_LOOPBACK_PROXY } from "./grok-loopback-proxy";

function start(block: object, env: NodeJS.ProcessEnv) {
  return runInNewContext(
    `${GROK_LOOPBACK_PROXY}\nstartGrokLoopbackProxy(state, env)`,
    {
      state: { block: JSON.stringify(block) },
      env,
      Buffer,
      URL,
      readGrokToml: JSON.parse,
      require: createRequire(import.meta.url),
    },
  ) as Promise<{ close: () => Promise<void> }>;
}

function viaProxy(proxy: string, target: string) {
  return new Promise<{ status: number; text: string }>((resolve, reject) => {
    const outgoing = request(
      proxy,
      {
        path: target,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer synthetic-key",
          "x-grok-session-id": "synthetic-session",
        },
      },
      (response) => {
        let text = "";
        response.on("data", (chunk) => {
          text += chunk;
        });
        response.on("end", () =>
          resolve({ status: response.statusCode ?? 500, text }),
        );
      },
    );
    outgoing.once("error", reject);
    outgoing.end('{"synthetic":true}');
  });
}

test("local development proxy preserves authority, native session and body, rejects other origins, and closes with the launch", async () => {
  const observed: unknown[] = [];
  const upstream = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    observed.push({
      host: request.headers.host,
      session: request.headers["x-grok-session-id"],
      authorization: request.headers.authorization,
      body,
    });
    response.end("synthetic reply");
  });
  await new Promise<void>((resolve) =>
    upstream.listen(0, "127.0.0.1", resolve),
  );
  const authority = `stack2.localhost:${(upstream.address() as { port: number }).port}`;
  const env = {
    NO_PROXY: ".localhost,internal.example",
    HTTPS_PROXY: "https://existing.example",
  };
  const proxy = await start(
    { model: { archestra: { base_url: `http://${authority}/v1` } } },
    env,
  );
  try {
    const endpoint = (env as NodeJS.ProcessEnv).HTTP_PROXY;
    if (!endpoint) throw new Error("Missing synthetic proxy address");
    expect(
      await viaProxy(endpoint, `http://${authority}/v1/responses`),
    ).toEqual({ status: 200, text: "synthetic reply" });
    expect(observed).toEqual([
      {
        host: authority,
        session: "synthetic-session",
        authorization: "Bearer synthetic-key",
        body: '{"synthetic":true}',
      },
    ]);
    expect(
      (await viaProxy(endpoint, "http://external.invalid/private")).status,
    ).toBe(403);
    expect(observed).toHaveLength(1);
    expect(env.NO_PROXY).toBe("internal.example");
    expect(env.HTTPS_PROXY).toBe("https://existing.example");
    await proxy.close();
    await expect(
      viaProxy(endpoint, `http://${authority}/v1/responses`),
    ).rejects.toThrow();
  } finally {
    await proxy.close();
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});

test.skipIf(!process.env.ARCHESTRA_GROK_TEST_BINARY)(
  "official Grok completes a synthetic model turn through an unresolvable named-localhost URL",
  async () => {
    const binary = process.env.ARCHESTRA_GROK_TEST_BINARY;
    if (!binary) throw new Error("Native fixture binary required");
    const home = mkdtempSync(path.join(tmpdir(), "grok native localhost "));
    let named = "";
    const models: string[] = [];
    const server = createServer(async (request, response) => {
      response.setHeader("Content-Type", "application/json");
      if (request.method === "GET") {
        response.end(
          JSON.stringify({
            data: [
              {
                id: "grok-4.7",
                model: "synthetic",
                name: "Synthetic",
                api_backend: "chat_completions",
                base_url: named,
              },
            ],
          }),
        );
        return;
      }
      let text = "";
      for await (const chunk of request) text += chunk;
      const body = JSON.parse(text);
      models.push(body.model);
      response.setHeader("Content-Type", "text/event-stream");
      response.end(
        `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta: { role: "assistant", content: "SYNTHETIC_LOOPBACK_OK" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const port = (server.address() as { port: number }).port;
    named = `http://stack2.localhost:${port}/v1`;
    const native = path.join(home, ".grok");
    mkdirSync(native);
    writeFileSync(
      path.join(native, "config.toml"),
      `[model.synthetic]\nmodel="synthetic"\nbase_url="${named}"\napi_backend="chat_completions"\napi_key="synthetic-key"\n`,
    );
    const env = {
      ...process.env,
      HOME: home,
      GROK_HOME: native,
      NO_PROXY: "127.0.0.1",
      no_proxy: "127.0.0.1",
      XAI_API_KEY: "synthetic-key",
      GROK_DISABLE_AUTOUPDATER: "1",
      GROK_TELEMETRY_ENABLED: "0",
      GROK_MODELS_BASE_URL: `http://127.0.0.1:${port}/v1`,
      GROK_MODELS_LIST_URL: `http://127.0.0.1:${port}/v1/models`,
      GROK_XAI_API_BASE_URL: `http://127.0.0.1:${port}/v1`,
      GROK_CLI_CHAT_PROXY_BASE_URL: `http://127.0.0.1:${port}/v1`,
    };
    const proxy = await start(
      { model: { archestra: { base_url: named } } },
      env,
    );
    try {
      const result = await new Promise<{ code: number | null; output: string }>(
        (resolve) => {
          const child = spawn(
            binary,
            [
              "-m",
              "synthetic",
              "-p",
              "Synthetic fixture",
              "--output-format",
              "json",
              "--max-turns",
              "1",
              "--no-subagents",
            ],
            { cwd: home, env, stdio: ["ignore", "pipe", "pipe"] },
          );
          let output = "";
          child.stdout.on("data", (chunk) => {
            output += chunk;
          });
          child.stderr.resume();
          const timer = setTimeout(() => child.kill("SIGTERM"), 15000);
          child.once("close", (code) => {
            clearTimeout(timer);
            resolve({ code, output });
          });
        },
      );
      expect(result.code, result.output).toBe(0);
      expect(result.output).toContain("SYNTHETIC_LOOPBACK_OK");
      expect(models).toContain("synthetic");
    } finally {
      await proxy.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(home, { recursive: true, force: true });
    }
  },
  25000,
);
