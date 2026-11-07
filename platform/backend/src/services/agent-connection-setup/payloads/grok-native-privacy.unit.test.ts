import { spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { runInNewContext } from "node:vm";
import { expect, test } from "vitest";
import { GROK_NATIVE_TRANSPORT } from "./grok-native-transport";

test.skipIf(!process.env.ARCHESTRA_GROK_TEST_BINARY)(
  "official Grok privacy control saves only successful user choices through the protected transport",
  async () => {
    const home = mkdtempSync(path.join(tmpdir(), "grok-native-privacy-"));
    const native = path.join(home, "native"),
      authPath = path.join(home, "ordinary-login.json");
    mkdirSync(native);
    const clientId = "b1a00492-073a-47ea-816f-4c329264a828";
    const scope = `https://auth.x.ai::${clientId}`;
    writeFileSync(
      authPath,
      JSON.stringify({
        [scope]: {
          key: "synthetic-native-access",
          auth_mode: "oidc",
          oidc_issuer: "https://auth.x.ai",
          oidc_client_id: clientId,
          user_id: "synthetic-user",
          create_time: new Date().toISOString(),
          expires_at: "2099-01-01T00:00:00Z",
          coding_data_retention_opt_out: false,
        },
      }),
      { mode: 0o600 },
    );
    let optOut = false,
      deny = false;
    const choices: boolean[] = [];
    const upstream = createServer(async (request, response) => {
      response.setHeader("Content-Type", "application/json");
      if (
        request.url === "/v1/xai/native/privacy/coding-data-retention" &&
        request.method === "PUT"
      ) {
        let text = "";
        for await (const chunk of request) text += chunk;
        const value = JSON.parse(text);
        choices.push(value.codingDataRetentionOptOut);
        if (deny) {
          response.writeHead(403).end('{"error":"Synthetic privacy denial"}');
          return;
        }
        optOut = value.codingDataRetentionOptOut;
        response.end(JSON.stringify(value));
      } else if (request.url?.endsWith("/user")) {
        response.end(
          JSON.stringify({
            userId: "synthetic-user",
            codingDataRetentionOptOut: optOut,
          }),
        );
      } else if (request.url?.endsWith("/models")) {
        response.end(
          '{"data":[{"id":"synthetic","model":"synthetic","api_backend":"responses","context_window":200000}]}',
        );
      } else if (request.url?.endsWith("/settings")) {
        response.end('{"default_model":"synthetic"}');
      } else {
        response.writeHead(404).end();
      }
    });
    await new Promise<void>((resolve) =>
      upstream.listen(0, "127.0.0.1", resolve),
    );
    const transport = (await runInNewContext(
      `${GROK_NATIVE_TRANSPORT}\nnew GrokNativeTransport(connection).start()`,
      {
        connection: {
          url: `http://127.0.0.1:${(upstream.address() as { port: number }).port}/v1/xai`,
          headers: { "x-archestra-virtual-key": "synthetic-attribution" },
        },
        require: createRequire(import.meta.url),
        URL,
        Headers,
        Response,
        Buffer,
        fetch,
        AbortSignal,
      },
    )) as { base: string; close(): Promise<void> };
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !/^(GROK_|XAI_)/.test(key)),
    );
    Object.assign(env, {
      HOME: home,
      GROK_HOME: native,
      GROK_AUTH_PATH: authPath,
      GROK_CLI_CHAT_PROXY_BASE_URL: transport.base,
      GROK_DISABLE_AUTOUPDATER: "1",
      GROK_TELEMETRY_ENABLED: "0",
      GROK_DISABLE_API_KEY_AUTH: "1",
      NO_PROXY: "127.0.0.1",
    });
    const child = spawn(
      process.env.ARCHESTRA_GROK_TEST_BINARY as string,
      ["agent", "--no-leader", "stdio"],
      { cwd: home, env, stdio: ["pipe", "pipe", "pipe"] },
    );
    let stderr = "",
      nextId = 0;
    const waiting = new Map<
      number,
      { resolve(value: unknown): void; reject(error: Error): void }
    >();
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      let response: { id: number; error?: unknown; result?: unknown };
      try {
        response = JSON.parse(line);
      } catch {
        return;
      }
      const pending = waiting.get(response.id);
      if (!pending) return;
      waiting.delete(response.id);
      if (response.error)
        pending.reject(new Error(JSON.stringify(response.error)));
      else pending.resolve(response.result);
    });
    child.once("close", () => {
      for (const pending of waiting.values())
        pending.reject(new Error(`Native Grok exited: ${stderr.slice(-500)}`));
      waiting.clear();
    });
    const call = (method: string, params: object) =>
      new Promise<unknown>((resolve, reject) => {
        const id = ++nextId;
        const timer = setTimeout(() => {
          waiting.delete(id);
          reject(
            new Error(`Native privacy RPC timed out: ${stderr.slice(-500)}`),
          );
        }, 15000);
        waiting.set(id, {
          resolve: (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
        });
        child.stdin.write(
          `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
        );
      });
    try {
      await call("initialize", {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: "synthetic-privacy-test", version: "1" },
      });
      await call("_x.ai/privacy/setCodingDataRetention", {
        codingDataRetentionOptOut: true,
      });
      expect(optOut).toBe(true);
      expect(
        JSON.parse(readFileSync(authPath, "utf8"))[scope]
          .coding_data_retention_opt_out,
      ).toBe(true);
      deny = true;
      await expect(
        call("_x.ai/privacy/setCodingDataRetention", {
          codingDataRetentionOptOut: false,
        }),
      ).rejects.toThrow();
      expect(optOut).toBe(true);
      expect(
        JSON.parse(readFileSync(authPath, "utf8"))[scope]
          .coding_data_retention_opt_out,
      ).toBe(true);
      deny = false;
      await call("_x.ai/privacy/setCodingDataRetention", {
        codingDataRetentionOptOut: false,
      });
      expect(optOut).toBe(false);
      expect(
        JSON.parse(readFileSync(authPath, "utf8"))[scope]
          .coding_data_retention_opt_out,
      ).toBe(false);
      expect(choices).toEqual([true, false, false]);
    } finally {
      const exited = new Promise<void>((resolve) =>
        child.once("close", () => resolve()),
      );
      child.kill("SIGTERM");
      await Promise.race([
        exited,
        new Promise((resolve) => setTimeout(resolve, 1000)),
      ]);
      if (child.exitCode === null) child.kill("SIGKILL");
      lines.close();
      await transport.close();
      upstream.closeAllConnections();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
      rmSync(home, { recursive: true, force: true });
    }
  },
  60000,
);
