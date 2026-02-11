import { SecretsManagerType } from "@shared";
import logger from "@/logging";
import SecretModel from "@/models/secret";
import {
  ApiError,
  type ISecretManager,
  parseVaultSecretReference,
  type SecretsConnectivityResult,
  type SecretValue,
  type SelectSecret,
} from "@/types";
import { VaultClient } from "./vault-client.ee";

/**
 * ReadonlyVaultSecretManager - Manages secrets stored in external (customer-owned) Vault folders.
 *
 * This manager implements the SecretManager interface for the BYOS (Bring Your Own Secrets) feature
 * where teams can map their own Vault folder paths and use secrets stored there.
 *
 * Key differences from VaultSecretManager:
 * - Does NOT create secrets in Vault (secrets are managed externally by the customer)
 * - Creates DB records that reference external Vault paths
 * - Fetches secret values from external Vault paths at read time
 * - Provides additional methods for listing/browsing external Vault folders
 *
 * Extends VaultClient which handles all Vault HTTP/auth logic (token, K8s, AWS IAM)
 * and secret retrieval (KV v1/v2). This class adds only the DB-dependent ISecretManager methods.
 */
export default class ReadonlyVaultSecretManager
  extends VaultClient
  implements ISecretManager
{
  readonly type = SecretsManagerType.BYOS_VAULT;

  /**
   * Get user-visible debug info about the secrets manager configuration.
   */
  override getUserVisibleDebugInfo(): {
    type: SecretsManagerType;
    meta: Record<string, string>;
  } {
    return {
      type: this.type,
      ...super.getUserVisibleDebugInfo(),
    };
  }

  // ============================================================
  // SecretManager interface implementation
  // ============================================================

  /**
   * Create a BYOS secret.
   * Since BYOS means the customer owns the secrets, we don't actually create anything in Vault.
   * Instead, we create a DB record that stores vault references in "path#key" format.
   *
   * @param secretValue - Key-value pairs where values are vault references (path#key format)
   *                      e.g., { "access_token": "secret/data/api-keys#my_token" }
   * @param name - Human-readable name for the secret
   * @param forceDB - When true, store actual values in DB instead of treating as vault references
   */
  async createSecret(
    secretValue: SecretValue,
    name: string,
    forceDB?: boolean,
  ): Promise<SelectSecret> {
    // If forceDB is true, store directly in database without isByosVault flag
    if (forceDB) {
      logger.info(
        { name, keyCount: Object.keys(secretValue).length },
        "BYOSVaultSecretManager.createSecret: forceDB=true, storing actual values in database",
      );
      return await SecretModel.create({
        name,
        secret: secretValue,
        isByosVault: false,
        isVault: false,
      });
    }

    logger.info(
      { name, keyCount: Object.keys(secretValue).length },
      "BYOSVaultSecretManager.createSecret: creating BYOS secret with vault references",
    );

    const secret = await SecretModel.create({
      name,
      secret: secretValue, // Store path#key references
      isByosVault: true,
    });

    logger.info(
      { keyCount: Object.keys(secretValue).length },
      "BYOSVaultSecretManager.createSecret: created BYOS secret",
    );

    return secret;
  }

  /**
   * Get the secret value, resolving vault references for BYOS secrets.
   *
   * If the secret has isByosVault=true, the secret field contains vault references
   * in "path#key" format that need to be resolved by fetching from Vault.
   */
  async getSecret(secretId: string): Promise<SelectSecret | null> {
    const dbRecord = await SecretModel.findById(secretId);

    if (!dbRecord) {
      return null;
    }

    // If not a BYOS Vault secret, just return the DB record as-is
    if (!dbRecord.isByosVault) {
      return dbRecord;
    }

    // All values in secret field are vault references (path#key format)
    const vaultReferences = dbRecord.secret as Record<string, string>;
    if (Object.keys(vaultReferences).length === 0) {
      return dbRecord;
    }

    logger.debug(
      { keyCount: Object.keys(vaultReferences).length },
      "BYOSVaultSecretManager.getSecret: resolving vault references",
    );

    try {
      await this.ensureInitialized();
    } catch (error) {
      this.handleVaultError(error, "getSecret", {});
    }

    try {
      const resolvedSecrets =
        await this.resolveVaultReferences(vaultReferences);

      logger.info(
        { keyCount: Object.keys(resolvedSecrets).length },
        "BYOSVaultSecretManager.getSecret: successfully resolved vault references",
      );

      return {
        ...dbRecord,
        secret: resolvedSecrets,
      };
    } catch (error) {
      logger.error(
        { error },
        "BYOSVaultSecretManager.getSecret: failed to resolve vault references",
      );

      if (error instanceof ApiError) {
        throw error;
      }

      throw new ApiError(
        500,
        "Failed to resolve vault secret references. Please verify the paths exist and Archestra has read access.",
      );
    }
  }

  /**
   * Delete the secret record from the database.
   * Note: This does NOT delete the secret from external Vault (we don't own it).
   */
  async deleteSecret(secretId: string): Promise<boolean> {
    logger.info(
      "BYOSVaultSecretManager.deleteSecret: deleting external vault secret reference",
    );

    return await SecretModel.delete(secretId);
  }

  /**
   * Alias for deleteSecret
   */
  async removeSecret(secretId: string): Promise<boolean> {
    return await this.deleteSecret(secretId);
  }

  /**
   * Update is not supported for BYOS secrets since we don't own the external Vault data.
   */
  async updateSecret(
    secretId: string,
    _secretValue: SecretValue,
  ): Promise<SelectSecret | null> {
    const dbRecord = await SecretModel.findById(secretId);

    if (!dbRecord) {
      return null;
    }

    return await SecretModel.update(secretId, {
      secret: _secretValue,
      isByosVault: true,
    });
  }

  /**
   * Check connectivity to the Vault server.
   */
  async checkConnectivity(): Promise<SecretsConnectivityResult> {
    throw new ApiError(
      501,
      "Connectivity check for BYOS secrets requires team context. Use team-specific vault folder connectivity check instead.",
    );
  }

  // ============================================================
  // Private methods
  // ============================================================

  /**
   * Resolve vault references by fetching values from Vault.
   * Groups by path to minimize Vault API calls.
   */
  private async resolveVaultReferences(
    references: Record<string, string>,
  ): Promise<SecretValue> {
    const resolved: SecretValue = {};

    // Group by path to minimize Vault calls
    const pathToKeys = new Map<
      string,
      { archestraKey: string; vaultKey: string }[]
    >();

    for (const [archestraKey, ref] of Object.entries(references)) {
      const { path, key: vaultKey } = parseVaultSecretReference(
        ref as `${string}#${string}`,
      );
      const existing = pathToKeys.get(path);
      if (existing) {
        existing.push({ archestraKey, vaultKey });
      } else {
        pathToKeys.set(path, [{ archestraKey, vaultKey }]);
      }
    }

    // Fetch from each path and extract specific keys
    for (const [path, keys] of pathToKeys) {
      const vaultData = await this.getSecretFromPath(path);
      for (const { archestraKey, vaultKey } of keys) {
        if (vaultData[vaultKey] !== undefined) {
          resolved[archestraKey] = vaultData[vaultKey];
        } else {
          logger.warn(
            { path, vaultKey, archestraKey },
            "Vault key not found in secret",
          );
        }
      }
    }

    return resolved;
  }
}
