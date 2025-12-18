import fs from "node:fs/promises";
import { Sha256 } from "@aws-crypto/sha256-js";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import { SecretsManagerType } from "@shared";
import { SignatureV4 } from "@smithy/signature-v4";
import Vault from "node-vault";
import logger from "./logging";
import SecretModel from "./models/secret";
import type {
  ISecretManager,
  SecretsConnectivityResult,
  VaultConfig,
  VaultFolderConnectivityResult,
  VaultSecretListItem,
} from "./secretmanager.types";
import { extractVaultErrorMessage } from "./secretmanager.utils";
import {
  ApiError,
  parseVaultSecretReference,
  type SecretValue,
  type SelectSecret,
} from "./types";

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
 */
export default class ReadonlyVaultSecretManager implements ISecretManager {
  readonly type = SecretsManagerType.BYOS_VAULT;
  private client: ReturnType<typeof Vault>;
  private initialized = false;
  private config: VaultConfig;

  constructor(vaultConfig: VaultConfig) {
    this.config = vaultConfig;
    // Normalize endpoint: remove trailing slash to avoid double-slash URLs
    const normalizedEndpoint = vaultConfig.address.replace(/\/+$/, "");
    this.client = Vault({
      endpoint: normalizedEndpoint,
    });

    if (vaultConfig.authMethod === "token") {
      if (!vaultConfig.token) {
        throw new Error(
          "BYOSVaultSecretManager: token is required for token authentication",
        );
      }
      this.client.token = vaultConfig.token;
      this.initialized = true;
    }
  }

  /**
   * Ensure authentication is complete before any operation.
   */
  private async ensureInitialized(): Promise<void> {
    if (this.initialized) {
      return;
    }

    try {
      if (this.config.authMethod === "kubernetes") {
        await this.loginWithKubernetes();
      } else if (this.config.authMethod === "aws") {
        await this.loginWithAws();
      }
      this.initialized = true;
    } catch (error) {
      logger.error({ error }, "BYOSVaultSecretManager: initialization failed");
      throw new ApiError(500, extractVaultErrorMessage(error));
    }
  }

  /**
   * Authenticate with Vault using Kubernetes service account token
   */
  private async loginWithKubernetes(): Promise<void> {
    const tokenPath = this.config.k8sTokenPath as string;

    try {
      const jwt = await fs.readFile(tokenPath, "utf-8");

      const result = await this.client.kubernetesLogin({
        mount_point: this.config.k8sMountPoint as string,
        role: this.config.k8sRole,
        jwt: jwt.trim(),
      });

      this.client.token = result.auth.client_token;
      logger.info(
        { role: this.config.k8sRole, mountPoint: this.config.k8sMountPoint },
        "BYOSVaultSecretManager: authenticated via Kubernetes auth",
      );
    } catch (error) {
      logger.error(
        { error, tokenPath, role: this.config.k8sRole },
        "BYOSVaultSecretManager: Kubernetes authentication failed",
      );
      throw new ApiError(500, extractVaultErrorMessage(error));
    }
  }

  /**
   * Authenticate with Vault using AWS IAM credentials
   */
  private async loginWithAws(): Promise<void> {
    const region = this.config.awsRegion;
    const mountPoint = this.config.awsMountPoint;
    const stsEndpoint = this.config.awsStsEndpoint;

    try {
      const credentialProvider = fromNodeProviderChain();
      const credentials = await credentialProvider();

      const stsUrl = stsEndpoint.endsWith("/")
        ? stsEndpoint
        : `${stsEndpoint}/`;

      const requestBody = "Action=GetCallerIdentity&Version=2011-06-15";

      const url = new URL(stsUrl);
      const headers: Record<string, string> = {
        host: url.host,
        "content-type": "application/x-www-form-urlencoded; charset=utf-8",
      };

      if (this.config.awsIamServerIdHeader) {
        headers["x-vault-aws-iam-server-id"] = this.config.awsIamServerIdHeader;
      }

      const signer = new SignatureV4({
        service: "sts",
        region,
        credentials,
        sha256: Sha256,
      });

      const signedRequest = await signer.sign({
        method: "POST",
        protocol: url.protocol,
        hostname: url.hostname,
        path: url.pathname,
        headers,
        body: requestBody,
      });

      const loginPayload = {
        role: this.config.awsRole,
        iam_http_request_method: "POST",
        iam_request_url: Buffer.from(stsUrl).toString("base64"),
        iam_request_body: Buffer.from(requestBody).toString("base64"),
        iam_request_headers: Buffer.from(
          JSON.stringify(signedRequest.headers),
        ).toString("base64"),
      };

      const result = await this.client.write(
        `auth/${mountPoint}/login`,
        loginPayload,
      );

      this.client.token = result.auth.client_token;
      logger.info(
        { role: this.config.awsRole, region, mountPoint },
        "BYOSVaultSecretManager: authenticated via AWS IAM auth",
      );
    } catch (error) {
      logger.error(
        { error, role: this.config.awsRole, region, mountPoint },
        "BYOSVaultSecretManager: AWS IAM authentication failed",
      );
      throw error;
    }
  }

  /**
   * Get the list path for a folder based on KV version.
   * KV v2 requires using the metadata path for list operations.
   */
  private getListPath(folderPath: string): string {
    if (this.config.kvVersion === "1") {
      return folderPath;
    }
    // For KV v2, replace /data/ with /metadata/ in the path
    return folderPath.replace("/data/", "/metadata/");
  }

