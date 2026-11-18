import { readFileSync } from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import { agentHandlers } from "./agent.ts";
import { inClusterApi, runningPodIp } from "./kubernetes.ts";
import { createReverseProxy, listen } from "./proxy.ts";

/**
 * The Archestra cluster agent.
 *
 * Runs in a Kubernetes cluster that an Archestra environment deploys into.
 * Archestra calls it with the agent's token:
 *
 * - its requests to this cluster's API server go through the agent, which
 *   sends them with its own ServiceAccount token, so Archestra holds no
 *   credential for the cluster itself;
 * - its connections to MCP server pods go from the agent to the pod.
 *
 * Pods in this cluster reach Archestra (Agent Runtime sessions calling the
 * LLM proxy and MCP gateway) at the agent's platform port, which forwards to
 * ARCHESTRA_URL.
 */

const token = required("ARCHESTRA_CLUSTER_AGENT_TOKEN");
const api = inClusterApi();
const namespaces = new Set(
  (process.env.ARCHESTRA_CLUSTER_AGENT_NAMESPACES || api.namespace)
    .split(",")
    .map((namespace) => namespace.trim())
    .filter(Boolean),
);
const port = Number(process.env.ARCHESTRA_CLUSTER_AGENT_PORT ?? 8443);

const handlers = agentHandlers({
  token,
  namespaces,
  resolvePodIp: (namespace, pod) => runningPodIp(api, namespace, pod),
  // Archestra's requests reach the API server with the agent's credential and
  // nothing it sent itself: no credential, no impersonation.
  kubernetes: {
    protocol: "https:",
    host: api.host,
    port: api.port,
    ca: api.ca,
    headers: () => ({ authorization: `Bearer ${api.token()}` }),
    dropHeaders: (name) =>
      name === "authorization" || name.startsWith("impersonate-"),
  },
});

// TLS when a certificate is mounted; otherwise plain HTTP, for a load
// balancer or ingress that terminates TLS in front of the agent.
const certFile = process.env.ARCHESTRA_CLUSTER_AGENT_TLS_CERT_FILE;
const keyFile = process.env.ARCHESTRA_CLUSTER_AGENT_TLS_KEY_FILE;
const server =
  certFile && keyFile
    ? https.createServer(
        { cert: readFileSync(certFile), key: readFileSync(keyFile) },
        handlers.request,
      )
    : http.createServer(handlers.request);
server.on("upgrade", handlers.upgrade);
await listen(server, port, "0.0.0.0");

// Pods in this cluster reach Archestra here. They bring their own
// credentials (session tokens), which pass unchanged.
const archestraUrl = process.env.ARCHESTRA_URL?.trim();
const platformPort = Number(
  process.env.ARCHESTRA_CLUSTER_AGENT_PLATFORM_PORT ?? 8080,
);
if (archestraUrl) {
  const url = new URL(archestraUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("ARCHESTRA_URL must be an http:// or https:// URL");
  }
  await listen(
    createReverseProxy({
      protocol: url.protocol,
      host: url.hostname.replace(/^\[|\]$/g, ""),
      port: Number(url.port || (url.protocol === "https:" ? 443 : 80)),
    }),
    platformPort,
    "0.0.0.0",
  );
}

log("cluster agent started", {
  port,
  tls: Boolean(certFile && keyFile),
  namespaces: [...namespaces],
  platformPort: archestraUrl ? platformPort : null,
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => process.exit(0));
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function log(message: string, fields: Record<string, unknown> = {}): void {
  process.stdout.write(
    `${JSON.stringify({ time: new Date().toISOString(), message, ...fields })}\n`,
  );
}
