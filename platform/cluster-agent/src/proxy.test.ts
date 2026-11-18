import * as http from "node:http";
import * as net from "node:net";
import { afterEach, describe, expect, test } from "vitest";
import { createReverseProxy, listen } from "./proxy.ts";

const servers: (http.Server | net.Server)[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise((resolve) => server.close(resolve));
  }
});

async function upstream(
  handler: http.RequestListener,
): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer(handler);
  servers.push(server);
  const port = await listen(server, 0, "127.0.0.1");
  return { server, port };
}

function get(
  port: number,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get(
        { host: "127.0.0.1", port, path: "/api/v1/pods", headers },
        (res) => {
          let body = "";
          res.on("data", (chunk) => {
            body += chunk;
          });
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        },
      )
      .on("error", reject);
  });
}

describe("createReverseProxy", () => {
  test("sends its own credential and none the caller sent", async () => {
    const seen: http.IncomingHttpHeaders[] = [];
    const target = await upstream((request, response) => {
      seen.push(request.headers);
      response.end("ok");
    });
    const proxy = createReverseProxy({
      protocol: "http:",
      host: "127.0.0.1",
      port: target.port,
      headers: () => ({ authorization: "Bearer agent-token" }),
      dropHeaders: (name) =>
        name === "authorization" || name.startsWith("impersonate-"),
    });
    servers.push(proxy);
    const port = await listen(proxy, 0, "127.0.0.1");

    const answer = await get(port, {
      authorization: "Bearer caller-token",
      "impersonate-user": "system:admin",
      accept: "application/json",
    });

    expect(answer).toEqual({ status: 200, body: "ok" });
    expect(seen[0].authorization).toBe("Bearer agent-token");
    expect(seen[0]["impersonate-user"]).toBeUndefined();
    expect(seen[0].accept).toBe("application/json");
  });

  test("passes the caller's own credential when it adds none", async () => {
    const seen: http.IncomingHttpHeaders[] = [];
    const target = await upstream((request, response) => {
      seen.push(request.headers);
      response.end("ok");
    });
    const proxy = createReverseProxy({
      protocol: "http:",
      host: "127.0.0.1",
      port: target.port,
    });
    servers.push(proxy);
    const port = await listen(proxy, 0, "127.0.0.1");

    await get(port, { authorization: "Bearer session-token" });

    expect(seen[0].authorization).toBe("Bearer session-token");
  });

  test("forwards a connection upgrade as a byte stream", async () => {
    const target = await upstream(() => {});
    target.server.on("upgrade", (request, socket) => {
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: test\r\nConnection: Upgrade\r\nX-Auth: ${request.headers.authorization}\r\n\r\n`,
      );
      socket.pipe(socket);
    });
    const proxy = createReverseProxy({
      protocol: "http:",
      host: "127.0.0.1",
      port: target.port,
      headers: () => ({ authorization: "Bearer agent-token" }),
    });
    servers.push(proxy);
    const port = await listen(proxy, 0, "127.0.0.1");

    const received = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(port, "127.0.0.1", () => {
        socket.write(
          "GET /exec HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: test\r\n\r\n",
        );
      });
      let data = "";
      socket.on("data", (chunk) => {
        data += chunk.toString();
        if (data.includes("\r\n\r\n") && !data.includes("echo")) {
          socket.write("echo");
        }
        if (data.endsWith("echo")) {
          socket.destroy();
          resolve(data);
        }
      });
      socket.on("error", reject);
    });

    expect(received).toContain("101 Switching Protocols");
    expect(received).toContain("X-Auth: Bearer agent-token");
    expect(received.endsWith("echo")).toBe(true);
  });
});
