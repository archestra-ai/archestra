import Vault from "node-vault";
import logger from "@/logging";
import SecretModel from "@/models/secret";
import type { SecretValue, SelectSecret } from "@/types";

/**
 * SecretManager interface for managing secrets
 * Can be implemented for different secret storage backends (database, AWS Secrets Manager, etc.)
 */
export interface SecretManager {
  /**
   * Create a new secret
   * @param secretValue - The secret value as JSON
   * @returns The created secret with generated ID
   */
  createSecret(secretValue: SecretValue): Promise<SelectSecret>;

  /**
   * Delete a secret by ID
   * @param secretId - The unique identifier of the secret
   * @returns True if deletion was successful, false otherwise
   */
  deleteSecret(secretId: string): Promise<boolean>;

  /**
   * Remove a secret by ID (alias for deleteSecret)
   * @param secretId - The unique identifier of the secret
   * @returns True if removal was successful, false otherwise
   */
  removeSecret(secretId: string): Promise<boolean>;

  /**
   * Retrieve a secret by ID
   * @param secretId - The unique identifier of the secret
   * @returns The secret if found, null otherwise
   */
  getSecret(secretId: string): Promise<SelectSecret | null>;

  /**
   * Update a secret by ID
   * @param secretId - The unique identifier of the secret
   * @param secretValue - The new secret value as JSON
   * @returns The updated secret if found, null otherwise
   */
  updateSecret(
    secretId: string,
    secretValue: SecretValue,
  ): Promise<SelectSecret | null>;
}

/**
 * Configuration for Vault SecretManager
 */
export interface VaultConfig {
  /** Vault server address (default: http://localhost:8200) */
  address: string;
  /** Vault token for authentication */
  token: string;
}

/**
 * Database-backed implementation of SecretManager
 * Stores secrets in PostgreSQL database using SecretModel
 */
export class DbSecretsManager implements SecretManager {
  async createSecret(secretValue: SecretValue): Promise<SelectSecret> {
    logger.info("DbSecretsManager.createSecret: creating secret");
    return await SecretModel.create({
      secret: secretValue,
    });
  }

  async deleteSecret(secretId: string): Promise<boolean> {
    logger.info({ recordId: secretId }, "DbSecretsManager.deleteSecret: deleting secret");
    return await SecretModel.delete(secretId);
  }

  async removeSecret(secretId: string): Promise<boolean> {
    // removeSecret is an alias for deleteSecret
    return await this.deleteSecret(secretId);
  }

  async getSecret(secretId: string): Promise<SelectSecret | null> {
    logger.info({ recordId: secretId }, "DbSecretsManager.getSecret: retrieving secret");
    return await SecretModel.findById(secretId);
  }

  async updateSecret(
    secretId: string,
    secretValue: SecretValue,
  ): Promise<SelectSecret | null> {
    logger.info({ recordId: secretId }, "DbSecretsManager.updateSecret: updating secret");
    return await SecretModel.update(secretId, { secret: secretValue });
  }
}

/**
 * Vault-backed implementation of SecretManager
 * Stores secret metadata in PostgreSQL with isVault=true, actual secrets in HashiCorp Vault
 */
export class VaultSecretManager implements SecretManager {
  private client: ReturnType<typeof Vault>;

  constructor(config: VaultConfig) {
    this.client = Vault({
      endpoint: config.address,
      token: config.token,
    });
  }

  private getVaultPath(secretId: string): string {
    return `secret/data/archestra/${secretId}`;
  }

  private getVaultMetadataPath(secretId: string): string {
    return `secret/metadata/archestra/${secretId}`;
  }

  async createSecret(secretValue: SecretValue): Promise<SelectSecret> {
    const dbRecord = await SecretModel.create({
      secret: {},
      isVault: true,
    });

    const vaultPath = this.getVaultPath(dbRecord.id);
    try {
      await this.client.write(vaultPath, {
        data: { value: JSON.stringify(secretValue) },
      });
      logger.info(
        { recordId: dbRecord.id, vaultPath },
        "VaultSecretManager.createSecret: secret created",
      );
    } catch (error) {
      logger.error(
        { recordId: dbRecord.id, vaultPath, error },
        "VaultSecretManager.createSecret: failed, rolling back",
      );
      await SecretModel.delete(dbRecord.id);
      throw error;
    }

    return {
      ...dbRecord,
      secret: secretValue,
    };
  }

