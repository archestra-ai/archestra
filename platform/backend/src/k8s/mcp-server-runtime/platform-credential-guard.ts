import type * as k8s from "@kubernetes/client-node";
import * as yaml from "js-yaml";

/**
 * Credentials the Archestra platform itself runs with, read from its own pod.
 *
 * MCP server pods run in the platform's namespace by default, so a custom
 * deployment spec, an `envFrom` reference, or a service account name could
 * otherwise hand a server the platform's Secrets (the auth and
 * secrets-encryption keys, the database URL, provider keys) or its
 * ServiceAccount, which may carry a cloud workload identity.
 *
 * This is a denylist, not an allowlist: MCP servers legitimately read Secrets
 * they do not own (ExternalSecrets, operator-created Secrets, the registry's
 * `envFrom` setting). The list is derived from the running platform pod, so it
 * follows whatever names the operator configured instead of assuming chart
 * defaults.
 */
export interface PlatformCredentials {
  serviceAccounts: ReadonlySet<string>;
  secrets: ReadonlySet<string>;
  persistentVolumeClaims: ReadonlySet<string>;
}

/**
 * Collect the platform's credentials from its pod spec. Secrets named in
 * `allowedSecrets` (an operator's explicit opt-in) are left out.
 */
export function platformCredentialsFromPodSpec(
  spec: k8s.V1PodSpec,
  options: { allowedSecrets: readonly string[] },
): PlatformCredentials {
  const allowed = new Set(options.allowedSecrets);
  const serviceAccounts = new Set<string>();
  const serviceAccount = spec.serviceAccountName || spec.serviceAccount;
  // A platform running as the namespace's "default" account shares it with
  // every MCP pod that names no account, so it cannot be denied here.
  if (serviceAccount && serviceAccount !== DEFAULT_SERVICE_ACCOUNT) {
    serviceAccounts.add(serviceAccount);
    // The chart's hook-only migration account carries the same annotations
    // (and so the same cloud identity) as the platform account.
    serviceAccounts.add(`${serviceAccount}-migrate`);
  }

  const references = collectPodSpecReferences(spec);
  return {
    serviceAccounts,
    secrets: new Set(
      references.secrets
        .map((reference) => reference.name)
        .filter((name) => !allowed.has(name)),
    ),
    persistentVolumeClaims: new Set(
      references.persistentVolumeClaims.map((reference) => reference.name),
    ),
  };
}

/**
 * List every way a pod spec reaches a platform credential, as user-facing
 * error messages. Empty when the spec is safe.
 *
 * @param podSpec - The pod template spec: parsed custom YAML at save time, the
 *   final generated spec at deploy time.
 * @param serviceAccountName - The account the pod will run as. Custom YAML
 *   cannot choose it (the registry entry's setting always replaces it).
 * @param envFrom - The registry entry's `envFrom` setting, when the pod spec
 *   does not already include it.
 * @param ownSecretName - This server's own Archestra-managed Secret, once
 *   known (deploy time). At save time placeholders stand in for it.
 * @param platform - The platform's credentials; null when the platform pod
 *   could not be read, in which case only the name-based checks apply.
 */
export function findPlatformCredentialReferences(params: {
  podSpec: unknown;
  serviceAccountName?: string | null;
  envFrom?: ReadonlyArray<{ type: "secret" | "configMap"; name: string }>;
  ownSecretName?: string;
  platform: PlatformCredentials | null;
}): string[] {
  const errors: string[] = [];
  const { platform } = params;

  const serviceAccountName = params.serviceAccountName?.trim();
  if (serviceAccountName && platform?.serviceAccounts.has(serviceAccountName)) {
    errors.push(
      `Service account "${serviceAccountName}" belongs to the Archestra platform. Run the MCP server under its own service account.`,
    );
  }

  const references = collectPodSpecReferences(params.podSpec);
  for (const ref of params.envFrom ?? []) {
    if (ref.type === "secret") {
      references.secrets.push({ name: ref.name, path: "The envFrom setting" });
    }
  }

  for (const { name, path } of references.secrets) {
    // Placeholders resolve at deploy time, where the resolved spec is checked.
    if (name.includes("${") || name === params.ownSecretName) continue;
    if (platform?.secrets.has(name)) {
      errors.push(
        `${path} references Secret "${name}", which holds Archestra platform credentials. MCP servers cannot read it.`,
      );
    } else if (ARCHESTRA_MCP_SECRET_PATTERN.test(name)) {
      errors.push(
        `${path} references Secret "${name}", which Archestra manages for another MCP server. Use \${archestra.secret_name} for this server's own Secret.`,
      );
    }
  }

  for (const { name, path } of references.persistentVolumeClaims) {
    if (platform?.persistentVolumeClaims.has(name)) {
      errors.push(
        `${path} mounts PersistentVolumeClaim "${name}", which holds Archestra platform data. MCP servers cannot mount it.`,
      );
    }
  }

  return errors;
}

