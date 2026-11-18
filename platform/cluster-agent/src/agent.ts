import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import * as net from "node:net";
import type { Duplex } from "node:stream";
import { type ProxyTarget, proxyRequest, proxyUpgrade } from "./proxy.ts";

/** The upgrade token Archestra asks for to get a raw stream to a pod port. */
export const POD_STREAM_PROTOCOL = "archestra-pod-stream";

export interface AgentOptions {
  /** The token Archestra presents; every request but /healthz needs it. */
  token: string;
  /** This cluster's API server, reached with the agent's own credential. */
  kubernetes: ProxyTarget;
  /** Namespaces whose pods streams may lead to. */
  namespaces: ReadonlySet<string>;
  /** The IP address of a running pod. */
  resolvePodIp: (namespace: string, pod: string) => Promise<string>;
}

/**
 * The agent's endpoint, which Archestra calls:
 *
 * - `GET /healthz`: unauthenticated liveness.
 * - `/k8s/...`: this cluster's API server. The agent replaces Archestra's
 *   credential with its own ServiceAccount's; what Archestra may do is what
 *   the agent's Role allows. Upgrades (attach, exec, watch streams) pass.
 * - `/pods/<namespace>/<pod>/<port>` with `Upgrade: archestra-pod-stream`:
 *   a raw byte stream to that pod port, which the agent connects to inside
 *   its cluster. Only the served namespaces.
 *
 * Nothing else: the agent is not an open proxy into the cluster.
 */
export function agentHandlers(options: AgentOptions): {
  request: (request: IncomingMessage, response: ServerResponse) => void;
  upgrade: (request: IncomingMessage, socket: Duplex, head: Buffer) => void;
} {
  const authorized = tokenCheck(options.token);
  return {
    request(request, response) {
      const path = request.url ?? "/";
      if (path === "/healthz") {
        response.writeHead(200).end("ok");
        return;
      }
      if (!authorized(request)) {
        response.writeHead(401).end();
        return;
      }
      const kubernetesPath = stripPrefix(path, "/k8s");
      if (kubernetesPath === undefined) {
        response.writeHead(404).end();
        return;
      }
      proxyRequest(options.kubernetes, request, response, kubernetesPath);
    },

    upgrade(request, socket, head) {
      if (!authorized(request)) {
        refuse(socket, 401, "Unauthorized");
        return;
      }
      const path = request.url ?? "/";
      const kubernetesPath = stripPrefix(path, "/k8s");
      if (kubernetesPath !== undefined) {
        proxyUpgrade(options.kubernetes, request, socket, head, kubernetesPath);
        return;
      }
      const pod = parsePodPath(path);
      if (
        !pod ||
        request.headers.upgrade?.toLowerCase() !== POD_STREAM_PROTOCOL
      ) {
        refuse(socket, 404, "Not Found");
        return;
      }
      if (!options.namespaces.has(pod.namespace)) {
        refuse(socket, 403, "Forbidden");
        return;
      }
      void openPodStream(options, pod, socket, head);
    },
  };
}

/** `/pods/<namespace>/<pod>/<port>`; undefined for any other path. */
export function parsePodPath(
  path: string,
): { namespace: string; pod: string; port: number } | undefined {
  // Kubernetes names: lower-case letters, digits, '-' (and '.' in pod
  // names), starting and ending with a letter or digit.
  const match =
    /^\/pods\/([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\/([a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?)\/(\d{1,5})$/.exec(
      path,
    );
  if (!match) return undefined;
  const port = Number(match[3]);
  if (port < 1 || port > 65_535) return undefined;
  return { namespace: match[1], pod: match[2], port };
}

// === Internal helpers ===

const DIAL_TIMEOUT_MS = 10_000;

async function openPodStream(
  options: AgentOptions,
  pod: { namespace: string; pod: string; port: number },
  socket: Duplex,
  head: Buffer,
): Promise<void> {
  let upstream: net.Socket;
  try {
    const ip = await options.resolvePodIp(pod.namespace, pod.pod);
    upstream = await connect(ip, pod.port);
  } catch (error) {
    refuse(socket, 502, "Bad Gateway", String((error as Error).message));
    return;
  }
  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\nUpgrade: ${POD_STREAM_PROTOCOL}\r\nConnection: Upgrade\r\n\r\n`,
  );
  if (head.length > 0) upstream.write(head);
  const close = () => {
    socket.destroy();
    upstream.destroy();
  };
  socket.pipe(upstream).pipe(socket);
  socket.on("error", close);
  upstream.on("error", close);
  socket.on("close", close);
  upstream.on("close", close);
}

function connect(host: string, port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`${host}:${port} did not accept a connection in time`));
    }, DIAL_TIMEOUT_MS);
    socket.once("connect", () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

/** Compares the presented bearer token in constant time. */
function tokenCheck(token: string): (request: IncomingMessage) => boolean {
  const expected = digest(token);
  return (request) => {
    const match = /^Bearer (.+)$/.exec(request.headers.authorization ?? "");
    return match !== null && timingSafeEqual(digest(match[1]), expected);
  };
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function stripPrefix(path: string, prefix: string): string | undefined {
  if (path === prefix) return "/";
  if (path.startsWith(`${prefix}/`) || path.startsWith(`${prefix}?`)) {
    return path.slice(prefix.length) || "/";
  }
  return undefined;
}

function refuse(
  socket: Duplex,
  status: number,
  reason: string,
  body = "",
): void {
  socket.end(
    `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
  );
}
