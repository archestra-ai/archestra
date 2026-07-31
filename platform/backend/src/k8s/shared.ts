import * as fs from "node:fs";
import * as k8s from "@kubernetes/client-node";
import config from "@/config";
import logger from "@/logging";

const {
  orchestrator: {
    kubernetes: { namespace, kubeconfig, loadKubeconfigFromCurrentCluster },
  },
} = config;

interface K8sClients {
  kubeConfig: k8s.KubeConfig;
  coreApi: k8s.CoreV1Api;
  appsApi: k8s.AppsV1Api;
  batchApi: k8s.BatchV1Api;
  authApi: k8s.AuthorizationV1Api;
  networkingApi: k8s.NetworkingV1Api;
  customObjectsApi: k8s.CustomObjectsApi;
  attach: k8s.Attach;
  exec: k8s.Exec;
  log: k8s.Log;
  namespace: string;
}

/**
 * Validates kubeconfig file and throws descriptive errors for various failure scenarios
 * @public — exported for testability
 */
export function validateKubeconfig(path?: string) {
  if (!path) {
    return;
  }

  if (!fs.existsSync(path)) {
    throw new Error(`❌ Kubeconfig file not found at ${path}`);
  }

  const content = fs.readFileSync(path, "utf8");

  const kc = new k8s.KubeConfig();
  try {
    kc.loadFromString(content);
  } catch {
    throw new Error("❌ Malformed kubeconfig: could not parse YAML");
  }

  if (!kc.clusters || kc.clusters.length === 0) {
    throw new Error("❌ Invalid kubeconfig: clusters section missing");
  }

  const c0 = kc.clusters[0];
  if (!c0) {
    throw new Error("❌ Invalid kubeconfig: clusters[0] is missing");
  }

  if (!c0.name || !c0.server) {
    throw new Error(
      "❌ Invalid kubeconfig: cluster entry is missing required fields",
    );
  }

  if (!kc.contexts || kc.contexts.length === 0) {
    throw new Error("❌ Invalid kubeconfig: contexts section missing");
  }

  if (!kc.users || kc.users.length === 0) {
    throw new Error("❌ Invalid kubeconfig: users section missing");
  }

  logger.info("✓ Custom kubeconfig validated successfully.");
}

/**
 * Loads and initializes KubeConfig based on environment configuration.
 * Returns the loaded KubeConfig and resolved namespace.
 * Throws if loading fails.
 */
export function loadKubeConfig(): {
  kubeConfig: k8s.KubeConfig;
  namespace: string;
} {
  const kc = new k8s.KubeConfig();

  const kubeconfigPath =
    kubeconfig && kubeconfig.trim().length > 0 ? kubeconfig.trim() : undefined;

  if (loadKubeconfigFromCurrentCluster) {
    kc.loadFromCluster();
    logger.info("Loaded kubeconfig from current cluster");
  } else if (kubeconfigPath) {
    validateKubeconfig(kubeconfigPath);
    kc.loadFromFile(kubeconfigPath);
    logger.info(`Loaded kubeconfig from ${kubeconfigPath}`);
  } else {
    kc.loadFromDefault();
    logger.info("No kubeconfig provided — using default kubeconfig");
  }

  return {
    kubeConfig: kc,
    namespace: namespace || "default",
  };
}

/**
 * Creates all K8s API clients from a loaded KubeConfig.
 */
export function createK8sClients(
  kubeConfig: k8s.KubeConfig,
  resolvedNamespace: string,
): K8sClients {
  return {
    kubeConfig,
    coreApi: kubeConfig.makeApiClient(k8s.CoreV1Api),
    appsApi: kubeConfig.makeApiClient(k8s.AppsV1Api),
    batchApi: kubeConfig.makeApiClient(k8s.BatchV1Api),
    authApi: kubeConfig.makeApiClient(k8s.AuthorizationV1Api),
    networkingApi: kubeConfig.makeApiClient(k8s.NetworkingV1Api),
    customObjectsApi: kubeConfig.makeApiClient(k8s.CustomObjectsApi),
    attach: new k8s.Attach(kubeConfig),
    exec: new k8s.Exec(kubeConfig),
    log: new k8s.Log(kubeConfig),
    namespace: resolvedNamespace,
  };
}

/**
 * Check if K8s runtime is enabled based on environment configuration.
 * Returns true when either KUBECONFIG or LOAD_KUBECONFIG_FROM_CURRENT_CLUSTER is set.
 * @public — exported for testability
 */
export function isK8sConfigured(): boolean {
  return (
    loadKubeconfigFromCurrentCluster ||
    (!!kubeconfig && kubeconfig.trim().length > 0)
  );
}

/**
 * Returns the resolved K8s namespace from configuration.
 * @public — exported for testability
 */
export function getK8sNamespace(): string {
  return namespace || "default";
}

/**
 * Type guard to check if an error is a Kubernetes 409 (Conflict) error —
 * e.g. a create that raced another writer; retry as a replace/patch.
 * K8s client errors can have `statusCode`, `code`, or `response.statusCode` set.
 */
