// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.

/**
 * Where permission sync dials the Perforce server.
 *
 * Content sync talks to the P4 REST API at the connector's `serverUrl`, and
 * `p4 webserver` is served by the p4d process itself — so the REST host IS
 * the p4d host unless a proxy sits in front of it. Permission sync needs the
 * wire address instead, which `p4 info` does not report (a stock server omits
 * `serverAddress` entirely). So the wire address is DERIVED here from
 * `serverUrl` and then VERIFIED by probing it from the shim
 * ({@link resolveP4Port} in `p4-shim-service`), rather than asked of the
 * operator and never checked.
 *
 * The connector's optional `p4Port` overrides the derivation, for split
 * topologies where the REST endpoint is genuinely not the p4d host (an
 * ingress or load balancer fronting only the web server).
 *
 * TLS is discovered, not configured: both candidates share one wire address,
 * so the `ssl:` prefix never changes the egress policy — only which handshake
 * `p4` performs. The probe order is a hint, not a decision.
 */

/** p4d's default wire port. The port in `serverUrl` is the web server's, never this one. */
const DEFAULT_P4_WIRE_PORT = 1666;

/** The TCP endpoint permission sync connects to, independent of transport. */
export interface P4WireAddress {
  /** Hostname or address, without IPv6 brackets (DNS-resolvable as-is). */
  host: string;
  port: number;
}

/**
 * The wire address for a connector: the explicit `p4Port` override when set,
 * otherwise the REST host at p4d's default port. Null when neither yields a
 * usable address.
 */
export function deriveP4WireAddress(params: {
  serverUrl: string;
  p4Port?: string;
}): P4WireAddress | null {
  if (params.p4Port) {
    const override = parseP4Port(params.p4Port);
    return override ? { host: override.host, port: override.port } : null;
  }
  const host = restHost(params.serverUrl);
  return host ? { host, port: DEFAULT_P4_WIRE_PORT } : null;
}

/**
 * The `[ssl:]host:port` strings to probe, in order. Always both transports
 * for the one wire address: an operator who omitted (or wrongly guessed) the
 * `ssl:` prefix gets a working connector instead of a connection error, and
 * a server that switches to SSL keeps working without a config edit.
 */
export function p4PortCandidates(params: {
  serverUrl: string;
  p4Port?: string;
}): string[] {
  const address = deriveP4WireAddress(params);
  if (!address) return [];
  // Prefer the transport the configuration hints at: an explicit `ssl:`
  // prefix, else the REST URL's own scheme.
  const sslFirst = params.p4Port
    ? (parseP4Port(params.p4Port)?.ssl ?? false)
    : restIsHttps(params.serverUrl);
  return sslFirst
    ? [formatP4Port(address, true), formatP4Port(address, false)]
    : [formatP4Port(address, false), formatP4Port(address, true)];
}

/** `[ssl:]host:port` for an address, bracketing IPv6 hosts as `p4` expects. */
function formatP4Port(address: P4WireAddress, ssl: boolean): string {
  const host = address.host.includes(":") ? `[${address.host}]` : address.host;
  return `${ssl ? "ssl:" : ""}${host}:${address.port}`;
}

/**
 * Server-scoping token for synthetic Perforce group ids. Group ACL tokens
 * embed only the connector TYPE (`group:perforce_<groupId>`), so a bare group
 * name would collide across two Perforce servers and cross-grant at query
 * time. Built from the wire address alone — never the transport — so the
 * plain/SSL probe outcome can flip without re-identifying every group.
 */
export function p4ServerScope(address: P4WireAddress): string {
  return `${address.host.toLowerCase()}:${address.port}`;
}

// ===== Internal helpers =====

const P4PORT_PATTERN = /^(ssl:)?(\[[^\]]+\]|[A-Za-z0-9_.-]+):(\d{1,5})$/;

/** `[ssl:]host:port` → its parts, or null when malformed. */
function parseP4Port(
  p4port: string,
): { host: string; port: number; ssl: boolean } | null {
  const match = P4PORT_PATTERN.exec(p4port.trim());
  if (!match) return null;
  const port = Number(match[3]);
  if (port < 1 || port > 65535) return null;
  return {
    host: match[2].replace(/^\[|\]$/g, ""),
    port,
    ssl: Boolean(match[1]),
  };
}

function restUrl(serverUrl: string): URL | null {
  try {
    return new URL(serverUrl);
  } catch {
    return null;
  }
}

function restHost(serverUrl: string): string | null {
  const url = restUrl(serverUrl);
  if (!url?.hostname) return null;
  return url.hostname.replace(/^\[|\]$/g, "");
}

function restIsHttps(serverUrl: string): boolean {
  return restUrl(serverUrl)?.protocol === "https:";
}
