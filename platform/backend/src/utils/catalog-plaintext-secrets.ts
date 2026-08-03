/**
 * Keeps plaintext secret material out of catalog rows and version snapshots.
 *
 * Catalog config stores secrets as bundle references (`clientSecretId`,
 * `localConfigSecretId`) — never values. But the plaintext fields stay legal
 * in the schema (`localConfig.environment[].value`,
 * `oauthConfig.client_secret`, `enterpriseManagedConfig.clientSecretOverride`,
 * `localConfig.imagePullSecrets[].password`) because reads materialize real
 * values into them via `expandSecrets`, and writers have historically written
 * such expanded objects straight back to the row. These helpers are the two
 * defense layers against that:
 *
 * - `stripManagedPlaintextSecretFields` — the model write boundary
 *   (`InternalMcpCatalogModel.create`/`update`). Mirrors the PUT route's
 *   extraction predicates and only strips a surface whose secret bundle is in
 *   play, so a legacy bundle-less row's inline `oauthConfig.client_secret`
 *   (still read by OAuth flows when no bundle resolves) survives a
 *   passthrough update.
 * - `stripAllPlaintextSecretFields` — the version-snapshot builder. Across the
 *   three config blobs above it is unconditional, including prompt-on-install
 *   template values: history never needs secret values, and snapshots are
 *   immutable, so a value that leaked into one could never be purged. It does
 *   NOT reach `userConfig`, whose `sensitive` fields can carry a `default` —
 *   those are snapshotted as-is, matching how they already sit in the row.
 *
 * Every function is pure — callers reuse the expanded config object after a
 * write for deployment work, so inputs must never be mutated — and walks the
 * config structurally rather than through a schema parse, so rows in odd
 * legacy shapes (the ones most likely to be dirty) are still stripped.
 */

/**
 * A secret-typed env var whose value the catalog owns in the local-config
 * secret bundle. Prompt-on-install vars are excluded on purpose: their values
 * are per-install user input collected at installation time, not catalog
 * secrets. Shared with the PUT route's bundle-extraction loops so the two
 * predicates cannot drift.
 */
export function isManagedSecretEnvVar(envVar: {
  type?: unknown;
  promptOnInstallation?: unknown;
}): boolean {
  return envVar.type === "secret" && !envVar.promptOnInstallation;
}

/**
 * Snapshot-builder variant: unconditionally drop every plaintext secret field
 * from the three config blobs, whatever shape they are in.
 */
export function stripAllPlaintextSecretFields<T extends CatalogConfigFields>(
  config: T,
): T {
  const result: CatalogConfigFields = { ...config };
  if (config.localConfig !== undefined) {
    result.localConfig = stripLocalConfig({
      value: config.localConfig,
      managedOnly: false,
    }).value;
  }
  if (config.oauthConfig !== undefined) {
    result.oauthConfig = stripPlaintextKey({
      value: config.oauthConfig,
      key: "client_secret",
      label: "oauthConfig.client_secret",
      truthyOnly: false,
    }).value;
  }
  if (config.enterpriseManagedConfig !== undefined) {
    result.enterpriseManagedConfig = stripPlaintextKey({
      value: config.enterpriseManagedConfig,
      key: "clientSecretOverride",
      label: "enterpriseManagedConfig.clientSecretOverride",
      truthyOnly: false,
    }).value;
  }
  return result as T;
}

/**
 * Write-boundary variant: strip only the fields the PUT route's extraction
 * loops would have deleted (managed secret env vars, credentials image-pull
 * passwords, client secret / override), and only for surfaces whose secret
 * bundle is in play. Returns the paths that were stripped — a legitimate
 * writer stores values in bundles before calling the model, so a non-empty
 * result is a leak or a caller bug the model should log.
 */
export function stripManagedPlaintextSecretFields<
  T extends CatalogConfigFields,
