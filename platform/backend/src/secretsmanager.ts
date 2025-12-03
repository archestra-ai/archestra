import Vault from "node-vault";
import config from "@/config";
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
   * @param name - Human-readable name to identify the secret in external storage
   * @returns The created secret with generated ID
   */
  createSecret(secretValue: SecretValue, name: string): Promise<SelectSecret>;

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
 * Vault authentication method
 */
export type VaultAuthMethod = "token" | "kubernetes";

/**
 * Configuration for Vault SecretManager
 */
export interface VaultConfig {
  /** Vault server address (default: http://localhost:8200) */
  address: string;
  /** Authentication method to use */
  authMethod: VaultAuthMethod;
  /** Vault token for authentication (required for token auth) */
  token?: string;
  /** Kubernetes auth role (required for kubernetes auth) */
  k8sRole?: string;
  /** Path to service account token file (defaults to /var/run/secrets/kubernetes.io/serviceaccount/token) */
  k8sTokenPath?: string;
}

/**
 * Database-backed implementation of SecretManager
 * Stores secrets in PostgreSQL database using SecretModel
 */
export class DbSecretsManager implements SecretManager {
  async createSecret(
    secretValue: SecretValue,
    name: string,
  ): Promise<SelectSecret> {
    return await SecretModel.create({
      name,
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
 * Sanitize a name to conform to Vault secret naming rules:
 * - Must be between 1 and 64 characters
 * - Must start with ASCII letter or '_'
 * - Must only contain ASCII letters, digits, or '_'
 */
function sanitizeVaultSecretName(name: string): string {
  if (!name || name.trim().length === 0) {
    return "secret";
  }

  // Replace any non-alphanumeric character (except underscore) with underscore
  let sanitized = name.replace(/[^a-zA-Z0-9_]/g, "_");

  // Ensure it starts with a letter or underscore
  if (!/^[a-zA-Z_]/.test(sanitized)) {
    sanitized = `_${sanitized}`;
  }

  // Trim to 64 characters
  sanitized = sanitized.slice(0, 64);

  return sanitized;
}

/** Default path to Kubernetes service account token */
const DEFAULT_K8S_TOKEN_PATH =
  "/var/run/secrets/kubernetes.io/serviceaccount/token";

/**
 * Vault-backed implementation of SecretManager
 * Stores secret metadata in PostgreSQL with isVault=true, actual secrets in HashiCorp Vault
 */
export class VaultSecretManager implements SecretManager {
  private client: ReturnType<typeof Vault>;
  private initialized: Promise<void>;
  private config: VaultConfig;

  constructor(config: VaultConfig) {
    this.config = config;
    this.client = Vault({
      endpoint: config.address,
    });

    if (config.authMethod === "kubernetes") {
      if (!config.k8sRole) {
        throw new Error(
          "VaultSecretManager: k8sRole is required for Kubernetes authentication",
        );
      }
      this.initialized = this.loginWithKubernetes();
    } else {
      if (!config.token) {
        throw new Error(
          "VaultSecretManager: token is required for token authentication",
        );
      }
      this.client.token = config.token;
      this.initialized = Promise.resolve();
    }
  }

  /**
   * Authenticate with Vault using Kubernetes service account token
   */
  private async loginWithKubernetes(): Promise<void> {
    const tokenPath = this.config.k8sTokenPath ?? DEFAULT_K8S_TOKEN_PATH;

    try {
      const fs = await import("node:fs/promises");
      const jwt = await fs.readFile(tokenPath, "utf-8");

      const result = await this.client.kubernetesLogin({
        role: this.config.k8sRole,
        jwt: jwt.trim(),
      });

      this.client.token = result.auth.client_token;
      logger.info(
        { role: this.config.k8sRole },
        "VaultSecretManager: authenticated via Kubernetes auth",
      );
    } catch (error) {
      logger.error(
        { error, tokenPath, role: this.config.k8sRole },
        "VaultSecretManager: Kubernetes authentication failed",
      );
      throw error;
    }
  }

  /**
   * Ensure authentication is complete before any operation
   */
  private async ensureInitialized(): Promise<void> {
    await this.initialized;
  }

  private getVaultPath(name: string, id: string): string {
    return `secret/data/archestra/${name}-${id}`;
  }

  private getVaultMetadataPath(name: string, id: string): string {
    return `secret/metadata/archestra/${name}-${id}`;
  }

  async createSecret(
    secretValue: SecretValue,
    name: string,
  ): Promise<SelectSecret> {
    await this.ensureInitialized();

    // Sanitize name to conform to Vault naming rules
    const sanitizedName = sanitizeVaultSecretName(name);

    const dbRecord = await SecretModel.create({
      name: sanitizedName,
      secret: {},
      isVault: true,
    });

    const vaultPath = this.getVaultPath(dbRecord.name, dbRecord.id);
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
    await this.ensureInitialized();

    const dbRecord = await SecretModel.findById(secid);
    if (!dbRecord) {
      return false;
    }

    if (dbRecord.isVault) {
      const metadataPath = this.getVaultMetadataPath(dbRecord.name, secid);
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
    await this.ensureInitialized();

    const dbRecord = await SecretModel.findById(secid);
    if (!dbRecord) {
      return null;
    }

    if (!dbRecord.isVault) {
      return dbRecord;
    }

    const vaultPath = this.getVaultPath(dbRecord.name, secid);
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
    await this.ensureInitialized();

    const dbRecord = await SecretModel.findById(secid);
    if (!dbRecord) {
      return null;
    }

    if (!dbRecord.isVault) {
      return await SecretModel.update(secid, { secret: secretValue });
    }

    const vaultPath = this.getVaultPath(dbRecord.name, secid);
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
 *
 * Supports two authentication methods:
 * 1. Token auth: ARCHESTRA_HASHICORP_VAULT_ADDR + ARCHESTRA_HASHICORP_VAULT_TOKEN
 * 2. Kubernetes auth: ARCHESTRA_HASHICORP_VAULT_ADDR + ARCHESTRA_HASHICORP_VAULT_K8S_AUTH=true + ARCHESTRA_HASHICORP_VAULT_K8S_ROLE
 *
 * Kubernetes auth takes precedence if ARCHESTRA_HASHICORP_VAULT_K8S_AUTH is set to "true"
 *
 * Note: Legacy HASHICORP_VAULT_* env vars are still supported for backward compatibility
 */
export function getVaultConfigFromEnv(): VaultConfig | null {
  // Support both new ARCHESTRA_HASHICORP_ prefix and legacy HASHICORP_ prefix
  const address =
    process.env.ARCHESTRA_HASHICORP_VAULT_ADDR ??
    process.env.HASHICORP_VAULT_ADDR;

  if (!address) {
    return null;
  }

  const useK8s =
    process.env.ARCHESTRA_HASHICORP_VAULT_K8S_AUTH?.toLowerCase() === "true";

  if (useK8s) {
    const k8sRole = process.env.ARCHESTRA_HASHICORP_VAULT_K8S_ROLE;
    if (!k8sRole) {
      logger.warn(
        "getVaultConfigFromEnv: Kubernetes auth enabled but ARCHESTRA_HASHICORP_VAULT_K8S_ROLE is not set",
      );
      return null;
    }

    return {
      address,
      authMethod: "kubernetes",
      k8sRole,
      k8sTokenPath: process.env.ARCHESTRA_HASHICORP_VAULT_K8S_TOKEN_PATH,
    };
  }

  // Fall back to token auth
  const token =
    process.env.ARCHESTRA_HASHICORP_VAULT_TOKEN ??
    process.env.HASHICORP_VAULT_TOKEN;
  if (!token) {
    return null;
  }

  return {
    address,
    authMethod: "token",
    token,
  };
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
 * @returns SecretsManagerType based on ARCHESTRA_SECRETS_MANAGER env var, defaults to DB
 */
export function getSecretsManagerType(): SecretsManagerType {
  const envValue = process.env.ARCHESTRA_SECRETS_MANAGER?.toUpperCase();

  if (envValue === "VAULT") {
    return SecretsManagerType.Vault;
  }

  return SecretsManagerType.DB;
}

/**
 * Create a secret manager based on environment configuration
 * Uses ARCHESTRA_SECRETS_MANAGER env var to determine the backend:
 * - "Vault": Uses VaultSecretManager with either:
 *   - Token auth: HASHICORP_VAULT_ADDR + HASHICORP_VAULT_TOKEN
 *   - Kubernetes auth: HASHICORP_VAULT_ADDR + HASHICORP_VAULT_USE_K8S=true + HASHICORP_VAULT_K8S_ROLE
 * - "DB" or not set: Uses DbSecretsManager (default)
 */
export function createSecretManager(): SecretManager {
  const managerType = getSecretsManagerType();

  if (managerType === SecretsManagerType.Vault) {
    if (!config.enterpriseLicenseActivated) {
      logger.warn(
        "createSecretManager: ARCHESTRA_SECRETS_MANAGER=Vault configured but Archestra enterprise license is not activated, falling back to DbSecretsManager.",
      );
      return new DbSecretsManager();
    }

    const vaultConfig = getVaultConfigFromEnv();

    if (!vaultConfig) {
      logger.warn(
        "createSecretManager: ARCHESTRA_SECRETS_MANAGER=Vault but Vault configuration is incomplete. " +
          "Either set ARCHESTRA_HASHICORP_VAULT_TOKEN for token auth, or set ARCHESTRA_HASHICORP_VAULT_K8S_AUTH=true and ARCHESTRA_HASHICORP_VAULT_K8S_ROLE for K8s auth. " +
          "Falling back to DbSecretsManager.",
      );
      return new DbSecretsManager();
    }

    logger.info(
      { address: vaultConfig.address, authMethod: vaultConfig.authMethod },
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