  /**
   * Extract secret data from Vault read response based on KV version.
   * KV v1: data is at vaultResponse.data
   * KV v2: data is at vaultResponse.data.data
   */
  private extractSecretData(vaultResponse: {
    data: Record<string, unknown>;
  }): Record<string, string> {
    if (this.config.kvVersion === "1") {
      return vaultResponse.data as Record<string, string>;
    }
    return vaultResponse.data.data as unknown as Record<string, string>;
  }

  /**
   * Handle Vault operation errors by logging and throwing user-friendly ApiError
   */
  private handleVaultError(
    error: unknown,
    operationName: string,
    context: Record<string, unknown> = {},
  ): never {
    logger.error(
      { error, ...context },
      `BYOSVaultSecretManager.${operationName}: failed`,
    );

    if (error instanceof ApiError) {
      throw error;
    }

    throw new ApiError(500, extractVaultErrorMessage(error));
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

    return await SecretModel.update(secretId, { secret: _secretValue });
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

  /**
   * Get user-visible debug info about the secrets manager configuration.
   */
  getUserVisibleDebugInfo(): {
    type: SecretsManagerType;
    meta: Record<string, string>;
  } {
    return {
      type: this.type,
      meta: {
        description: "External Vault (BYOS - Bring Your Own Secrets)",
      },
    };
  }

  // ============================================================
  // Additional BYOS-specific methods (for route/service use)
  // ============================================================

  /**
   * List secrets in a Vault folder.
   * Requires LIST permission on the folder path.
   */
  async listSecretsInFolder(
    folderPath: string,
  ): Promise<VaultSecretListItem[]> {
    logger.debug(
      { folderPath },
      "BYOSVaultSecretManager.listSecretsInFolder: listing secrets",
    );

    try {
      await this.ensureInitialized();
    } catch (error) {
      this.handleVaultError(error, "listSecretsInFolder", { folderPath });
    }

    const listPath = this.getListPath(folderPath);

    try {
      const result = await this.client.list(listPath);
      const keys = (result?.data?.keys as string[] | undefined) ?? [];

      // Filter out folder entries (they end with /)
      const secretKeys = keys.filter((key) => !key.endsWith("/"));

      // Normalize folder path by removing trailing slashes to avoid double slashes in the path
      const normalizedFolderPath = folderPath.replace(/\/+$/, "");

      const items: VaultSecretListItem[] = secretKeys.map((name) => ({
        name,
        path: `${normalizedFolderPath}/${name}`,
      }));

      logger.info(
        { folderPath, count: items.length },
        "BYOSVaultSecretManager.listSecretsInFolder: completed",
      );
      return items;
    } catch (error) {
      // Vault returns 404 when the path doesn't exist (no secrets)
      const vaultError = error as { response?: { statusCode?: number } };
      if (vaultError.response?.statusCode === 404) {
        logger.debug(
          { folderPath },
          "BYOSVaultSecretManager.listSecretsInFolder: folder empty or not found",
        );
        return [];
      }

      this.handleVaultError(error, "listSecretsInFolder", { folderPath });
    }
  }

  /**
   * Get a secret from a specific Vault path.
   * Returns the secret data as key-value pairs.
   */
  async getSecretFromPath(vaultPath: string): Promise<Record<string, string>> {
    logger.debug(
      { vaultPath },
      "BYOSVaultSecretManager.getSecretFromPath: fetching secret",
    );

    try {
      await this.ensureInitialized();
    } catch (error) {
      this.handleVaultError(error, "getSecretFromPath", { vaultPath });
    }

    try {
      const vaultResponse = await this.client.read(vaultPath);
      const secretData = this.extractSecretData(vaultResponse);

      logger.info(
        { vaultPath, kvVersion: this.config.kvVersion },
        "BYOSVaultSecretManager.getSecretFromPath: secret retrieved",
      );

      return secretData;
    } catch (error) {
      this.handleVaultError(error, "getSecretFromPath", { vaultPath });
    }
  }

  /**
   * Check connectivity to a Vault folder path.
   * Returns connection status and secret count.
   */
  async checkFolderConnectivity(
    folderPath: string,
  ): Promise<VaultFolderConnectivityResult> {
    logger.debug(
      { folderPath },
      "BYOSVaultSecretManager.checkFolderConnectivity: checking connectivity",
    );

    try {
      await this.ensureInitialized();
    } catch (error) {
      const errorMessage = extractVaultErrorMessage(error);
      return {
        connected: false,
        secretCount: 0,
        error: `Authentication failed: ${errorMessage}`,
      };
    }

    const listPath = this.getListPath(folderPath);

    try {
      const result = await this.client.list(listPath);
      const keys = (result?.data?.keys as string[] | undefined) ?? [];
      const secretCount = keys.filter((key) => !key.endsWith("/")).length;

      logger.info(
        { folderPath, secretCount },
        "BYOSVaultSecretManager.checkFolderConnectivity: connected",
      );

      return {
        connected: true,
        secretCount,
      };
    } catch (error) {
      const vaultError = error as { response?: { statusCode?: number } };

      // 404 means path exists but is empty - still connected
      if (vaultError.response?.statusCode === 404) {
        logger.info(
          { folderPath },
          "BYOSVaultSecretManager.checkFolderConnectivity: connected (empty folder)",
        );
        return {
          connected: true,
          secretCount: 0,
        };
      }

      const errorMessage = extractVaultErrorMessage(error);
      logger.warn(
        { folderPath, error: errorMessage },
        "BYOSVaultSecretManager.checkFolderConnectivity: failed",
      );

      return {
        connected: false,
        secretCount: 0,
        error: errorMessage,
      };
    }
  }
}
