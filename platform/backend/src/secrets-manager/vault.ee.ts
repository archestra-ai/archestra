import { SecretsManagerType } from "@shared";
import logger from "@/logging";
import SecretModel from "@/models/secret";
import {
  ApiError,
  type ISecretManager,
  type SecretsConnectivityResult,
  type SecretValue,
  type SelectSecret,
  type VaultConfig,
} from "@/types";
import { extractVaultErrorMessage } from "./utils";
import { VaultClient } from "./vault-client.ee";

/**
 * Vault-backed implementation of SecretManager
 * Stores secret metadata in PostgreSQL with isVault=true, actual secrets in HashiCorp Vault
 *
 * Extends VaultClient which handles all Vault HTTP/auth logic (token, K8s, AWS IAM)
 * and secret retrieval (KV v1/v2). This class adds the DB-dependent ISecretManager methods.
 */
export default class VaultSecretManager
  extends VaultClient
  implements ISecretManager
{
  readonly type = SecretsManagerType.Vault;

  constructor(config: VaultConfig) {
    super(config);

    if (config.authMethod === "kubernetes") {
      if (!config.k8sRole) {
        throw new Error(
          "VaultSecretManager: k8sRole is required for Kubernetes authentication",
        );
      }
    } else if (config.authMethod === "aws") {
      if (!config.awsRole) {
        throw new Error(
          "VaultSecretManager: awsRole is required for AWS IAM authentication",
        );
      }
    } else if (config.authMethod !== "token") {
      throw new Error("VaultSecretManager: invalid authentication method");
    }
  }

  /**
   * Handle Vault operation errors by logging and throwing user-friendly ApiError
   */
  protected override handleVaultError(
    error: unknown,
    operationName: string,
    context: Record<string, unknown> = {},
  ): never {
    logger.error(
      { error, vaultError: extractVaultErrorMessage(error), ...context },
      `VaultSecretManager.${operationName}: failed`,
    );

    if (error instanceof ApiError) {
      throw error;
    }

    throw new ApiError(
      500,
      "An error occurred while accessing secrets. Please try again later or contact your administrator.",
    );
  }

  async createSecret(
    secretValue: SecretValue,
    name: string,
    forceDB?: boolean,
  ): Promise<SelectSecret> {
    // If forceDB is true, store directly in database (e.g., for OAuth tokens)
    if (forceDB) {
      logger.info(
        { name },
        "VaultSecretManager.createSecret: forceDB=true, storing in database",
      );
      return await SecretModel.create({
        name,
        secret: secretValue,
      });
    }

    const sanitizedName = sanitizeVaultSecretName(name);

    const dbRecord = await SecretModel.create({
      name: sanitizedName,
      secret: {},
      isVault: true,
    });

    const vaultPath = this.getVaultPath(dbRecord.name, dbRecord.id);
    try {
      await this.writeToPath(
        vaultPath,
        this.buildWritePayload({ value: JSON.stringify(secretValue) }),
      );
      logger.info(
        { vaultPath, kvVersion: this.config.kvVersion },
        "VaultSecretManager.createSecret: secret created",
      );
    } catch (error) {
      await SecretModel.delete(dbRecord.id);
      this.handleVaultError(error, "createSecret", { vaultPath });
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
      const deletePath = this.getVaultMetadataPath(dbRecord.name, secid);
      try {
        await this.deleteAtPath(deletePath);
        logger.info(
          { deletePath, kvVersion: this.config.kvVersion },
          `VaultSecretManager.deleteSecret: secret ${this.config.kvVersion === "1" ? "deleted" : "permanently deleted"}`,
        );
      } catch (error) {
        this.handleVaultError(error, "deleteSecret", { deletePath });
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

    const vaultPath = this.getVaultPath(dbRecord.name, secid);
    try {
      const vaultResponse = await this.readFromPath(vaultPath);
      const secretData = this.extractSecretData(vaultResponse);
      const secretValue = JSON.parse(secretData.value) as SecretValue;
      logger.info(
        { vaultPath, kvVersion: this.config.kvVersion },
        "VaultSecretManager.getSecret: secret retrieved",
      );

      return {
        ...dbRecord,
        secret: secretValue,
      };
    } catch (error) {
      this.handleVaultError(error, "getSecret", { vaultPath });
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

    const vaultPath = this.getVaultPath(dbRecord.name, secid);
    try {
      await this.writeToPath(
        vaultPath,
        this.buildWritePayload({ value: JSON.stringify(secretValue) }),
      );
      logger.info(
        { vaultPath, kvVersion: this.config.kvVersion },
        "VaultSecretManager.updateSecret: secret updated",
      );
    } catch (error) {
      this.handleVaultError(error, "updateSecret", { vaultPath });
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

  async checkConnectivity(): Promise<SecretsConnectivityResult> {
    const listBasePath = this.getListBasePath();

    try {
      const keys = await this.listKeysAtPath(listBasePath);
      return { secretCount: keys.length };
    } catch (error) {
      logger.error(
        { error, listBasePath, kvVersion: this.config.kvVersion },
        "VaultSecretManager.checkConnectivity: failed to list secrets",
      );
      throw new ApiError(500, extractVaultErrorMessage(error));
    }
  }

  override getUserVisibleDebugInfo() {
    const meta: Record<string, string> = {
      "KV Version": this.config.kvVersion,
      "Secret Path": this.config.secretPath,
      "Kubernetes Token Path": this.config.k8sTokenPath,
      "Kubernetes Mount Point": this.config.k8sMountPoint,
    };

    if (this.config.kvVersion === "2") {
      meta["Metadata Path"] = this.getListBasePath();
    }

    return {
      type: this.type,
      meta,
    };
  }

  // ============================================================
  // Private methods
  // ============================================================

  private getVaultPath(name: string, id: string): string {
    const basePath = this.config.secretPath;
    return `${basePath}/${name}-${id}`;
  }

  private getVaultMetadataPath(name: string, id: string): string {
    // KV v1 doesn't have separate metadata path - use the same path as read/write
    if (this.config.kvVersion === "1") {
      return this.getVaultPath(name, id);
    }

    // KV v2: Use configured metadata path, or fallback to replacing /data/ with /metadata/
    const metadataPath =
      this.config.secretMetadataPath ??
      this.config.secretPath.replace("/data/", "/metadata/");
    return `${metadataPath}/${name}-${id}`;
  }

  /**
   * Get the base path for listing secrets based on KV version
   * v2: Uses metadata path
   * v1: Uses the same secret path
   */
  private getListBasePath(): string {
    if (this.config.kvVersion === "1") {
      return this.config.secretPath;
    }
    return (
      this.config.secretMetadataPath ??
      this.config.secretPath.replace("/data/", "/metadata/")
    );
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
