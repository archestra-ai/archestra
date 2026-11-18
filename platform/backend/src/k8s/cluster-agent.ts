import * as net from "node:net";
import type { Duplex } from "node:stream";
import * as tls from "node:tls";

// === Public API ===

/**
 * How the platform reaches the cluster agent of an environment: the agent's
 * address and the token the agent was installed with. The agent runs in the
 * environment's cluster and acts there with its own ServiceAccount, so the
 * platform holds no credential for the cluster itself.
 */
export interface ClusterAgentEndpoint {
  url: string;
  token: string;
  /** PEM CA certificate that signs the agent's certificate, when not public. */
  ca?: string;
}

/**
 * The agent's address in one spelling: https, no query or fragment, no
 * trailing slash. Throws for anything else. Plain HTTP is refused: kubectl,
 * which the code sandbox uses, sends no token over it.
 */
export function normalizeClusterAgentUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error("The cluster agent address is not a URL.");
  }
  if (url.protocol !== "https:") {
    throw new Error("The cluster agent address must be an https:// URL.");
  }
  if (url.search || url.hash || url.username || url.password) {
    throw new Error(
      "The cluster agent address must not carry a query, a fragment or credentials.",
    );
  }
  url.hostname = url.hostname.toLowerCase();
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/** The secret stored for an environment reached through its cluster agent. */
export function clusterAgentSecretValue(credential: {
  token: string;
  ca?: string;
}): { clusterAgentToken: string; clusterAgentCa?: string } {
  return {
    clusterAgentToken: credential.token,
    ...(credential.ca ? { clusterAgentCa: credential.ca } : {}),
  };
}

/** The agent token and CA in a stored secret value; undefined when none. */
export function readClusterAgentCredential(
  value: unknown,
): { token: string; ca?: string } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { clusterAgentToken, clusterAgentCa } = value as Record<
    string,
    unknown
  >;
  if (typeof clusterAgentToken !== "string" || clusterAgentToken === "") {
    return undefined;
  }
  return {
    token: clusterAgentToken,
    ...(typeof clusterAgentCa === "string" && clusterAgentCa
      ? { ca: clusterAgentCa }
      : {}),
  };
}

/**
 * A kubeconfig whose API server is the agent: the agent serves the cluster's
 * API at `/k8s` and replaces the agent token with its own credential.
 */
export function clusterAgentKubeconfig(endpoint: ClusterAgentEndpoint): string {
  return [
    "apiVersion: v1",
    "kind: Config",
    "current-context: cluster-agent",
    "clusters:",
    "  - name: cluster-agent",
    "    cluster:",
    `      server: ${JSON.stringify(`${endpoint.url}/k8s`)}`,
    ...(endpoint.ca
      ? [
          `      certificate-authority-data: ${Buffer.from(endpoint.ca).toString("base64")}`,
        ]
      : []),
    "users:",
    "  - name: cluster-agent",
    "    user:",
    `      token: ${JSON.stringify(endpoint.token)}`,
    "contexts:",
    "  - name: cluster-agent",
    "    context:",
    "      cluster: cluster-agent",
    "      user: cluster-agent",
    "",
  ].join("\n");
}

/**
 * A raw byte stream to one port of one pod, opened by the agent from inside
 * its cluster: neither the pod network nor the API server is in the way.
 */
export function openClusterAgentPodStream(
  endpoint: ClusterAgentEndpoint,
  target: { namespace: string; pod: string; port: number },
): Promise<Duplex> {
  const url = new URL(endpoint.url);
  const secure = url.protocol === "https:";
  const port = Number(url.port || (secure ? 443 : 80));
  const ca = endpoint.ca;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const path = `${url.pathname.replace(/\/+$/, "")}/pods/${encodeURIComponent(target.namespace)}/${encodeURIComponent(target.pod)}/${target.port}`;

  return new Promise<Duplex>((resolve, reject) => {
    const socket = secure
      ? tls.connect({
          host,
          port,
          ca,
          servername: net.isIP(host) ? undefined : host,
        })
      : net.connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`The cluster agent at ${endpoint.url} did not answer`));
    }, POD_STREAM_TIMEOUT_MS);
    let received = Buffer.alloc(0);

    const onData = (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
      const end = received.indexOf("\r\n\r\n");
      if (end === -1) return;
      clearTimeout(timer);
      socket.off("data", onData);
      const head = received.subarray(0, end).toString("latin1");
      const rest = received.subarray(end + 4);
      const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(head)?.[1]);
      if (status !== 101) {
        socket.destroy();
        reject(
          new Error(
            `The cluster agent refused a stream to pod ${target.namespace}/${target.pod}:${target.port} (${status || "no status"})${rest.length > 0 ? `: ${rest.toString("utf8").trim()}` : ""}`,
          ),
        );
        return;
      }
      if (rest.length > 0) socket.unshift(rest);
      resolve(socket);
    };

    socket.once(secure ? "secureConnect" : "connect", () => {
      socket.write(
        [
          `GET ${path} HTTP/1.1`,
          `Host: ${url.host}`,
          `Authorization: Bearer ${endpoint.token}`,
          "Connection: Upgrade",
          `Upgrade: ${POD_STREAM_PROTOCOL}`,
          "",
          "",
        ].join("\r\n"),
      );
    });
    socket.on("data", onData);
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

// === Internal helpers ===

/** The upgrade the agent answers with a raw stream to a pod port. */
const POD_STREAM_PROTOCOL = "archestra-pod-stream";
const POD_STREAM_TIMEOUT_MS = 15_000;
