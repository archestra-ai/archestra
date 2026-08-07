import { secretManager } from "@/secrets-manager";
import type { LocalConfig } from "@/types";

interface LocalConfigSecretExtraction {
  /** Config with secret values removed; persist this, not the input. */
  localConfig: LocalConfig | null | undefined;
  secretId: string | null;
  /**
   * A value on an EXISTING bag changed. The bag lives outside the catalog row,
   * so a same-id-different-content write is invisible to the row-diff cascade
   * gate; callers that restart installs use this to force the restart.
   */
  rotated: boolean;
}

/**
 * Moves credential values out of a catalog item's config and into its secret
 * bag, returning a sanitized config safe to persist in the jsonb column.
 *
 * Every writer of a catalog item must run this — the REST routes and the
 * Archestra MCP catalog tools alike. Persisting a config that still carries a
 * value leaves a plaintext credential in `internal_mcp_catalog`, and any read
 * that re-expands secrets will then serialize it back out.
 */
export async function extractLocalConfigSecrets(params: {
  localConfig: LocalConfig | null | undefined;
  existingSecretId: string | null | undefined;
  catalogName: string;
}): Promise<LocalConfigSecretExtraction> {
  const { existingSecretId, catalogName } = params;
  const localConfig = params.localConfig
    ? structuredClone(params.localConfig)
    : params.localConfig;

  const existingSecretValues = await readSecretBag(existingSecretId);
  const secretEnvVars: Record<string, string> = {};
  let rotated = false;

  for (const envVar of localConfig?.environment ?? []) {
    if (envVar.type !== "secret" || envVar.promptOnInstallation) continue;
    if (envVar.value) {
      if (existingSecretValues[envVar.key] !== envVar.value) rotated = true;
      secretEnvVars[envVar.key] = envVar.value;
      delete envVar.value;
    } else if (existingSecretValues[envVar.key]) {
      // Entry submitted without a value keeps whatever the bag already holds;
      // a key with neither is simply not stored.
      secretEnvVars[envVar.key] = existingSecretValues[envVar.key];
    }
  }

  for (const entry of localConfig?.imagePullSecrets ?? []) {
    if (entry.source !== "credentials") continue;
    const key = regcredPasswordKey(entry.server, entry.username);
    if (entry.password) {
      if (existingSecretValues[key] !== entry.password) rotated = true;
      secretEnvVars[key] = entry.password;
      delete entry.password;
    } else if (existingSecretValues[key]) {
      secretEnvVars[key] = existingSecretValues[key];
    }
  }

  // Keys the bag holds that nothing references any more are dropped by the
  // write below — a content change, so it counts as rotation. Gated on the
  // request actually supplying a surface that produces bag keys: an edit that
  // touches neither leaves `secretEnvVars` empty because there was nothing to
  // iterate, not because keys were removed.
  const localBagSurfaceTouched =
    localConfig?.environment !== undefined ||
    localConfig?.imagePullSecrets !== undefined;
  if (localBagSurfaceTouched) {
    for (const existingKey of Object.keys(existingSecretValues)) {
      if (!(existingKey in secretEnvVars)) {
        rotated = true;
        break;
      }
    }
  }

  let secretId = existingSecretId ?? null;
  if (Object.keys(secretEnvVars).length > 0) {
    if (secretId) {
      await secretManager().updateSecret(secretId, secretEnvVars);
    } else {
      const secret = await secretManager().createSecret(
        secretEnvVars,
        `${catalogName}-local-config-env`,
      );
      secretId = secret.id;
    }
  }

  return { localConfig, secretId, rotated };
}

export async function upsertCatalogClientSecretValue(params: {
  clientSecretId: string | null | undefined;
  catalogName: string;
  key: string;
  value: string;
}): Promise<{ id: string; rotated: boolean }> {
  const existingSecretValues = await getCatalogClientSecretValues(
    params.clientSecretId,
  );
  // For a new bag the caller's row diff already covers the cascade via the new
  // `clientSecretId`, so `rotated` only matters on an existing one.
  const rotated = existingSecretValues[params.key] !== params.value;
  const secretValue = {
    ...existingSecretValues,
    [params.key]: params.value,
  };

  if (params.clientSecretId) {
    await secretManager().updateSecret(params.clientSecretId, secretValue);
    return { id: params.clientSecretId, rotated };
  }

  const secret = await secretManager().createSecret(
    secretValue,
    `${params.catalogName}-client-secrets`,
  );
  return { id: secret.id, rotated };
}

export async function getCatalogClientSecretValues(
  clientSecretId: string | null | undefined,
): Promise<Record<string, string>> {
  return readSecretBag(clientSecretId);
}

// === Internal ===

/** Bag key for a registry password, stable across reorder and unique per account. */
function regcredPasswordKey(server: string, username: string): string {
  return `__regcred_password:${server}:${username}`;
}

async function readSecretBag(
  secretId: string | null | undefined,
): Promise<Record<string, string>> {
  if (!secretId) return {};

  const existingSecret = await secretManager().getSecret(secretId);
  if (!existingSecret?.secret) return {};

  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(existingSecret.secret)) {
    values[key] = String(value);
  }
  return values;
}
