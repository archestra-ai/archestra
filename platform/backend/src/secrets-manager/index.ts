import { SecretsManagerType, SupportedProviders } from "@archestra/shared";
import { encodeBedrockSigV4Marker } from "@/clients/bedrock-credentials";
import config from "@/config";
import logger from "@/logging";
import type { ISecretManager, VaultConfig } from "@/types";
import { DbSecretsManager } from "./db";
import {
  getVaultConfigFromEnv,
  SecretsManagerConfigurationError,
} from "./vault-config";

/** @public — re-exported for testability */
export { SecretsManagerConfigurationError, getVaultConfigFromEnv };

class SecretManager {
  private static initialized = false;
  private currentInstance: ISecretManager | null = null;

  constructor() {
    if (SecretManager.initialized) {
      throw new Error("SecretManager already initialized");
    }
    void this.initialize(getSecretsManagerTypeBasedOnEnvVars());
    SecretManager.initialized = true;
  }

  async initialize(managerType?: SecretsManagerType) {
    this.currentInstance = await createSecretManager(managerType);
    return this.currentInstance;
  }

  getCurrentInstance(): ISecretManager {
    if (!this.currentInstance) {
      throw new Error("SecretManager not initialized");
    }
    return this.currentInstance;
  }
}

/**
 * Create a secret manager based on environment configuration
 * Uses ARCHESTRA_SECRETS_MANAGER env var to determine the backend:
 * - "Vault": Uses VaultSecretManager (see getVaultConfigFromEnv for required env vars)
 * - "DB" or not set: Uses DbSecretsManager (default)
 * @public — exported for testability
 */
export async function createSecretManager(
  managerType?: SecretsManagerType,
): Promise<ISecretManager> {
  managerType = managerType ?? getSecretsManagerTypeBasedOnEnvVars();

  if (managerType === SecretsManagerType.Vault) {
    if (!config.enterpriseFeatures.core) {
      logger.warn(
        "createSecretManager: ARCHESTRA_SECRETS_MANAGER=Vault configured but Archestra enterprise license is not activated, falling back to DbSecretsManager.",
      );
      return new DbSecretsManager();
    }

    let vaultConfig: VaultConfig;
    try {
      vaultConfig = getVaultConfigFromEnv();
    } catch (error) {
      if (error instanceof SecretsManagerConfigurationError) {
        logger.warn(
          { reason: error.message },
          `createSecretManager: Invalid Vault configuration, falling back to DbSecretsManager. ${error.message}`,
        );
        return new DbSecretsManager();
      }
      throw error;
    }

    logger.info(
      { address: vaultConfig.address, authMethod: vaultConfig.authMethod },
      "createSecretManager: using VaultSecretManager",
    );
    // biome-ignore lint/style/noRestrictedImports: dynamic import
    const VaultSecretManager = (await import("./vault.ee")).default;
    return new VaultSecretManager(vaultConfig);
  }

  logger.debug("createSecretManager: using DbSecretsManager");
  return new DbSecretsManager();
}

/**
 * Get the secrets manager type from environment variables
 * @returns SecretsManagerType based on ARCHESTRA_SECRETS_MANAGER env var, defaults to DB
 * @public — exported for testability
 */
export function getSecretsManagerTypeBasedOnEnvVars(): SecretsManagerType {
  const envValue = config.secretsManager.type;

  if (envValue === "VAULT") {
    return SecretsManagerType.Vault;
  }

  if (envValue === "DB") return SecretsManagerType.DB;
  throw new SecretsManagerConfigurationError(
    "ARCHESTRA_SECRETS_MANAGER must be DB or VAULT",
  );
}

/**
 * Default secret manager instance (uses configured backend).
 * @public — exported for tests that exercise configured secret storage.
 */
export const secretManagerCoordinator = new SecretManager();
export function secretManager(): ISecretManager {
  return secretManagerCoordinator.getCurrentInstance();
}

/**
 * Retrieve the API key value for an LLM provider from the secrets store.
 *
 * Current format: `{ apiKey: "sk-..." }`
 * Bedrock SigV4 format: `{ accessKeyId, secretAccessKey, sessionToken? }` —
 *   encoded as a marker string so it flows through the existing single-string
 *   apiKey pipeline. Only Bedrock terminal call sites decode it.
 * Legacy formats (pre-v1.0): `{ <provider>ApiKey: "sk-..." }` (e.g. `anthropicApiKey`, `openaiApiKey`).
 * These provider-specific keys were used before the unified API key system.
 * They may still exist in databases that were created before the migration.
 */
export async function getSecretValueForLlmProviderApiKey(
  secretId: string,
): Promise<string | undefined> {
  const secret = await secretManager().getSecret(secretId);
  const data = secret?.secret as Record<string, unknown> | null;
  if (!data) return undefined;

  // Current format
  if (typeof data.apiKey === "string") return data.apiKey;

  // Bedrock SigV4 (no apiKey, but AWS access key pair)
  if (
    typeof data.accessKeyId === "string" &&
    typeof data.secretAccessKey === "string"
  ) {
    return encodeBedrockSigV4Marker({
      accessKeyId: data.accessKeyId,
      secretAccessKey: data.secretAccessKey,
      sessionToken:
        typeof data.sessionToken === "string" ? data.sessionToken : undefined,
    });
  }

  // Legacy format: `<provider>ApiKey` (e.g. anthropicApiKey, openaiApiKey)
  for (const provider of SupportedProviders) {
    const legacyKey = `${provider}ApiKey`;
    if (typeof data[legacyKey] === "string") return data[legacyKey] as string;
  }

  return undefined;
}
