import { createServer, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { SLACK_REQUIRED_BOT_SCOPES } from "@archestra/shared";
import { vi } from "vitest";
import { WebSocketServer } from "ws";

/** Only SDK constructor options read this test-local endpoint. */
export const slackSocketBoundary = { apiUrl: undefined as string | undefined };

/** Plain loopback HTTP/WS; real Slack SDK and fetch requests reach the fixture. */
export async function createSlackSocketFixture() {
  let stalledMethod: string | undefined;
  let dribblingMethod: string | undefined;
  let abortedDribbles = 0;
  let dribbleWrites = 0;
  let abortedRequests = 0;
  let stallHandshake = false;
  let dropHelloAndClose = false;
  let closeBeforeHello = false;
  const connectionFailures: {
    status: number;
    retryAfter: number;
    error?: string;
  }[] = [];
  let connections = 0;
  const calls: string[] = [];
  const pending: (() => void)[] = [];
  const sockets = new Set<Socket>();
  const websocket = new WebSocketServer({ noServer: true });
  const server = createServer((request, response) => {
    const method = request.url?.split("/").pop() ?? "";
    calls.push(method);
    response.on("close", () => {
      if (!response.writableEnded) abortedRequests++;
    });
    const send = () => {
      if (method === "apps.connections.open" && connectionFailures.length) {
        const failure = connectionFailures.shift();
        if (failure?.error) {
          respond(response, { ok: false, error: failure.error });
          return;
        }
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
        body.url = `${origin.replace("http:", "ws:")}/socket`;
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
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.on("upgrade", (request, socket, head) => {
    const upgrade = () =>
      websocket.handleUpgrade(request, socket, head, (client) => {
        connections++;
        if (closeBeforeHello) {
          closeBeforeHello = false;
          stalledMethod = "apps.connections.open";
          client.close();
        } else if (dropHelloAndClose) socket.pause();
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
  const origin = `http://127.0.0.1:${address.port}`;
  slackSocketBoundary.apiUrl = `${origin}/api/`;
  const originalFetch = globalThis.fetch;
  vi.stubGlobal("fetch", (input: RequestInfo | URL, options?: RequestInit) =>
    originalFetch(
      typeof input === "string"
        ? input.replace("https://slack.com/api/", `${origin}/api/`)
        : input,
      options,
    ),
  );
  return {
    calls,
    get abortedRequests() {
      return abortedRequests;
    },
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
    closeBeforeHello() {
      closeBeforeHello = true;
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
    rejectNextConnection(error = "internal_error") {
      connectionFailures.push({ status: 200, retryAfter: 0, error });
    },
    disconnect() {
      for (const socket of websocket.clients) socket.terminate();
    },
    async close() {
      slackSocketBoundary.apiUrl = undefined;
      vi.stubGlobal("fetch", originalFetch);
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
