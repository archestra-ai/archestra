import { SecretsManagerType } from "@shared";
import config from "@/config";
import logger from "@/logging";
import {
  ApiError,
  type ISecretManager,
  type VaultConfig,
  type VaultKvVersion,
} from "@/types";
import { DbSecretsManager } from "./db";
// biome-ignore lint/style/noRestrictedImports: only type import
import type ReadonlyVaultSecretManager from "./readonly-vault.ee";
import {
  getVaultConfigFromEnv,
  SecretsManagerConfigurationError,
} from "./vault-config";

export { SecretsManagerConfigurationError, getVaultConfigFromEnv };

class SecretManager {
  private static initialized = false;
  private currentInstance: ISecretManager | null = null;
  private managerType: SecretsManagerType;
  private initPromise: Promise<ISecretManager>;

  constructor() {
    if (SecretManager.initialized) {
      throw new Error("SecretManager already initialized");
    }
    this.managerType = getSecretsManagerTypeBasedOnEnvVars();
    this.initPromise = this.initialize();
    SecretManager.initialized = true;
  }

  async initialize(managerType?: SecretsManagerType) {
    this.managerType = managerType ?? getSecretsManagerTypeBasedOnEnvVars();
    this.currentInstance = await createSecretManager(this.managerType);
    return this.currentInstance;
  }

  /**
   * Wait for the async initialization to complete.
   * Call this before accessing getCurrentInstance() during early startup
   * (e.g., before database initialization that reads secrets from Vault).
   */
  async ensureInitialized(): Promise<ISecretManager> {
    return this.initPromise;
  }

  getCurrentInstance(): ISecretManager {
    if (!this.currentInstance) {
      throw new Error("SecretManager not initialized");
    }
    return this.currentInstance;
  }

  getManagerType(): SecretsManagerType {
    if (!this.managerType) {
      throw new Error("Manager type not set");
    }
    return this.managerType;
  }
}

/**
 * Create a secret manager based on environment configuration
 * Uses ARCHESTRA_SECRETS_MANAGER env var to determine the backend:
 * - "Vault": Uses VaultSecretManager (see getVaultConfigFromEnv for required env vars)
 * - "BYOS_VAULT": Uses BYOSVaultSecretManager for external team vault folder support
 * - "DB" or not set: Uses DbSecretsManager (default)
 */
export async function createSecretManager(
  managerType?: SecretsManagerType,
): Promise<ISecretManager> {
  managerType = managerType ?? getSecretsManagerTypeBasedOnEnvVars();

  if (managerType === SecretsManagerType.Vault) {
    if (!config.enterpriseLicenseActivated) {
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

  if (managerType === SecretsManagerType.BYOS_VAULT) {
    if (!config.enterpriseLicenseActivated) {
      logger.warn(
        "createSecretManager: ARCHESTRA_SECRETS_MANAGER=READONLY_VAULT configured but Archestra enterprise license is not activated, falling back to DbSecretsManager.",
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
      "createSecretManager: using BYOSVaultSecretManager",
    );
    const ReadonlyVaultSecretManager =
      // biome-ignore lint/style/noRestrictedImports: dynamic import
      (await import("./readonly-vault.ee")).default;
    return new ReadonlyVaultSecretManager(vaultConfig);
  }

  logger.info("createSecretManager: using DbSecretsManager");
  return new DbSecretsManager();
}

/**
 * Get the secrets manager type from environment variables
 * @returns SecretsManagerType based on ARCHESTRA_SECRETS_MANAGER env var, defaults to DB
 */
export function getSecretsManagerTypeBasedOnEnvVars(): SecretsManagerType {
  const envValue = process.env.ARCHESTRA_SECRETS_MANAGER?.toUpperCase();

  if (envValue === "VAULT") {
    return SecretsManagerType.Vault;
  }

  if (envValue === "READONLY_VAULT") {
    return SecretsManagerType.BYOS_VAULT;
  }

  return SecretsManagerType.DB;
}

/**
 * Get the Vault KV version when BYOS is enabled
 * @returns "1" or "2" if BYOS is enabled, null otherwise
 */
export function getByosVaultKvVersion(): VaultKvVersion | null {
  if (!isByosEnabled()) {
    return null;
  }
  const kvVersionEnv = process.env.ARCHESTRA_HASHICORP_VAULT_KV_VERSION;
  if (kvVersionEnv === "1" || kvVersionEnv === "2") {
    return kvVersionEnv;
  }
  return "2";
}

/**
 * Default secret manager instance (uses configured backend)
 */
export const secretManagerCoordinator = new SecretManager();
export function secretManager(): ISecretManager {
  return secretManagerCoordinator.getCurrentInstance();
}

/**
 * Check if BYOS (Bring Your Own Secrets) feature is enabled
 * BYOS allows teams to use external Vault folders for secrets
 * @returns true if ARCHESTRA_SECRETS_MANAGER=BYOS_VAULT and enterprise license is active
 */
export function isByosEnabled(): boolean {
  return (
    secretManagerCoordinator.getManagerType() ===
      SecretsManagerType.BYOS_VAULT && config.enterpriseLicenseActivated
  );
}

/**
 * Helper to check if BYOS feature is enabled and properly configured.
 * Throws appropriate error if not.
 * Returns the secretManager cast to BYOSVaultSecretManager for type narrowing.
 */
export function assertByosEnabled(): ReadonlyVaultSecretManager {
  if (!isByosEnabled()) {
    throw new ApiError(
      403,
      "Readonly Vault is not enabled. Requires ARCHESTRA_SECRETS_MANAGER=READONLY_VAULT and an enterprise license.",
    );
  }

  // When BYOS is enabled, secretManager is guaranteed to be a BYOSVaultSecretManager
  return secretManager() as ReadonlyVaultSecretManager;
}

export async function getSecretValueForLlmProviderApiKey(
  secretId: string,
): Promise<string | unknown> {
  const secret = await secretManager().getSecret(secretId);
  return (
    secret?.secret?.apiKey ??
    secret?.secret?.anthropicApiKey ??
    secret?.secret?.geminiApiKey ??
    secret?.secret?.openaiApiKey
  );
}
