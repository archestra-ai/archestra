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
    return await SecretModel.create({
      secret: secretValue,
    });
  }

  async deleteSecret(secid: string): Promise<boolean> {
    return await SecretModel.delete(secid);
  }

  async removeSecret(secid: string): Promise<boolean> {
    return await this.deleteSecret(secid);
  }

  async getSecret(secid: string): Promise<SelectSecret | null> {
    return await SecretModel.findById(secid);
  }

  async updateSecret(
    secid: string,
    secretValue: SecretValue,
  ): Promise<SelectSecret | null> {
    return await SecretModel.update(secid, { secret: secretValue });
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

  private getVaultPath(secid: string): string {
    return `secret/data/archestra/${secid}`;
  }

  private getVaultMetadataPath(secid: string): string {
    return `secret/metadata/archestra/${secid}`;
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
        { vaultPath },
        "VaultSecretManager.createSecret: secret created",
      );
    } catch (error) {
      logger.error(
        { vaultPath, error },
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

  async deleteSecret(secid: string): Promise<boolean> {
    const dbRecord = await SecretModel.findById(secid);
    if (!dbRecord) {
      return false;
    }

    if (dbRecord.isVault) {
      const metadataPath = this.getVaultMetadataPath(secid);
      try {
        // Delete metadata to permanently remove all versions of the secret
        await this.client.delete(metadataPath);
        logger.info(
          { metadataPath },
          "VaultSecretManager.deleteSecret: secret permanently deleted",
        );
      } catch (error) {
        logger.error(
          { metadataPath, error },
          "VaultSecretManager.deleteSecret: failed",
        );
        throw error;
      }
    }

    return await SecretModel.delete(secid);
  }

  async removeSecret(secid: string): Promise<boolean> {
    return await this.deleteSecret(secid);
  }

  async getSecret(secid: string): Promise<SelectSecret | null> {
    const dbRecord = await SecretModel.findById(secid);
    if (!dbRecord) {
      return null;
    }

    if (!dbRecord.isVault) {
      return dbRecord;
    }

    const vaultPath = this.getVaultPath(secid);
    try {
      const vaultResponse = await this.client.read(vaultPath);
      const secretValue = JSON.parse(
        vaultResponse.data.data.value,
      ) as SecretValue;
      logger.info(
        { vaultPath },
        "VaultSecretManager.getSecret: secret retrieved",
      );

      return {
        ...dbRecord,
        secret: secretValue,
      };
    } catch (error) {
      logger.error(
        { vaultPath, error },
        "VaultSecretManager.getSecret: failed",
      );
      throw error;
    }
  }

  async updateSecret(
    secid: string,
    secretValue: SecretValue,
  ): Promise<SelectSecret | null> {
    const dbRecord = await SecretModel.findById(secid);
    if (!dbRecord) {
      return null;
    }

    if (!dbRecord.isVault) {
      return await SecretModel.update(secid, { secret: secretValue });
    }

    const vaultPath = this.getVaultPath(secid);
    try {
      await this.client.write(vaultPath, {
        data: { value: JSON.stringify(secretValue) },
      });
      logger.info(
        { vaultPath },
        "VaultSecretManager.updateSecret: secret updated",
      );
    } catch (error) {
      logger.error(
        { vaultPath, error },
        "VaultSecretManager.updateSecret: failed",
      );
      throw error;
    }

    const updatedRecord = await SecretModel.update(secid, { secret: {} });
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
