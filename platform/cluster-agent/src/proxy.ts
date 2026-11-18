import type {
  IncomingHttpHeaders,
  IncomingMessage,
  OutgoingHttpHeaders,
  ServerResponse,
} from "node:http";
import * as http from "node:http";
import * as https from "node:https";
import * as net from "node:net";
import type { Duplex } from "node:stream";
import * as tls from "node:tls";

/** Where a reverse proxy sends what it receives. */
export interface ProxyTarget {
  protocol: "http:" | "https:";
  host: string;
  port: number;
  /** CA bundle that signs an https target's certificate. */
  ca?: Buffer;
  /**
   * Headers set on every request, read per request so a rotating credential
   * is always current. They replace what the client sent under those names.
   */
  headers?: () => Record<string, string>;
  /** Header names (lower case) removed from what the client sent. */
  dropHeaders?: (name: string) => boolean;
}

/**
 * Forward one request to `target` at `path`, streaming both bodies. It does
 * not interpret what it forwards.
 */
export function proxyRequest(
  target: ProxyTarget,
  request: IncomingMessage,
  response: ServerResponse,
  path: string,
): void {
  const upstream = (target.protocol === "https:" ? https : http).request(
    {
      host: target.host,
      port: target.port,
      method: request.method,
      path,
      headers: upstreamHeaders(request.headers, target, false),
      ca: target.ca,
      servername: serverName(target.host),
    },
    (answer) => {
      const headers: OutgoingHttpHeaders = { ...answer.headers };
      delete headers.connection;
      response.writeHead(answer.statusCode ?? 502, headers);
      answer.pipe(response);
    },
  );
  upstream.on("error", () => {
    if (!response.headersSent) response.writeHead(502);
    response.end();
  });
  request.pipe(upstream);
}

/**
 * Forward a connection upgrade (WebSocket, SPDY) to `target` at `path`, then
 * carry the connection as a raw byte stream both ways.
 */
export function proxyUpgrade(
  target: ProxyTarget,
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  path: string,
): void {
  const upstream =
    target.protocol === "https:"
      ? tls.connect({
          host: target.host,
          port: target.port,
          ca: target.ca,
          servername: serverName(target.host),
        })
      : net.connect({ host: target.host, port: target.port });
  const close = () => {
    socket.destroy();
    upstream.destroy();
  };
  upstream.once(
    target.protocol === "https:" ? "secureConnect" : "connect",
    () => {
      const lines = [`${request.method} ${path} HTTP/1.1`];
      for (const [name, value] of Object.entries(
        upstreamHeaders(request.headers, target, true),
      )) {
        for (const item of Array.isArray(value) ? value : [value]) {
          if (item !== undefined) lines.push(`${name}: ${item}`);
        }
      }
      upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (head.length > 0) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    },
  );
  upstream.on("error", close);
  socket.on("error", close);
  upstream.on("close", close);
  socket.on("close", close);
}

/** A server that forwards everything it receives to one target. */
export function createReverseProxy(target: ProxyTarget): http.Server {
  const server = http.createServer((request, response) =>
    proxyRequest(target, request, response, request.url ?? "/"),
  );
  server.on("upgrade", (request, socket: Duplex, head: Buffer) =>
    proxyUpgrade(target, request, socket, head, request.url ?? "/"),
  );
  return server;
}

/** Start `server` on the given host and port (0: any free port). */
export function listen(
  server: net.Server,
  port: number,
  host: string,
): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      resolve((server.address() as net.AddressInfo).port);
    });
  });
}

// === Internal helpers ===

/** Headers that belong to one connection and are never forwarded as such. */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function upstreamHeaders(
  incoming: IncomingHttpHeaders,
  target: ProxyTarget,
  upgrade: boolean,
): OutgoingHttpHeaders {
  const headers: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(incoming)) {
    if (value === undefined) continue;
    // An upgrade keeps Connection and Upgrade: they are the request.
    if (!upgrade && HOP_BY_HOP.has(name)) continue;
    if (target.dropHeaders?.(name)) continue;
    headers[name] = value;
  }
  headers.host = hostHeader(target);
  for (const [name, value] of Object.entries(target.headers?.() ?? {})) {
    headers[name.toLowerCase()] = value;
  }
  return headers;
}

function hostHeader(target: ProxyTarget): string {
  const host = net.isIPv6(target.host) ? `[${target.host}]` : target.host;
  const defaultPort = target.protocol === "https:" ? 443 : 80;
  return target.port === defaultPort ? host : `${host}:${target.port}`;
}

/** TLS server name: only a host name, never an IP address. */
function serverName(host: string): string | undefined {
  return net.isIP(host) ? undefined : host;
}
