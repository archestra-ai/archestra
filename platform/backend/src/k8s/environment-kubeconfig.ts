import { createHash, createPrivateKey, X509Certificate } from "node:crypto";
import * as yaml from "js-yaml";

// === Public API ===

/** A kubeconfig an environment may be bound to, reduced to what is used. */
export interface EnvironmentKubeconfig {
  /**
   * The document that is stored, handed to the Kubernetes client and written
   * for kubectl: only the selected cluster, user and context.
   */
  normalized: string;
  /** The cluster's API server URL, shown to administrators. */
  server: string;
  /**
   * Identifies the cluster the kubeconfig points at, apart from the
   * credential: equal for two kubeconfigs that differ only in their token or
   * client certificate.
   */
  clusterIdentity: string;
}

/** Why a pasted kubeconfig cannot be used; the message is shown to the administrator. */
export class EnvironmentKubeconfigError extends Error {}

/**
 * Validate a pasted kubeconfig and reduce it to its current context.
 *
 * Credentials must be inline. A kubeconfig can otherwise run a program on the
 * platform (`exec`, `auth-provider`), read platform files (certificate and
 * token paths), or send API traffic through a third host (`proxy-url`), and
 * the same document is later handed to kubectl. Fields outside the short
 * lists below are rejected rather than ignored, so a field this code does not
 * know cannot change how the cluster is reached.
 */
export function parseEnvironmentKubeconfig(
  content: string,
): EnvironmentKubeconfig {
  if (Buffer.byteLength(content, "utf8") > MAX_KUBECONFIG_BYTES) {
    throw new EnvironmentKubeconfigError(
      `The kubeconfig is larger than ${MAX_KUBECONFIG_BYTES / 1024} KiB.`,
    );
  }

  let document: unknown;
  try {
    document = yaml.load(content, { schema: yaml.JSON_SCHEMA });
  } catch {
    throw new EnvironmentKubeconfigError("The kubeconfig is not valid YAML.");
  }
  if (!isRecord(document)) {
    throw new EnvironmentKubeconfigError(
      "The kubeconfig must be a YAML mapping.",
    );
  }

  const currentContext = document["current-context"];
  if (typeof currentContext !== "string" || currentContext.length === 0) {
    throw new EnvironmentKubeconfigError(
      "The kubeconfig has no current-context.",
    );
  }

  const context = findNamed(document.contexts, currentContext, "context");
  if (!context) {
    throw new EnvironmentKubeconfigError(
      `The kubeconfig has no context named "${currentContext}".`,
    );
  }
  rejectUnknownFields(context, CONTEXT_FIELDS, "context");
  const clusterName = requireString(context.cluster, "context.cluster");
  const userName = requireString(context.user, "context.user");

  const cluster = findNamed(document.clusters, clusterName, "cluster");
  if (!cluster) {
    throw new EnvironmentKubeconfigError(
      `The kubeconfig has no cluster named "${clusterName}".`,
    );
  }
  rejectUnknownFields(cluster, CLUSTER_FIELDS, "cluster");
  const server = parseServer(cluster.server);
  const certificateAuthorityData =
    cluster["certificate-authority-data"] === undefined
      ? undefined
      : requirePem(
          cluster["certificate-authority-data"],
          "cluster.certificate-authority-data",
          "CERTIFICATE",
        );

  const user = findNamed(document.users, userName, "user");
  if (!user) {
    throw new EnvironmentKubeconfigError(
      `The kubeconfig has no user named "${userName}".`,
    );
  }
  rejectUnknownFields(user, USER_FIELDS, "user");
  const credential = parseCredential(user);

  const normalized = yaml.dump(
    {
      apiVersion: "v1",
      kind: "Config",
      "current-context": NORMALIZED_NAME,
      clusters: [
        {
          name: NORMALIZED_NAME,
          cluster: {
            server,
            ...(certificateAuthorityData && {
              "certificate-authority-data": certificateAuthorityData,
            }),
          },
        },
      ],
      users: [{ name: NORMALIZED_NAME, user: credential }],
      contexts: [
        {
          name: NORMALIZED_NAME,
          context: { cluster: NORMALIZED_NAME, user: NORMALIZED_NAME },
        },
      ],
    },
    { lineWidth: -1 },
  );

  return {
    normalized,
    server,
    clusterIdentity: createHash("sha256")
      .update(server)
      .update("\n")
      .update(certificateAuthorityData ?? "")
      .digest("hex"),
  };
}

// === Internal helpers ===

const MAX_KUBECONFIG_BYTES = 64 * 1024;
const NORMALIZED_NAME = "environment";

const CONTEXT_FIELDS = new Set(["cluster", "user", "namespace"]);
const CLUSTER_FIELDS = new Set(["server", "certificate-authority-data"]);
const USER_FIELDS = new Set([
  "token",
  "client-certificate-data",
  "client-key-data",
]);

