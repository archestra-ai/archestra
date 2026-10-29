import { readFileSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { Agent, createServer, request as httpsRequest } from "node:https";
import type { Socket } from "node:net";
import { SLACK_REQUIRED_BOT_SCOPES } from "@archestra/shared";
import { http, passthrough } from "msw";
import { vi } from "vitest";
import { WebSocketServer } from "ws";

/** Local TCP/WS dependency fixture; MSW forwards the real Slack SDK HTTP calls. */
export async function createSlackSocketFixture() {
  let stalledMethod: string | undefined;
  let dribblingMethod: string | undefined;
  let abortedDribbles = 0;
  let dribbleWrites = 0;
  const clientSockets = new Set<import("node:stream").Duplex>();
  let fixturePort: number;
  let stallHandshake = false;
  let dropHelloAndClose = false;
  const certificate = readFileSync(
    new URL("./fixtures/slack-socket/cert.pem", import.meta.url),
  );
  const key = readFileSync(
    new URL("./fixtures/slack-socket/key.pem", import.meta.url),
  );
  const createConnection = Agent.prototype.createConnection;
  // Trust only this fixture certificate, while keeping real TLS verification.
  const trust = vi
    .spyOn(Agent.prototype, "createConnection")
    .mockImplementation(function (this: Agent, options, callback) {
      const socket = createConnection.call(
        this,
        options.host === "slack.com" && dribblingMethod
          ? {
              ...options,
              host: "127.0.0.1",
              port: fixturePort,
              servername: "localhost",
              ca: certificate,
            }
          : options.host === "127.0.0.1"
            ? { ...options, ca: certificate }
            : options,
        callback,
      );
      if (socket) clientSockets.add(socket);
      return socket;
    });
  const connectionFailures: { status: number; retryAfter: number }[] = [];
  let connections = 0;
  const calls: string[] = [];
  const pending: (() => void)[] = [];
  const sockets = new Set<Socket>();
  const websocket = new WebSocketServer({ noServer: true });
  const server = createServer(
    { key, cert: certificate },
    (request, response) => {
      const method = request.url?.split("/").pop() ?? "";
      calls.push(method);
      const send = () => {
        if (method === "apps.connections.open" && connectionFailures.length) {
          const failure = connectionFailures.shift();
          response.writeHead(failure?.status ?? 503, {
            "Retry-After": String(failure?.retryAfter ?? 1),
          });
          response.end("temporary failure");
          return;
        }
        const body: Record<string, unknown> = { ok: true };
        if (method === "auth.test") {
          Object.assign(body, {
            user_id: "UBOT_TEST",
            user: "test-bot",
            team_id: "T_TEST",
            team: "Fixture",
          });
        } else if (method === "users.info") {
          body.user = { name: "test-bot", real_name: "Test Bot" };
        } else if (method === "apps.connections.open") {
          body.url = `${origin.replace("https:", "wss:")}/socket`;
        } else if (method === "conversations.list") {
          body.channels = [];
        }
        respond(response, body);
      };
      if (method === dribblingMethod) {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.write('{"ok":false,"error":"invalid_auth","padding":"');
        const interval = setInterval(() => {
          dribbleWrites++;
          response.write(" ");
        }, 100);
        response.on("close", () => {
          clearInterval(interval);
          if (!response.writableEnded) abortedDribbles++;
        });
        pending.push(() => {
          clearInterval(interval);
          response.end('"}');
        });
      } else if (method === stalledMethod) {
        pending.push(send);
      } else send();
    },
  );
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.on("upgrade", (request, socket, head) => {
    const upgrade = () =>
      websocket.handleUpgrade(request, socket, head, (client) => {
        connections++;
        if (dropHelloAndClose) socket.pause();
        else client.send(JSON.stringify({ type: "hello" }));
      });
    if (stallHandshake) pending.push(upgrade);
    else upgrade();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("No fixture port");
  fixturePort = address.port;
  const origin = `https://127.0.0.1:${address.port}`;
  return {
    handlers: [
      http.post(
        "https://slack.com/api/:method",
        ({ params }) =>
          new Promise<Response>((resolve, reject) => {
            const request = httpsRequest(
              `${origin}/api/${params.method}`,
              { method: "POST", ca: certificate },
              (response) => {
                const chunks: Buffer[] = [];
                response.on("data", (chunk) => chunks.push(chunk));
                response.on("end", () =>
                  resolve(
                    new Response(Buffer.concat(chunks), {
                      status: response.statusCode,
                      headers: {
                        "Content-Type": "application/json",
                        "x-oauth-scopes": SLACK_REQUIRED_BOT_SCOPES.join(","),
                        ...(response.headers["retry-after"] && {
                          "Retry-After": response.headers["retry-after"],
                        }),
                      },
                    }),
                  ),
                );
              },
            );
            request.on("error", reject);
            request.end();
          }),
      ),
      http.all(`${origin}/api/:method`, () => passthrough()),
      http.get(`${origin}/socket`, () => passthrough()),
    ],
    calls,
    get abortedDribbles() {
      return abortedDribbles;
    },
    get dribbleWrites() {
      return dribbleWrites;
    },
    dribble(method: string) {
      dribblingMethod = method;
    },
    get connections() {
      return connections;
    },
    stall(method: string) {
      stalledMethod = method;
    },
    dropHelloAndClose() {
      dropHelloAndClose = true;
    },
    stallHandshake() {
      stallHandshake = true;
    },
    release() {
      stalledMethod = undefined;
      stallHandshake = false;
      dropHelloAndClose = false;
      for (const send of pending.splice(0)) send();
    },
    failNextConnection(status = 503, retryAfter = 1) {
      connectionFailures.push({ status, retryAfter });
    },
    disconnect() {
      for (const socket of websocket.clients) socket.terminate();
    },
    async close() {
      trust.mockRestore();
      for (const socket of clientSockets) socket.destroy();
      for (const socket of websocket.clients) socket.terminate();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => websocket.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function respond(response: ServerResponse, body: Record<string, unknown>) {
  response.writeHead(200, {
    "Content-Type": "application/json",
    "x-oauth-scopes": SLACK_REQUIRED_BOT_SCOPES.join(","),
  });
  response.end(JSON.stringify(body));
}
