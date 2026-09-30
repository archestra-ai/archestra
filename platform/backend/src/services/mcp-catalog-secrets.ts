import { isDeepStrictEqual } from "node:util";
import logger from "@/logging";
import SecretModel from "@/models/secret";
import { secretManager } from "@/secrets-manager";
import type { LocalConfig, SecretValue, SelectSecret } from "@/types";

/** Owns new bags until the catalog publishes their references. */
export class CatalogSecretStaging {
  private readonly createdIds = new Set<string>();

  async createSecret(
    value: SecretValue,
    name: string,
    forceDB?: boolean,
  ): Promise<SelectSecret> {
    const created = await secretManager().createSecret(value, name, forceDB);
    this.createdIds.add(created.id);
    return created;
  }

  async publish(): Promise<void> {
    // Only the final bag is retained when several staged edits superseded
    // one another before the catalog committed.
    await this.dispose();
  }

  async dispose(): Promise<void> {
    for (const id of this.createdIds) {
      try {
        // A commit may have succeeded before its response failed. Never erase
        // a bag already referenced by a published catalog in that case.
        await secretManager().deleteSecret(id, { onlyIfUnreferenced: true });
      } catch (error) {
        logger.warn(
          { err: error, secretId: id },
          "Could not remove an unpublished catalog secret",
        );
      }
    }
    this.createdIds.clear();
  }
}

interface LocalConfigSecretExtraction {
  /** Prepared config; unchanged legacy inline values retain their representation. */
  localConfig: LocalConfig | null | undefined;
  secretId: string | null;
  /** Whether credential values changed, for callers restarting installations. */
  rotated: boolean;
}

