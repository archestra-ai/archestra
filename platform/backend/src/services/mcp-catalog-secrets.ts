import { SecretsManagerType } from "@archestra/shared/types";
import { secretManager } from "@/secrets-manager";
import type { LocalConfig } from "@/types";
import { SecretDecryptionError } from "@/utils/secret-decryption-error";

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

/** Reject incomplete recovery before a writer renames the catalog or rotates another credential. */
export async function assertCatalogCredentialRecovery(params: {
  localSecretId: string | null | undefined;
  existingLocalConfig: LocalConfig | null | undefined;
  localConfig: LocalConfig | null | undefined;
  clientSecretId: string | null | undefined;
  clientRecovery?: { requiredKeys: string[]; values: Record<string, string> };
}): Promise<void> {
  const localSurfaceTouched =
    params.localConfig?.environment !== undefined ||
    params.localConfig?.imagePullSecrets !== undefined;
  const candidates = [
    ...(localSurfaceTouched
      ? [
          {
            id: params.localSecretId,
            complete:
              params.existingLocalConfig !== undefined &&
              hasCompleteLocalSecretReplacement(
                params.localConfig,
                params.existingLocalConfig,
              ),
          },
        ]
      : []),
    ...(params.clientRecovery &&
    Object.keys(params.clientRecovery.values).length > 0
      ? [
          {
            id: params.clientSecretId,
            complete: params.clientRecovery.requiredKeys.every((key) =>
              Boolean(params.clientRecovery?.values[key]),
            ),
          },
        ]
      : []),
  ];
  for (const candidate of candidates) {
    try {
      await readSecretBag(candidate.id);
    } catch (error) {
      if (
        !(error instanceof SecretDecryptionError) ||
        secretManager().type !== SecretsManagerType.DB ||
        !candidate.complete
      ) {
        throw error;
      }
    }
  }
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
  existingLocalConfig?: LocalConfig | null;
}): Promise<LocalConfigSecretExtraction> {
  const { existingSecretId, catalogName } = params;
  const localConfig = params.localConfig
    ? structuredClone(params.localConfig)
    : params.localConfig;

  // Metadata-only edits must not require credentials.
  if (
    localConfig?.environment === undefined &&
    localConfig?.imagePullSecrets === undefined
  ) {
    return { localConfig, secretId: existingSecretId ?? null, rotated: false };
  }
  let existingSecretValues: Record<string, string>;
  let recovering = false;
  try {
    existingSecretValues = await readSecretBag(existingSecretId);
  } catch (error) {
    if (
      !(error instanceof SecretDecryptionError) ||
      secretManager().type !== SecretsManagerType.DB ||
      params.existingLocalConfig === undefined ||
      !hasCompleteLocalSecretReplacement(
        localConfig,
        params.existingLocalConfig,
      )
    ) {
      throw error;
    }
    existingSecretValues = {};
    recovering = true;
  }
  const secretEnvVars: Record<string, string> = {};
  let rotated = recovering;

  for (const envVar of localConfig?.environment ?? []) {
    if (envVar.credentialId) {
      delete envVar.value;
      continue;
    }
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

  // A new bag makes recovery visible to the catalog audit and reinstall gates.
  // Keep the unreadable bag intact in case the previous key is restored later.
  let secretId = recovering ? null : (existingSecretId ?? null);
  if (
    Object.keys(secretEnvVars).length > 0 ||
    recovering ||
    (secretId && localBagSurfaceTouched)
  ) {
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
  /** All configured keys must be explicitly supplied when replacing an unreadable bag. */
  recovery?: { requiredKeys: string[]; values: Record<string, string> };
}): Promise<{ id: string; rotated: boolean }> {
  let existingSecretValues: Record<string, string>;
  try {
    existingSecretValues = await getCatalogClientSecretValues(
      params.clientSecretId,
    );
  } catch (error) {
    if (
      !(error instanceof SecretDecryptionError) ||
      secretManager().type !== SecretsManagerType.DB ||
      !params.recovery ||
      !params.recovery.requiredKeys.every((key) =>
        Boolean(params.recovery?.values[key]),
      )
    ) {
      throw error;
    }
    const secret = await secretManager().createSecret(
      { ...params.recovery.values, [params.key]: params.value },
      `${params.catalogName}-client-secrets`,
    );
    return { id: secret.id, rotated: true };
  }
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

function hasCompleteLocalSecretReplacement(
  replacement: LocalConfig | null | undefined,
  existing: LocalConfig | null,
): boolean {
  // Require both configured surfaces, including explicitly empty arrays when
  // removing credentials. Omitted surfaces must never silently drop passwords.
  if (
    (existing?.environment !== undefined &&
      replacement?.environment === undefined) ||
    (existing?.imagePullSecrets !== undefined &&
      replacement?.imagePullSecrets === undefined)
  )
    return false;
  return (
    Boolean(replacement) &&
    (replacement?.environment ?? []).every(
      (entry) =>
        entry.type !== "secret" ||
        entry.promptOnInstallation ||
        entry.credentialId ||
        Boolean(entry.value),
    ) &&
    (replacement?.imagePullSecrets ?? []).every(
      (entry) => entry.source !== "credentials" || Boolean(entry.password),
    )
  );
}

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