/** What to tell the administrator about a field that is refused on purpose. */
const REJECTED_FIELD_REASONS: Record<string, string> = {
  exec: "credential plugins would run a program on the platform",
  "auth-provider": "credential plugins would run a program on the platform",
  "certificate-authority":
    "file paths are not available to the platform; use certificate-authority-data",
  "client-certificate":
    "file paths are not available to the platform; use client-certificate-data",
  "client-key":
    "file paths are not available to the platform; use client-key-data",
  tokenFile: "file paths are not available to the platform; use token",
  "insecure-skip-tls-verify":
    "the API server's certificate must be verified; set certificate-authority-data",
  "proxy-url": "API traffic must go straight to the cluster",
  username: "use a token or a client certificate",
  password: "use a token or a client certificate",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The body of the `name`d entry of a kubeconfig `clusters`/`users`/`contexts` list. */
function findNamed(
  list: unknown,
  name: string,
  kind: "cluster" | "user" | "context",
): Record<string, unknown> | undefined {
  if (!Array.isArray(list)) return undefined;
  const matches = list.filter(
    (entry): entry is Record<string, unknown> =>
      isRecord(entry) && entry.name === name,
  );
  if (matches.length === 0) return undefined;
  if (matches.length > 1) {
    throw new EnvironmentKubeconfigError(
      `The kubeconfig has more than one ${kind} named "${name}".`,
    );
  }
  const body = matches[0][kind];
  if (!isRecord(body)) {
    throw new EnvironmentKubeconfigError(
      `The kubeconfig ${kind} "${name}" has no ${kind} section.`,
    );
  }
  return body;
}

function rejectUnknownFields(
  section: Record<string, unknown>,
  allowed: Set<string>,
  kind: "cluster" | "user" | "context",
): void {
  for (const field of Object.keys(section)) {
    if (allowed.has(field)) continue;
    const reason = REJECTED_FIELD_REASONS[field];
    throw new EnvironmentKubeconfigError(
      reason
        ? `The kubeconfig ${kind} field "${field}" is not supported: ${reason}.`
        : `The kubeconfig ${kind} field "${field}" is not supported.`,
    );
  }
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new EnvironmentKubeconfigError(
      `The kubeconfig field ${field} is missing.`,
    );
  }
  return value;
}

function parseServer(value: unknown): string {
  const raw = requireString(value, "cluster.server");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new EnvironmentKubeconfigError(
      "The kubeconfig field cluster.server is not a URL.",
    );
  }
  if (url.protocol !== "https:") {
    throw new EnvironmentKubeconfigError(
      "The kubeconfig field cluster.server must be an https:// URL.",
    );
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new EnvironmentKubeconfigError(
      "The kubeconfig field cluster.server must not carry credentials, a query or a fragment.",
    );
  }
  // One spelling per API server: the host in lower case and without the DNS
  // root dot, no default port, no trailing slash. The server identifies the
  // cluster, so two spellings of one address must not read as two clusters.
  const host = url.hostname.replace(/\.$/, "");
  const port = url.port ? `:${url.port}` : "";
  return `https://${host}${port}${url.pathname.replace(/\/+$/, "")}`;
}

/**
 * A base64 field holding a PEM certificate or private key that the platform's
 * own TLS stack can read; returned unchanged. Whether a client key belongs to
 * its certificate, and whether the cluster accepts them, is settled by
 * connecting with them before anything is stored.
 */
function requirePem(
  value: unknown,
  field: string,
  kind: "CERTIFICATE" | "PRIVATE KEY",
): string {
  const raw = requireString(value, field);
  const pem = Buffer.from(raw, "base64");
  try {
    if (kind === "CERTIFICATE") new X509Certificate(pem);
    else createPrivateKey(pem);
  } catch {
    throw new EnvironmentKubeconfigError(
      kind === "CERTIFICATE"
        ? `The kubeconfig field ${field} is not a base64-encoded PEM certificate.`
        : `The kubeconfig field ${field} is not a base64-encoded PEM private key.`,
    );
  }
  return raw;
}

function parseCredential(
  user: Record<string, unknown>,
): Record<string, string> {
  const hasToken = user.token !== undefined;
  const hasCertificate =
    user["client-certificate-data"] !== undefined ||
    user["client-key-data"] !== undefined;
  if (hasToken === hasCertificate) {
    throw new EnvironmentKubeconfigError(
      "The kubeconfig user needs exactly one credential: a token, or client-certificate-data with client-key-data.",
    );
  }
  if (hasToken) {
    return { token: requireString(user.token, "user.token") };
  }
  return {
    "client-certificate-data": requirePem(
      user["client-certificate-data"],
      "user.client-certificate-data",
      "CERTIFICATE",
    ),
    "client-key-data": requirePem(
      user["client-key-data"],
      "user.client-key-data",
      "PRIVATE KEY",
    ),
  };
}
