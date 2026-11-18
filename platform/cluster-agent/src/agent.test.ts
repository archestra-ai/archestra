import * as http from "node:http";
import * as net from "node:net";
import { afterEach, describe, expect, test } from "vitest";
import { agentHandlers, POD_STREAM_PROTOCOL, parsePodPath } from "./agent.ts";
import { listen } from "./proxy.ts";

const TOKEN = "agent-token-for-tests";
const servers: net.Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise((resolve) => server.close(resolve));
  }
});

/** A stand-in API server that records what reaches it. */
async function fakeApiServer(): Promise<{
  port: number;
  seen: { url?: string; headers: http.IncomingHttpHeaders }[];
}> {
  const seen: { url?: string; headers: http.IncomingHttpHeaders }[] = [];
  const server = http.createServer((request, response) => {
    seen.push({ url: request.url, headers: request.headers });
    response.end("api");
  });
  servers.push(server);
  return { port: await listen(server, 0, "127.0.0.1"), seen };
}

async function startAgent(apiPort: number, podPort: number): Promise<number> {
  const handlers = agentHandlers({
    token: TOKEN,
    namespaces: new Set(["mcp"]),
    resolvePodIp: async () => "127.0.0.1",
    kubernetes: {
      protocol: "http:",
      host: "127.0.0.1",
      port: apiPort,
      headers: () => ({ authorization: "Bearer service-account-token" }),
      dropHeaders: (name) =>
        name === "authorization" || name.startsWith("impersonate-"),
    },
  });
  const server = http.createServer(handlers.request);
  server.on("upgrade", handlers.upgrade);
  servers.push(server);
  void podPort;
  return listen(server, 0, "127.0.0.1");
}

function get(
  port: number,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port, path, headers }, (response) => {
        let body = "";
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () =>
          resolve({ status: response.statusCode ?? 0, body }),
        );
      })
      .on("error", reject);
  });
}

/** Open a pod stream through the agent and send `message` on it. */
function podStream(
  port: number,
  path: string,
  token: string,
  message: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => {
      socket.write(
        `GET ${path} HTTP/1.1\r\nHost: agent\r\nAuthorization: Bearer ${token}\r\nConnection: Upgrade\r\nUpgrade: ${POD_STREAM_PROTOCOL}\r\n\r\n`,
      );
    });
    let data = "";
    socket.on("data", (chunk) => {
      data += chunk.toString();
      if (data.includes("101 Switching Protocols") && !data.includes(message)) {
        socket.write(message);
      }
      if (data.endsWith(message) || !data.startsWith("HTTP/1.1 101")) {
        if (data.includes("\r\n\r\n")) {
          socket.destroy();
          resolve(data);
        }
      }
    });
    socket.on("error", reject);
  });
}

describe("cluster agent", () => {
  test("answers health checks without a token", async () => {
    const api = await fakeApiServer();
    const port = await startAgent(api.port, 0);
    expect(await get(port, "/healthz")).toEqual({ status: 200, body: "ok" });
  });

  test("refuses requests without the agent's token", async () => {
    const api = await fakeApiServer();
    const port = await startAgent(api.port, 0);
    expect((await get(port, "/k8s/api/v1/pods")).status).toBe(401);
    expect(
      (await get(port, "/k8s/api/v1/pods", { authorization: "Bearer wrong" }))
        .status,
    ).toBe(401);
    expect(api.seen).toHaveLength(0);
  });

  test("sends API calls with its own credential and none of Archestra's", async () => {
    const api = await fakeApiServer();
    const port = await startAgent(api.port, 0);
    const answer = await get(port, "/k8s/api/v1/namespaces/mcp/pods?watch=1", {
      authorization: `Bearer ${TOKEN}`,
      "impersonate-user": "system:admin",
    });
    expect(answer).toEqual({ status: 200, body: "api" });
    expect(api.seen[0].url).toBe("/api/v1/namespaces/mcp/pods?watch=1");
    expect(api.seen[0].headers.authorization).toBe(
      "Bearer service-account-token",
    );
    expect(api.seen[0].headers["impersonate-user"]).toBeUndefined();
  });

  test("leads nowhere but the API server and pods", async () => {
    const api = await fakeApiServer();
    const port = await startAgent(api.port, 0);
    expect(
      (await get(port, "/other", { authorization: `Bearer ${TOKEN}` })).status,
    ).toBe(404);
  });

  test("streams to a pod port in a served namespace", async () => {
    const echo = net.createServer((socket) => socket.pipe(socket));
    servers.push(echo);
    const echoPort = await listen(echo, 0, "127.0.0.1");
    const api = await fakeApiServer();
    const port = await startAgent(api.port, echoPort);

    const answer = await podStream(
      port,
      `/pods/mcp/server-1/${echoPort}`,
      TOKEN,
      "ping",
    );
    expect(answer).toContain("101 Switching Protocols");
    expect(answer.endsWith("ping")).toBe(true);
  });

  test("refuses a pod stream in a namespace it does not serve", async () => {
    const api = await fakeApiServer();
    const port = await startAgent(api.port, 0);
    const answer = await podStream(
      port,
      "/pods/kube-system/etcd/2379",
      TOKEN,
      "ping",
    );
    expect(answer).toContain("403 Forbidden");
  });
});

describe("parsePodPath", () => {
  test("reads namespace, pod and port", () => {
    expect(parsePodPath("/pods/mcp/server-1/8080")).toEqual({
      namespace: "mcp",
      pod: "server-1",
      port: 8080,
    });
  });

  test("refuses anything else", () => {
    for (const path of [
      "/pods/mcp/server-1/0",
      "/pods/mcp/server-1/70000",
      "/pods/MCP/server-1/8080",
      "/pods/mcp/../8080",
      "/pods/mcp/server-1",
    ]) {
      expect(parsePodPath(path)).toBeUndefined();
    }
  });
});
