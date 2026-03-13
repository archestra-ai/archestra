import * as fs from "node:fs";
import * as k8s from "@kubernetes/client-node";
import config from "@/config";
import logger from "@/logging";

const {
  orchestrator: {
    kubernetes: { namespace, kubeconfig, loadKubeconfigFromCurrentCluster },
  },
} = config;

export interface K8sClients {
  kubeConfig: k8s.KubeConfig;
  coreApi: k8s.CoreV1Api;
  appsApi: k8s.AppsV1Api;
  batchApi: k8s.BatchV1Api;
  attach: k8s.Attach;
  exec: k8s.Exec;
  log: k8s.Log;
  namespace: string;
}

/**
 * Validates kubeconfig file and throws descriptive errors for various failure scenarios
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
    attach: new k8s.Attach(kubeConfig),
    exec: new k8s.Exec(kubeConfig),
    log: new k8s.Log(kubeConfig),
    namespace: resolvedNamespace,
  };
}

/**
 * Check if K8s runtime is enabled based on environment configuration.
 * Returns true when either KUBECONFIG or LOAD_KUBECONFIG_FROM_CURRENT_CLUSTER is set.
 */
export function isK8sConfigured(): boolean {
  return (
    loadKubeconfigFromCurrentCluster ||
    (!!kubeconfig && kubeconfig.trim().length > 0)
  );
}

/**
 * Returns the resolved K8s namespace from configuration.
 */
export function getK8sNamespace(): string {
  return namespace || "default";
}

/**
 * Type guard to check if an error is a Kubernetes 404 (Not Found) error.
 * K8s client errors can have `statusCode`, `code`, or `response.statusCode` set to 404.
 */
export function isK8sNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  if ("statusCode" in error && error.statusCode === 404) {
    return true;
  }

  if ("code" in error && error.code === 404) {
    return true;
  }

  if (
    "response" in error &&
    (error as { response: { statusCode: number } }).response?.statusCode === 404
  ) {
    return true;
  }

  return false;
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
 * Sanitizes a single label value to ensure it's RFC 1123 compliant,
 * no longer than 63 characters, and ends with an alphanumeric character.
 */
export function sanitizeLabelValue(value: string): string {
  return ensureStringIsRfc1123Compliant(value)
    .substring(0, 63)
    .replace(/[^a-z0-9]+$/, "");
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