>(params: {
  values: T;
  hasClientSecretBundle: boolean;
  hasLocalConfigSecretBundle: boolean;
}): { values: T; strippedPaths: string[] } {
  const { values, hasClientSecretBundle, hasLocalConfigSecretBundle } = params;
  const strippedPaths: string[] = [];
  const result: CatalogConfigFields = { ...values };

  if (hasLocalConfigSecretBundle && values.localConfig !== undefined) {
    const stripped = stripLocalConfig({
      value: values.localConfig,
      managedOnly: true,
    });
    result.localConfig = stripped.value;
    strippedPaths.push(...stripped.strippedPaths);
  }

  if (hasClientSecretBundle) {
    if (values.oauthConfig !== undefined) {
      const stripped = stripPlaintextKey({
        value: values.oauthConfig,
        key: "client_secret",
        label: "oauthConfig.client_secret",
        truthyOnly: true,
      });
      result.oauthConfig = stripped.value;
      strippedPaths.push(...stripped.strippedPaths);
    }
    if (values.enterpriseManagedConfig !== undefined) {
      const stripped = stripPlaintextKey({
        value: values.enterpriseManagedConfig,
        key: "clientSecretOverride",
        label: "enterpriseManagedConfig.clientSecretOverride",
        truthyOnly: true,
      });
      result.enterpriseManagedConfig = stripped.value;
      strippedPaths.push(...stripped.strippedPaths);
    }
  }

  return { values: result as T, strippedPaths };
}

// === Internal helpers ===

type CatalogConfigFields = {
  localConfig?: unknown;
  oauthConfig?: unknown;
  enterpriseManagedConfig?: unknown;
};

type StripResult = { value: unknown; strippedPaths: string[] };

/**
 * `managedOnly: true` mirrors the PUT route exactly: managed secret env vars
 * and credentials passwords, truthy values only (the route's loops key off
 * `if (envVar.value)` / `if (entry.password)`). `managedOnly: false` drops the
 * field whenever it is present at all, so a dirty row and its clean twin
 * canonicalize to the same shape.
 */
function stripLocalConfig(params: {
  value: unknown;
  managedOnly: boolean;
}): StripResult {
  const { value, managedOnly } = params;
  if (!isPlainObject(value)) return { value, strippedPaths: [] };

  const strippedPaths: string[] = [];
  const result: Record<string, unknown> = { ...value };

  if (Array.isArray(result.environment)) {
    result.environment = result.environment.map((entry) => {
      if (!isPlainObject(entry) || entry.type !== "secret") return entry;
      const shouldStrip = managedOnly
        ? isManagedSecretEnvVar(entry) && Boolean(entry.value)
        : "value" in entry;
      if (!shouldStrip) return entry;
      const { value: _plaintext, ...rest } = entry;
      strippedPaths.push(`localConfig.environment[${String(entry.key)}].value`);
      return rest;
    });
  }

  if (Array.isArray(result.imagePullSecrets)) {
    result.imagePullSecrets = result.imagePullSecrets.map((entry) => {
      if (!isPlainObject(entry) || entry.source !== "credentials") return entry;
      const shouldStrip = managedOnly
        ? Boolean(entry.password)
        : "password" in entry;
      if (!shouldStrip) return entry;
      const { password: _plaintext, ...rest } = entry;
      strippedPaths.push(
        `localConfig.imagePullSecrets[${String(entry.server)}].password`,
      );
      return rest;
    });
  }

  return { value: result, strippedPaths };
}

function stripPlaintextKey(params: {
  value: unknown;
  key: string;
  label: string;
  truthyOnly: boolean;
}): StripResult {
  const { value, key, label, truthyOnly } = params;
  if (!isPlainObject(value)) return { value, strippedPaths: [] };
  const shouldStrip = truthyOnly ? Boolean(value[key]) : key in value;
  if (!shouldStrip) return { value, strippedPaths: [] };
  const { [key]: _plaintext, ...rest } = value;
  return { value: rest, strippedPaths: [label] };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