  async deleteSecret(secretId: string): Promise<boolean> {
    const dbRecord = await SecretModel.findById(secretId);
    if (!dbRecord) {
      return false;
    }

    if (dbRecord.isVault) {
      const metadataPath = this.getVaultMetadataPath(secretId);
      try {
        // Delete metadata to permanently remove all versions of the secret
        await this.client.delete(metadataPath);
        logger.info(
          { recordId: secretId, metadataPath },
          "VaultSecretManager.deleteSecret: secret permanently deleted",
        );
      } catch (error) {
        logger.error(
          { recordId: secretId, metadataPath, error },
          "VaultSecretManager.deleteSecret: failed",
        );
        throw error;
      }
    }

    return await SecretModel.delete(secretId);
  }

  async removeSecret(secretId: string): Promise<boolean> {
    return await this.deleteSecret(secretId);
  }

  async getSecret(secretId: string): Promise<SelectSecret | null> {
    const dbRecord = await SecretModel.findById(secretId);
    if (!dbRecord) {
      return null;
    }

    if (!dbRecord.isVault) {
      return dbRecord;
    }

    const vaultPath = this.getVaultPath(secretId);
    try {
      const vaultResponse = await this.client.read(vaultPath);
      const secretValue = JSON.parse(
        vaultResponse.data.data.value,
      ) as SecretValue;
      logger.info(
        { recordId: secretId, vaultPath },
        "VaultSecretManager.getSecret: secret retrieved",
      );

      return {
        ...dbRecord,
        secret: secretValue,
      };
    } catch (error) {
      logger.error(
        { recordId: secretId, vaultPath, error },
        "VaultSecretManager.getSecret: failed",
      );
      throw error;
    }
  }

  async updateSecret(
    secretId: string,
    secretValue: SecretValue,
  ): Promise<SelectSecret | null> {
    const dbRecord = await SecretModel.findById(secretId);
    if (!dbRecord) {
      return null;
    }

    if (!dbRecord.isVault) {
      return await SecretModel.update(secretId, { secret: secretValue });
    }

    const vaultPath = this.getVaultPath(secretId);
    try {
      await this.client.write(vaultPath, {
        data: { value: JSON.stringify(secretValue) },
      });
      logger.info(
        { recordId: secretId, vaultPath },
        "VaultSecretManager.updateSecret: secret updated",
      );
    } catch (error) {
      logger.error(
        { recordId: secretId, vaultPath, error },
        "VaultSecretManager.updateSecret: failed",
      );
      throw error;
    }

    const updatedRecord = await SecretModel.update(secretId, { secret: {} });
    if (!updatedRecord) {
      return null;
    }

    return {
      ...updatedRecord,
      secret: secretValue,
    };
  }
}

/**
 * Get Vault configuration from environment variables
 */
export function getVaultConfigFromEnv(): VaultConfig | null {
  const address = process.env.HASHICORP_VAULT_ADDR;
  const token = process.env.HASHICORP_VAULT_TOKEN;

  if (!address || !token) {
    return null;
  }

  return { address, token };
}

/**
 * Supported secrets manager types
 */
export enum SecretsManagerType {
  DB = "DB",
  Vault = "Vault",
}

/**
 * Get the secrets manager type from environment variables
 * @returns SecretsManagerType based on SECRETS_MANAGER env var, defaults to DB
 */
export function getSecretsManagerType(): SecretsManagerType {
  const envValue = process.env.SECRETS_MANAGER?.toUpperCase();

  if (envValue === "VAULT") {
    return SecretsManagerType.Vault;
  }

  return SecretsManagerType.DB;
}

/**
 * Create a secret manager based on environment configuration
 * Uses SECRETS_MANAGER env var to determine the backend:
 * - "Vault": Uses VaultSecretManager (requires HASHICORP_VAULT_ADDR and HASHICORP_VAULT_TOKEN)
 * - "DB" or not set: Uses DbSecretsManager (default)
 */
export function createSecretManager(): SecretManager {
  const managerType = getSecretsManagerType();

  if (managerType === SecretsManagerType.Vault) {
    const vaultConfig = getVaultConfigFromEnv();

    if (!vaultConfig) {
      logger.warn(
        "createSecretManager: SECRETS_MANAGER=Vault but HASHICORP_VAULT_ADDR or HASHICORP_VAULT_TOKEN not set, falling back to DbSecretsManager",
      );
      return new DbSecretsManager();
    }

    logger.info(
      { address: vaultConfig.address },
      "createSecretManager: using VaultSecretManager",
    );
    return new VaultSecretManager(vaultConfig);
  }

  logger.info("createSecretManager: using DbSecretsManager");
  return new DbSecretsManager();
}

/**
 * Default secret manager instance
 */
export const secretManager: SecretManager = createSecretManager();
