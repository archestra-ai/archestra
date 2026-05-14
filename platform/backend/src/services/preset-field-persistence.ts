import { secretManager } from "@/secrets-manager";
import type { InternalMcpCatalog, PresetFieldValues } from "@/types";

function collectSecretPresetKeys(parent: InternalMcpCatalog): Set<string> {
  const keys = new Set<string>();
  for (const [key, field] of Object.entries(parent.userConfig ?? {})) {
    if (field.promptOnPreset && field.sensitive) keys.add(key);
  }
  for (const env of parent.localConfig?.environment ?? []) {
    if (env.promptOnPreset && env.type === "secret") keys.add(env.key);
  }
  return keys;
}

/**
 * Split an incoming `presetFieldValues` payload into a non-secret subset
 * (persisted on the catalog row as plain JSONB) and a secret bundle
 * (persisted via secretManager and referenced by `presetSecretId`).
 *
 * Semantics for secret fields:
 *   - non-empty incoming value → write to secret bag (replace existing key)
 *   - empty / missing incoming value → preserve existing stored secret
 *     (this mirrors how the install dialog handles already-stored secrets)
 *
 * Returns the values to persist on the row.
 */
export async function partitionPresetFieldValuesAndUpsertSecrets(params: {
  parent: InternalMcpCatalog;
  catalogRow: { name: string; presetSecretId: string | null };
  incoming: PresetFieldValues;
}): Promise<{
  nonSecretFieldValues: PresetFieldValues;
  presetSecretId: string | null;
}> {
  const { parent, catalogRow, incoming } = params;
  const secretKeys = collectSecretPresetKeys(parent);

  const nonSecretFieldValues: PresetFieldValues = {};
  const incomingSecretValues: Record<string, string> = {};
  for (const [key, value] of Object.entries(incoming)) {
    if (secretKeys.has(key)) {
      if (value !== undefined && value !== null && value !== "") {
        incomingSecretValues[key] = String(value);
      }
    } else {
      nonSecretFieldValues[key] = value;
    }
  }

  let existingBag: Record<string, unknown> = {};
  if (catalogRow.presetSecretId) {
    const existing = await secretManager().getSecret(catalogRow.presetSecretId);
    if (existing?.secret) existingBag = existing.secret;
  }

  const mergedBag = { ...existingBag, ...incomingSecretValues };

  let presetSecretId = catalogRow.presetSecretId;
  if (Object.keys(mergedBag).length > 0) {
    if (presetSecretId) {
      await secretManager().updateSecret(presetSecretId, mergedBag);
    } else {
      const secret = await secretManager().createSecret(
        mergedBag,
        `${catalogRow.name}-preset-secrets`,
      );
      presetSecretId = secret.id;
    }
  }

  return { nonSecretFieldValues, presetSecretId };
}
