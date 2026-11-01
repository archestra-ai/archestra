import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import type { DeviceMcpConfig } from "@archestra/shared/device-mcp";
import { DeviceMcpConfigSchema } from "@archestra/shared/device-mcp";
import { afterEach, describe, expect, test } from "vitest";
import { DeviceMcpCompanion } from "./client";

const fixture = fileURLToPath(
  new URL("../test/fixtures/device-mcp.mjs", import.meta.url),
);
const config: DeviceMcpConfig = {
  protocolVersion: 1,
  version: "fixture-1",
  platforms: {
    darwin: { command: process.execPath, args: [fixture] },
    win32: { command: "node.exe", args: [fixture] },
  },
  tools: [
    {
      name: "echo",
      description: "Return the supplied text",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string" },
          delayMs: { type: "integer", minimum: 0, maximum: 5000 },
        },
        required: ["text"],
        additionalProperties: false,
      },
    },
  ],
};

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          ),
      ),
  );
});

async function relay(
  handler: (
    action: string,
    body: Record<string, unknown>,
    authorization: string | undefined,
  ) => { status?: number; body: unknown },
) {
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const result = handler(
      request.url?.split("/").at(-1) ?? "",
      JSON.parse(Buffer.concat(chunks).toString()),
      request.headers.authorization,
    );
    response.writeHead(result.status ?? 200, {
      "Content-Type": "application/json",
    });
    response.end(JSON.stringify(result.body));
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing test relay address");
  return `http://127.0.0.1:${address.port}`;
}

function inspection(value = config) {
  return {
    config: value,
    configDigest: createHash("sha256")
      .update(JSON.stringify(value))
      .digest("hex"),
  };
}