export function isK8sConflictError(error: unknown): boolean {
  return getK8sErrorStatusCode(error) === 409;
}

/**
 * Type guard to check if an error is a Kubernetes 404 (Not Found) error.
 * K8s client errors can have `statusCode`, `code`, or `response.statusCode` set to 404.
 */
export function isK8sNotFoundError(error: unknown): boolean {
  return getK8sErrorStatusCode(error) === 404;
}

/**
 * Whether a Kubernetes API call failed for a reason that says nothing about
 * the workload itself: the API server throttled the request (429, API
 * Priority & Fairness) or was itself unavailable/overloaded (5xx). Such
 * failures must never be treated as a deployment failure — the pod may be
 * perfectly healthy — only as "we couldn't ask right now".
 */
export function isTransientK8sApiError(error: unknown): boolean {
  const status = getK8sErrorStatusCode(error);
  return (
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504
  );
}

/**
 * Run `fn` over `items` with at most `limit` in flight at once. Used to bound
 * fan-outs that hit the Kubernetes API for every MCP server — full
 * parallelism across a large install base trips the API server's Priority &
 * Fairness throttling (429 "Too many requests"). Per-item failures are
 * captured, not thrown, mirroring `Promise.allSettled`.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results = new Array<PromiseSettledResult<R>>(items.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    async () => {
      while (nextIndex < items.length) {
        const index = nextIndex++;
        try {
          results[index] = {
            status: "fulfilled",
            value: await fn(items[index] as T),
          };
        } catch (reason) {
          results[index] = { status: "rejected", reason };
        }
      }
    },
  );
  await Promise.all(workers);
  return results;
}

/**
 * Retry a Kubernetes API call on transient API-server errors (429/5xx),
 * honoring the server's `retry-after` header when present (API Priority &
 * Fairness sends one with every 429). Non-transient errors (404, 403, 409,
 * validation failures, …) are rethrown immediately.
 */
export async function withK8sApiRetry<T>(
  fn: () => Promise<T>,
  options?: { attempts?: number; label?: string },
): Promise<T> {
  const attempts = options?.attempts ?? K8S_RETRY_DEFAULT_ATTEMPTS;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (!isTransientK8sApiError(error) || attempt >= attempts) {
        throw error;
      }
      const retryAfterSeconds = getK8sRetryAfterSeconds(error);
      const baseDelayMs =
        retryAfterSeconds !== undefined
          ? retryAfterSeconds * 1000
          : K8S_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
      const delayMs =
        Math.min(baseDelayMs, K8S_RETRY_MAX_DELAY_MS) +
        Math.floor(Math.random() * K8S_RETRY_JITTER_MS);
      logger.warn(
        { err: error, attempt, attempts, delayMs, label: options?.label },
        "Transient Kubernetes API error; retrying",
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

/**
 * Ensures a string is RFC 1123 compliant for Kubernetes DNS subdomain names and label values.
 *
 * According to RFC 1123, Kubernetes DNS subdomain names must:
 * - contain no more than 253 characters
 * - contain only lowercase alphanumeric characters, '-' or '.'
 * - start with an alphanumeric character
 * - end with an alphanumeric character
 */
export function ensureStringIsRfc1123Compliant(input: string): string {
  return input
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9.-]/g, "")
    .replace(/-+/g, "-")
    .replace(/\.+/g, ".")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/[^a-z0-9]+$/, "");
}

/**
 * Frozen K8s deployment name for a NEW local (single-tenant) MCP server
 * install: `mcp-<slug40>-<id8>`. The id suffix makes new names structurally
 * unique (no collision handling needed); the slug keeps `kubectl` output
 * readable. Max 53 chars, so the derived `<name>-service` Service still fits
 * the 63-char RFC 1123 label limit. Computed once at creation, stored on the
 * `mcp_server` row, and never recomputed — deployment identity must not
 * follow the mutable display name, or renames orphan the running deployment.
 */
export function constructFrozenMcpDeploymentName(
  name: string,
  id: string,
): string {
  const slug =
    ensureStringIsRfc1123Compliant(name)
      .slice(0, 40)
      .replace(/[^a-z0-9]+$/, "") || "server";
  return `mcp-${slug}-${id.slice(0, 8)}`;
}

/**
 * Legacy single-tenant deployment name (`mcp-<slug>`), historically
 * recomputed from the mutable server name on every deploy. Kept only for
 * rows created before `deployment_name` existed: the startup adopt pass and
 * the rename cascade's freeze-fallback use it to freeze a byte-identical
 * value, and the runtime falls back to it while a row is still unfrozen.
 * New installs use {@link constructFrozenMcpDeploymentName} instead.
 */
export function constructLegacyMcpDeploymentName(name: string): string {
  return `mcp-${ensureStringIsRfc1123Compliant(name)}`.substring(0, 253);
}

