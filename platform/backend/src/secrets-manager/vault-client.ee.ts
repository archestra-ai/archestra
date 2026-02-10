import fs from "node:fs/promises";
import { Sha256 } from "@aws-crypto/sha256-js";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import { ApiError } from "@shared/types";
import { SignatureV4 } from "@smithy/signature-v4";
import Vault from "node-vault";
import logger from "@/logging";
import type {
  VaultConfig,
  VaultFolderConnectivityResult,
  VaultSecretListItem,
} from "@/types/secrets-manager";
import { extractVaultErrorMessage } from "./utils";

/**
 * VaultClient - Low-level Vault HTTP/auth client with no database dependencies.
 *
 * Handles all Vault authentication (token, Kubernetes, AWS IAM) and
 * secret retrieval (KV v1/v2) operations. This class is intentionally
 * free of any database or config module imports so it can be used in
 * standalone scripts (e.g. vault-env-injector init container) that run
 * before the database URL is available.
 *
 * ReadonlyVaultSecretManager extends this class to add the DB-dependent
 * ISecretManager interface methods.
 */
export class VaultClient {
  protected client: ReturnType<typeof Vault>;
  protected initialized = false;
  protected config: VaultConfig;

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
          "VaultClient: token is required for token authentication",
        );
      }
      this.client.token = vaultConfig.token;
      this.initialized = true;
    }
  }

  /**
   * Get user-visible debug info about the Vault configuration.
   */
  getUserVisibleDebugInfo(): {
    meta: Record<string, string>;
  } {
    return {
      meta: {
        description: "External Vault (BYOS - Bring Your Own Secrets)",
      },
    };
  }

  /**
   * List secrets in a Vault folder.
   * Requires LIST permission on the folder path.
   */
  async listSecretsInFolder(
    folderPath: string,
  ): Promise<VaultSecretListItem[]> {
    logger.debug(
      { folderPath },
      "VaultClient.listSecretsInFolder: listing secrets",
    );

    try {
      await this.ensureInitialized();
    } catch (error) {
      this.handleVaultError(error, "listSecretsInFolder", { folderPath });
    }

    const listPath = this.getListPath(folderPath);

    try {
      const result = await this.executeWithK8sTokenRefresh(
        () => this.client.list(listPath),
        "listSecretsInFolder",
      );
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
        "VaultClient.listSecretsInFolder: completed",
      );
      return items;
    } catch (error) {
      // Vault returns 404 when the path doesn't exist (no secrets)
      const vaultError = error as { response?: { statusCode?: number } };
      if (vaultError.response?.statusCode === 404) {
        logger.debug(
          { folderPath },
          "VaultClient.listSecretsInFolder: folder empty or not found",
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
      "VaultClient.getSecretFromPath: fetching secret",
    );

    try {
      await this.ensureInitialized();
    } catch (error) {
      this.handleVaultError(error, "getSecretFromPath", { vaultPath });
    }

    try {
      const vaultResponse = await this.executeWithK8sTokenRefresh(
        () => this.client.read(vaultPath),
        "getSecretFromPath",
      );
      const secretData = this.extractSecretData(vaultResponse);

      logger.info(
        { vaultPath, kvVersion: this.config.kvVersion },
        "VaultClient.getSecretFromPath: secret retrieved",
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
      "VaultClient.checkFolderConnectivity: checking connectivity",
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
      const result = await this.executeWithK8sTokenRefresh(
        () => this.client.list(listPath),
        "checkFolderConnectivity",
      );
      const keys = (result?.data?.keys as string[] | undefined) ?? [];
      const secretCount = keys.filter((key) => !key.endsWith("/")).length;

      logger.info(
        { folderPath, secretCount },
        "VaultClient.checkFolderConnectivity: connected",
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
          "VaultClient.checkFolderConnectivity: connected (empty folder)",
        );
        return {
          connected: true,
          secretCount: 0,
        };
      }

      const errorMessage = extractVaultErrorMessage(error);
      logger.warn(
        { folderPath, error: errorMessage },
        "VaultClient.checkFolderConnectivity: failed",
      );

      return {
        connected: false,
        secretCount: 0,
        error: errorMessage,
      };
    }
  }

  // ============================================================
  // Protected methods (used by ReadonlyVaultSecretManager subclass)
  // ============================================================

  /**
   * Ensure authentication is complete before any operation.
   */
  protected async ensureInitialized(): Promise<void> {
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
      logger.error({ error }, "VaultClient: initialization failed");
      throw new ApiError(500, extractVaultErrorMessage(error));
    }
  }

  /**
   * Handle Vault operation errors by logging and throwing user-friendly ApiError
   */
  protected handleVaultError(
    error: unknown,
    operationName: string,
    context: Record<string, unknown> = {},
  ): never {
    logger.error({ error, ...context }, `VaultClient.${operationName}: failed`);

    if (error instanceof ApiError) {
      throw error;
    }

    throw new ApiError(500, extractVaultErrorMessage(error));
  }

  // ============================================================
  // Private methods
  // ============================================================

  /**
   * Check if an error is a 4xx HTTP error from Vault
   */
  private isVault4xxError(error: unknown): boolean {
    const vaultError = error as { response?: { statusCode?: number } };
    const statusCode = vaultError.response?.statusCode;
    return statusCode !== undefined && statusCode >= 400 && statusCode < 500;
  }

  /**
   * Execute a Vault operation with automatic token refresh for K8s auth.
   * If a 4xx error occurs and K8s auth is used, re-authenticate and retry once.
   */
  private async executeWithK8sTokenRefresh<T>(
    operation: () => Promise<T>,
    operationName: string,
  ): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      // Only retry for K8s auth method and 4xx errors
      if (
        this.config.authMethod !== "kubernetes" ||
        !this.isVault4xxError(error)
      ) {
        throw error;
      }

      logger.info(
        { operationName },
        "VaultClient: received 4xx error with K8s auth, re-authenticating",
      );

      // Reset initialization state and re-authenticate
      this.initialized = false;
      try {
        await this.ensureInitialized();
      } catch (authError) {
        logger.error(
          { authError, operationName },
          "VaultClient: re-authentication failed after 4xx error",
        );
        throw authError;
      }

      // Retry the operation once
      return await operation();
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
        "VaultClient: authenticated via Kubernetes auth",
      );
    } catch (error) {
      logger.error(
        { error, tokenPath, role: this.config.k8sRole },
        "VaultClient: Kubernetes authentication failed",
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
        "VaultClient: authenticated via AWS IAM auth",
      );
    } catch (error) {
      logger.error(
        { error, role: this.config.awsRole, region, mountPoint },
        "VaultClient: AWS IAM authentication failed",
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
}