describe("device MCP companion", () => {
  test("accepts a reviewed large manifest and validates it against a real MCP process", async () => {
    const largeConfig = structuredClone(config);
    largeConfig.platforms.darwin.args.push("--tool-count=600");
    largeConfig.tools = Array.from({ length: 600 }, (_, index) => ({
      ...config.tools[0],
      name: `echo-${index}`,
    }));
    expect(DeviceMcpConfigSchema.safeParse(largeConfig).success).toBe(true);
    const oversizedConfig = {
      ...largeConfig,
      tools: Array.from({ length: 1025 }, (_, index) => ({
        ...config.tools[0],
        name: `echo-${index}`,
      })),
    };
    expect(DeviceMcpConfigSchema.safeParse(oversizedConfig).success).toBe(
      false,
    );
    let openedSession = false;
    const url = await relay((action) => {
      if (action === "inspect") return { body: inspection(largeConfig) };
      if (action === "redeem")
        return {
          body: {
            ...inspection(largeConfig),
            deviceId: "test-device",
            token: "test-memory-token",
          },
        };
      if (action === "session") {
        openedSession = true;
        return { status: 401, body: {} };
      }
      throw new Error(`Unexpected action ${action}`);
    });
    const client = new DeviceMcpCompanion(url, "darwin");
    await client.pair("code", async () => true);
    await expect(client.run(new AbortController().signal)).rejects.toThrow(
      "401",
    );
    expect(openedSession).toBe(true);
  });

  test.each([
    ["--pagination-cycle", "repeated cursor"],
    ["--pagination-unbounded", "page limit"],
  ])("rejects unsafe tool pagination %s before opening a relay session", async (mode, error) => {
    const invalidConfig = structuredClone(config);
    invalidConfig.platforms.darwin.args.push(mode);
    const actions: string[] = [];
    const url = await relay((action) => {
      actions.push(action);
      return {
        body:
          action === "inspect"
            ? inspection(invalidConfig)
            : {
                ...inspection(invalidConfig),
                deviceId: "test-device",
                token: "test-memory-token",
              },
      };
    });
    const client = new DeviceMcpCompanion(url, "darwin");
    await client.pair("code", async () => true);
    await expect(client.run(new AbortController().signal)).rejects.toThrow(
      error,
    );
    expect(actions).toEqual(["inspect", "redeem"]);
  });

  test("does not redeem a credential or launch when local consent is declined", async () => {
    const actions: string[] = [];
    const url = await relay((action) => {
      actions.push(action);
      return { body: inspection() };
    });
    const client = new DeviceMcpCompanion(url, "darwin");
    await expect(
      client.pair("temporary-code", async () => false),
    ).rejects.toThrow("cancelled");
    expect(actions).toEqual(["inspect"]);
  });

  test("rejects remote plaintext origins, URL credentials and batch/shell launchers", async () => {
    expect(
      () => new DeviceMcpCompanion("http://example.com", "darwin"),
    ).toThrow("HTTPS");
    expect(
      () => new DeviceMcpCompanion("https://token@example.com", "darwin"),
    ).toThrow("HTTPS");
    expect(
      () => new DeviceMcpCompanion("https://example.com/path", "darwin"),
    ).toThrow("HTTPS");
    const shellConfig = structuredClone(config);
    shellConfig.platforms.win32.command = "C:\\Windows\\System32\\cmd.exe";
    const url = await relay(() => ({ body: inspection(shellConfig) }));
    const client = new DeviceMcpCompanion(url, "win32");
    await expect(client.pair("code", async () => true)).rejects.toThrow(
      "Shell commands",
    );
  });

  test("checks exact launch revision again after redeeming", async () => {
    const url = await relay((action) => ({
      body:
        action === "inspect"
          ? inspection()
          : {
              ...inspection(),
              configDigest: "changed",
              deviceId: "test-device",
              token: "test-memory-token",
            },
    }));
    const client = new DeviceMcpCompanion(url, "darwin");
    await expect(client.pair("code", async () => true)).rejects.toThrow(
      "changed during pairing",
    );
  });

  test("runs a real stdio MCP and retries result delivery without executing the tool twice", async () => {
    const controller = new AbortController();
    const resultBodies: Record<string, unknown>[] = [];
    const authHeaders: Array<string | undefined> = [];
    let delivered = false;
    const url = await relay((action, body, authorization) => {
      authHeaders.push(authorization);
      if (action === "inspect") return { body: inspection() };
      if (action === "redeem")
        return {
          body: {
            ...inspection(),
            deviceId: "test-device",
            token: "test-memory-token",
          },
        };
      if (action === "session") return { body: { sessionId: "test-session" } };
      if (action === "poll") {
        if (delivered || body.ready === false)
          return { body: { command: null } };
        delivered = true;
        return {
          body: {
            command: {
              id: "command-1",
              toolName: "echo",
              arguments: { text: "hello from the device" },
              expiresAt: new Date(Date.now() + 30_000).toISOString(),
            },
          },
        };
      }
      if (action === "result") {
        resultBodies.push(body);
        if (resultBodies.length === 1) return { status: 503, body: {} };
        setTimeout(() => controller.abort(), 50);
        return { body: {} };
      }
      throw new Error(`Unexpected action ${action}`);
    });
    const client = new DeviceMcpCompanion(url, "darwin");
    await client.pair("code", async () => true);
    await client.run(controller.signal);
    expect(resultBodies).toHaveLength(2);
    expect(resultBodies[0]).toEqual(resultBodies[1]);
    expect(resultBodies[0]).toMatchObject({
      commandId: "command-1",
      sessionId: "test-session",
      result: {
        content: [{ type: "text", text: "hello from the device" }],
        structuredContent: { executionCount: 1 },
      },
    });
    expect(authHeaders.slice(0, 2)).toEqual([undefined, undefined]);
    expect(
      authHeaders
        .slice(2)
        .every((value) => value === "Bearer test-memory-token"),
    ).toBe(true);
  });

  test("does not become ready when the installed MCP's tools differ from the approved manifest", async () => {
    const wrongConfig = structuredClone(config);
    wrongConfig.tools[0].name = "unreviewed";
    const actions: string[] = [];
    const url = await relay((action) => {
      actions.push(action);
      return {
        body:
          action === "inspect"
            ? inspection(wrongConfig)
            : {
                ...inspection(wrongConfig),
                deviceId: "test-device",
                token: "test-memory-token",
              },
      };
    });
    const client = new DeviceMcpCompanion(url, "darwin");
    await client.pair("code", async () => true);
    await expect(client.run(new AbortController().signal)).rejects.toThrow(
      "approved registry manifest",
    );
    expect(actions).toEqual(["inspect", "redeem"]);
  });

  test("heartbeats during a slow real MCP call and does not replay after the session is revoked mid-call", async () => {
    let delivered = false;
    let heartbeats = 0;
    let sessions = 0;
    const results: Record<string, unknown>[] = [];
    const url = await relay((action, body) => {
      if (action === "inspect") return { body: inspection() };
      if (action === "redeem")
        return {
          body: {
            ...inspection(),
            deviceId: "test-device",
            token: "test-memory-token",
          },
        };
      if (action === "session") {
        sessions++;
        return { body: { sessionId: "test-session" } };
      }
      if (action === "poll") {
        if (body.ready === false) {
          heartbeats++;
          return { status: 401, body: {} };
        }
        if (delivered) return { body: { command: null } };
        delivered = true;
        return {
          body: {
            command: {
              id: "slow-command",
              toolName: "echo",
              arguments: { text: "slow", delayMs: 2_500 },
              expiresAt: new Date(Date.now() + 30_000).toISOString(),
            },
          },
        };
      }
      if (action === "result") {
        results.push(body);
        return { status: 401, body: {} };
      }
      throw new Error(`Unexpected action ${action}`);
    });
    const client = new DeviceMcpCompanion(url, "darwin");
    await client.pair("code", async () => true);
    await expect(client.run(new AbortController().signal)).rejects.toThrow(
      "401",
    );
    expect(heartbeats).toBeGreaterThan(0);
    expect(sessions).toBe(1);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      result: { structuredContent: { executionCount: 1 } },
    });
  });

  test("refuses duplicate command delivery instead of executing an MCP side effect again", async () => {
    const results: Record<string, unknown>[] = [];
    const url = await relay((action, body) => {
      if (action === "inspect") return { body: inspection() };
      if (action === "redeem")
        return {
          body: {
            ...inspection(),
            deviceId: "test-device",
            token: "test-memory-token",
          },
        };
      if (action === "session") return { body: { sessionId: "test-session" } };
      if (action === "poll")
        return {
          body: {
            command: {
              id: "duplicate-command",
              toolName: "echo",
              arguments: { text: "once" },
              expiresAt: new Date(Date.now() + 30_000).toISOString(),
            },
          },
        };
      if (action === "result") {
        results.push(body);
        return { body: {} };
      }
      throw new Error(`Unexpected action ${action}`);
    });
    const client = new DeviceMcpCompanion(url, "darwin");
    await client.pair("code", async () => true);
    await expect(client.run(new AbortController().signal)).rejects.toThrow(
      "already executed",
    );
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      result: { structuredContent: { executionCount: 1 } },
    });
  });

  test("supervises a crashed real MCP process using a fresh session without replaying its interrupted command", async () => {
    const controller = new AbortController();
    const results: Record<string, unknown>[] = [];
    let sessions = 0;
    let delivered = false;
    const url = await relay((action, body) => {
      if (action === "inspect") return { body: inspection() };
      if (action === "redeem")
        return {
          body: {
            ...inspection(),
            deviceId: "test-device",
            token: "test-memory-token",
          },
        };
      if (action === "session") {
        sessions++;
        delivered = false;
        return { body: { sessionId: `session-${sessions}` } };
      }
      if (action === "poll") {
        if (delivered || body.ready === false)
          return { body: { command: null } };
        delivered = true;
        return {
          body: {
            command: {
              id: `command-${sessions}`,
              toolName: "echo",
              arguments: {
                text: sessions === 1 ? "__stop_fixture__" : "restarted",
              },
              expiresAt: new Date(Date.now() + 30_000).toISOString(),
            },
          },
        };
      }
      if (action === "result") {
        results.push(body);
        if (sessions === 2) setTimeout(() => controller.abort(), 50);
        return { body: {} };
      }
      throw new Error(`Unexpected action ${action}`);
    });
    const client = new DeviceMcpCompanion(url, "darwin");
    await client.pair("code", async () => true);
    await client.run(controller.signal);
    expect(sessions).toBe(2);
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      commandId: "command-1",
      result: { isError: true },
    });
    expect(results[1]).toMatchObject({
      commandId: "command-2",
      result: { structuredContent: { executionCount: 1 } },
    });
  });
});