/**
 * {@link findPlatformCredentialReferences} for a custom deployment YAML.
 * YAML that does not parse yields no findings; the structural validator
 * reports it.
 */
export function findPlatformCredentialReferencesInYaml(params: {
  yaml: string;
  serviceAccountName?: string | null;
  envFrom?: ReadonlyArray<{ type: "secret" | "configMap"; name: string }>;
  platform: PlatformCredentials | null;
}): string[] {
  let podSpec: unknown;
  try {
    const parsed = yaml.load(params.yaml);
    podSpec = isRecord(parsed)
      ? getRecord(getRecord(getRecord(parsed, "spec"), "template"), "spec")
      : undefined;
  } catch {
    podSpec = undefined;
  }
  return findPlatformCredentialReferences({ ...params, podSpec });
}

// ===

const DEFAULT_SERVICE_ACCOUNT = "default";

/**
 * Archestra's per-server Secrets: `mcp-server-<id>-secrets`, the multitenant
 * `mcp-server-mt-<catalog>-secrets`, and `mcp-server-<id>-regcred-*`.
 */
const ARCHESTRA_MCP_SECRET_PATTERN = /^mcp-server-/;

const CONTAINER_FIELDS = [
  "initContainers",
  "containers",
  "ephemeralContainers",
] as const;

interface NamedReference {
  name: string;
  path: string;
}

function collectPodSpecReferences(podSpec: unknown): {
  secrets: NamedReference[];
  persistentVolumeClaims: NamedReference[];
} {
  const secrets: NamedReference[] = [];
  const persistentVolumeClaims: NamedReference[] = [];
  if (!isRecord(podSpec)) return { secrets, persistentVolumeClaims };

  const base = "spec.template.spec";
  forEachRecord(podSpec.volumes, (volume, index) => {
    const path = `${base}.volumes[${index}]`;
    const secretName = getRecord(volume, "secret")?.secretName;
    if (typeof secretName === "string") {
      secrets.push({ name: secretName, path: `${path}.secret` });
    }
    const claimName = getRecord(volume, "persistentVolumeClaim")?.claimName;
    if (typeof claimName === "string") {
      persistentVolumeClaims.push({
        name: claimName,
        path: `${path}.persistentVolumeClaim`,
      });
    }
    forEachRecord(getRecord(volume, "projected")?.sources, (source, i) => {
      const name = getRecord(source, "secret")?.name;
      if (typeof name === "string") {
        secrets.push({ name, path: `${path}.projected.sources[${i}].secret` });
      }
    });
  });

  for (const field of CONTAINER_FIELDS) {
    forEachRecord(podSpec[field], (container, index) => {
      const path = `${base}.${field}[${index}]`;
      forEachRecord(container.env, (env, i) => {
        const name = getRecord(
          getRecord(env, "valueFrom"),
          "secretKeyRef",
        )?.name;
        if (typeof name === "string") {
          secrets.push({
            name,
            path: `${path}.env[${i}].valueFrom.secretKeyRef`,
          });
        }
      });
      forEachRecord(container.envFrom, (envFrom, i) => {
        const name = getRecord(envFrom, "secretRef")?.name;
        if (typeof name === "string") {
          secrets.push({ name, path: `${path}.envFrom[${i}].secretRef` });
        }
      });
    });
  }

  return { secrets, persistentVolumeClaims };
}

function forEachRecord(
  value: unknown,
  visit: (record: Record<string, unknown>, index: number) => void,
): void {
  if (!Array.isArray(value)) return;
  value.forEach((item, index) => {
    if (isRecord(item)) visit(item, index);
  });
}

function getRecord(
  value: unknown,
  key: string,
): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const child = value[key];
  return isRecord(child) ? child : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