/** Stages changed values separately while preserving unchanged legacy inline fields. */
export async function extractLocalConfigSecrets(params: {
  localConfig: LocalConfig | null | undefined;
  existingSecretId: string | null | undefined;
  existingLocalConfig?: LocalConfig | null;
  catalogName: string;
  staging?: CatalogSecretStaging;
}): Promise<LocalConfigSecretExtraction> {
  const { existingSecretId, catalogName } = params;
  const localConfig = params.localConfig
    ? structuredClone(params.localConfig)
    : params.localConfig;

  const existingSecretValues = await getCatalogSecretValues(existingSecretId);
  const secretEnvVars: Record<string, string> = {};
  let rotated = false;

  for (const envVar of localConfig?.environment ?? []) {
    if (envVar.credentialId) {
      delete envVar.value;
      continue;
    }
    if (envVar.type !== "secret" || envVar.promptOnInstallation) continue;
    const previous = params.existingLocalConfig?.environment?.find(
      (field) =>
        field.key === envVar.key &&
        field.type === "secret" &&
        !field.promptOnInstallation &&
        !field.credentialId,
    );
    if (
      existingSecretValues[envVar.key] === undefined &&
      previous?.value &&
      (!envVar.value || envVar.value === previous.value)
    ) {
      envVar.value = previous.value;
      continue;
    }
    if (envVar.value) {
      const value = await preserveCatalogSecretReference({
        secretId: existingSecretId,
        key: envVar.key,
        value: envVar.value,
        existingValues: existingSecretValues,
      });
      if (existingSecretValues[envVar.key] !== value) rotated = true;
      secretEnvVars[envVar.key] = value;
      if (previous?.value && existingSecretValues[envVar.key] === value)
        envVar.value = previous.value;
      else delete envVar.value;
    } else if (existingSecretValues[envVar.key]) {
      // Entry submitted without a value keeps whatever the bag already holds;
      // a key with neither is simply not stored.
      secretEnvVars[envVar.key] = existingSecretValues[envVar.key];
      if (previous?.value) envVar.value = previous.value;
      else delete envVar.value;
    }
  }

  for (const entry of localConfig?.imagePullSecrets ?? []) {
    if (entry.source !== "credentials") continue;
    const key = regcredPasswordKey(entry.server, entry.username);
    const previous = params.existingLocalConfig?.imagePullSecrets?.find(
      (field) =>
        field.source === "credentials" &&
        field.server === entry.server &&
        field.username === entry.username,
    );
    if (
      existingSecretValues[key] === undefined &&
      previous?.source === "credentials" &&
      previous.password &&
      (!entry.password || entry.password === previous.password)
    ) {
      entry.password = previous.password;
      continue;
    }
    if (entry.password) {
      const value = await preserveCatalogSecretReference({
        secretId: existingSecretId,
        key,
        value: entry.password,
        existingValues: existingSecretValues,
      });
      if (existingSecretValues[key] !== value) rotated = true;
      secretEnvVars[key] = value;
      if (
        previous?.source === "credentials" &&
        previous.password &&
        existingSecretValues[key] === value
      )
        entry.password = previous.password;
      else delete entry.password;
    } else if (existingSecretValues[key]) {
      secretEnvVars[key] = existingSecretValues[key];
      if (previous?.source === "credentials" && previous.password)
        entry.password = previous.password;
      else delete entry.password;
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
  if (
    Object.keys(secretEnvVars).length > 0 ||
    (secretId && localBagSurfaceTouched)
  ) {
    if (!secretId || !isDeepStrictEqual(existingSecretValues, secretEnvVars)) {
      const creator = params.staging ?? secretManager();
      const existing = secretId ? await SecretModel.findById(secretId) : null;
      const secret = await creator.createSecret(
        secretEnvVars,
        `${catalogName}-local-config-env`,
        existing ? !existing.isVault && !existing.isByosVault : undefined,
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
  value: string | undefined;
  existingInlineValue?: string;
  staging?: CatalogSecretStaging;
}): Promise<{ id: string | null; rotated: boolean; inlineValue?: string }> {
  const existingSecretValues = await getCatalogClientSecretValues(
    params.clientSecretId,
  );
  const submittedValue =
    params.value ||
    existingSecretValues[params.key] ||
    params.existingInlineValue;
  if (
    existingSecretValues[params.key] === undefined &&
    params.existingInlineValue &&
    submittedValue === params.existingInlineValue
  ) {
    return {
      id: params.clientSecretId ?? null,
      rotated: false,
      inlineValue: params.existingInlineValue,
    };
  }
  if (!submittedValue)
    return { id: params.clientSecretId ?? null, rotated: false };
  // For a new bag the caller's row diff already covers the cascade via the new
  // `clientSecretId`, so `rotated` only matters on an existing one.
  const value = await preserveCatalogSecretReference({
    secretId: params.clientSecretId,
    key: params.key,
    value: submittedValue,
    existingValues: existingSecretValues,
  });
  const rotated = existingSecretValues[params.key] !== value;
  const secretValue = {
    ...existingSecretValues,
    [params.key]: value,
  };

  if (params.clientSecretId && !rotated) {
    return {
      id: params.clientSecretId,
      rotated,
      inlineValue: params.existingInlineValue,
    };
  }

  const existing = params.clientSecretId
    ? await SecretModel.findById(params.clientSecretId)
    : null;
  const creator = params.staging ?? secretManager();
  const secret = await creator.createSecret(
    secretValue,
    `${params.catalogName}-client-secrets`,
    existing ? !existing.isVault && !existing.isByosVault : undefined,
  );
  return { id: secret.id, rotated };
}

export async function getCatalogClientSecretValues(
  clientSecretId: string | null | undefined,
): Promise<Record<string, string>> {
  return getCatalogSecretValues(clientSecretId);
}

/** Read stored BYOS references without resolving them into credential values. */
export async function getCatalogSecretValues(
  secretId: string | null | undefined,
): Promise<Record<string, string>> {
  if (!secretId) return {};
  const stored = await SecretModel.findById(secretId);
  const existingSecret =
    stored && (!stored.isVault || stored.isByosVault)
      ? stored
      : await secretManager().getSecret(secretId, { skipCache: true });
  if (!existingSecret?.secret) return {};
  return Object.fromEntries(
    Object.entries(existingSecret.secret).map(([key, value]) => [
      key,
      String(value),
    ]),
  );
}

/** An echoed resolved BYOS value must retain its original external reference. */
async function preserveCatalogSecretReference(params: {
  secretId: string | null | undefined;
  key: string;
  value: string;
  existingValues: Record<string, string>;
}): Promise<string> {
  const previous = params.existingValues[params.key];
  if (!params.secretId || previous === undefined || previous === params.value)
    return params.value;
  const stored = await SecretModel.findById(params.secretId);
  if (!stored?.isByosVault) return params.value;
  const resolved = await secretManager().getSecret(params.secretId, {
    skipCache: true,
  });
  return String(resolved?.secret?.[params.key]) === params.value
    ? previous
    : params.value;
}

// === Internal ===

/** Bag key for a registry password, stable across reorder and unique per account. */
function regcredPasswordKey(server: string, username: string): string {
  return `__regcred_password:${server}:${username}`;
}