/**
 * Shared-deployment name for a multitenant catalog:
 * `mcp-mt-<catalogId8>-<slug>`. New multitenant catalogs freeze exactly this
 * shape at creation — byte-identical to what the runtime historically
 * recomputed from the mutable catalog name — so existing deployments never
 * churn. The runtime also uses it as the recompute fallback for rows the
 * startup adopt pass hasn't frozen yet.
 */
export function constructLegacyMultitenantMcpDeploymentName(
  catalogId: string,
  name: string,
): string {
  const slugified = ensureStringIsRfc1123Compliant(name);
  return `mcp-mt-${catalogId.slice(0, 8)}-${slugified}`.substring(0, 253);
}

/**
 * Sanitizes a single label value to ensure it's RFC 1123 compliant,
 * no longer than 63 characters, and ends with an alphanumeric character.
 */
export function sanitizeLabelValue(value: string): string {
  return ensureStringIsRfc1123Compliant(value)
    .substring(0, 63)
    .replace(/[^a-z0-9]+$/, "");
}

type NamespaceAccessReason = "forbidden" | "unavailable";

type NamespaceAccessResult =
  | { ok: true }
  | { ok: false; reason: NamespaceAccessReason };

/**
 * Checks whether the platform's service account can deploy MCP server workloads
 * into a namespace, via a SelfSubjectAccessReview for `create deployments`.
 *
 * This deliberately does NOT read the namespace object: `get namespaces` is a
 * cluster-scoped permission, and the chart's least-privilege design grants the
 * platform SA only namespaced Roles (pods/deployments/services/secrets). So
 * reading the namespace would 403 even when the SA can fully deploy there. The
 * access review checks exactly the permission the runtime needs — the same thing
 * `kubectl auth can-i create deployments -n <ns>` answers — and requires no extra
 * RBAC (a SelfSubjectAccessReview is always allowed for one's own permissions).
 */
export async function checkNamespaceDeployAccess(
  namespaceName: string,
  authApi: k8s.AuthorizationV1Api,
): Promise<NamespaceAccessResult> {
  try {
    const review = await authApi.createSelfSubjectAccessReview({
      body: {
        spec: {
          resourceAttributes: {
            namespace: namespaceName,
            verb: "create",
            group: "apps",
            resource: "deployments",
          },
        },
      },
    });
    return review.status?.allowed
      ? { ok: true }
      : { ok: false, reason: "forbidden" };
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}

/**
 * User-facing message for a namespace the platform SA cannot deploy into.
 * Shared by the create/update guard and the "Test" probe so both read the same.
 */
export function namespaceAccessMessage(
  namespaceName: string,
  reason: NamespaceAccessReason,
): string {
  return reason === "forbidden"
    ? `No access to namespace "${namespaceName}" — the platform's Kubernetes service account cannot deploy there. Grant it via the Helm chart (orchestrator.kubernetes.rbac.environmentNamespaces) and redeploy.`
    : "Could not reach the Kubernetes cluster.";
}

/**
 * Sanitizes metadata labels to ensure all keys and values are RFC 1123 compliant.
 * Also ensures values are no longer than 63 characters as per Kubernetes label requirements.
 */
export function sanitizeMetadataLabels(
  labels: Record<string, string>,
): Record<string, string> {
  const sanitized: Record<string, string> = {};
  for (const [key, value] of Object.entries(labels)) {
    sanitized[ensureStringIsRfc1123Compliant(key)] = sanitizeLabelValue(value);
  }
  return sanitized;
}

// === Internal helpers ===

/**
 * Extract the HTTP status code from a Kubernetes client error, if any.
 * Depending on the client codepath the code lands on `statusCode`, `code`
 * (the generated ApiException), or `response.statusCode`.
 */
function getK8sErrorStatusCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }

  if ("statusCode" in error && typeof error.statusCode === "number") {
    return error.statusCode;
  }

  if ("code" in error && typeof error.code === "number") {
    return error.code;
  }

  if ("response" in error) {
    const statusCode = (error as { response?: { statusCode?: unknown } })
      .response?.statusCode;
    if (typeof statusCode === "number") {
      return statusCode;
    }
  }

  return undefined;
}

/**
 * Parse the `retry-after` header (delay-seconds form) from a Kubernetes
 * ApiException, if present.
 */
function getK8sRetryAfterSeconds(error: unknown): number | undefined {
  if (!error || typeof error !== "object" || !("headers" in error)) {
    return undefined;
  }
  const headers = (error as { headers?: unknown }).headers;
  if (!headers || typeof headers !== "object") {
    return undefined;
  }
  const raw = (headers as Record<string, unknown>)["retry-after"];
  const seconds =
    typeof raw === "string" || typeof raw === "number" ? Number(raw) : NaN;
  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
}

const K8S_RETRY_DEFAULT_ATTEMPTS = 3;
const K8S_RETRY_BASE_DELAY_MS = 1_000;
const K8S_RETRY_MAX_DELAY_MS = 15_000;
const K8S_RETRY_JITTER_MS = 250;
