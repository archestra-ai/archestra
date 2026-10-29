import fs from "node:fs/promises";
import { ApiError } from "@archestra/shared";
import { Sha256 } from "@aws-crypto/sha256-js";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import { SignatureV4 } from "@smithy/signature-v4";
import Vault from "node-vault";
import logger from "@/logging";
import {
  SECRETS_MANAGER_UNAVAILABLE_INTERNAL_CODE,
  type VaultConfig,
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
 * VaultSecretManager extends this class
 * to add the DB-dependent ISecretManager interface methods.
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
        description: "Vault",
      },
    };
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
      const vaultResponse = await this.executeWithTokenRefresh(
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
      const vaultError = error as { response?: { statusCode?: number } };
      if (vaultError.response?.statusCode === 404) {
        throw new ApiError(
          404,
          "Vault secret not found. Check the selected secret path.",
        );
      }
      this.handleVaultError(error, "getSecretFromPath", { vaultPath });
    }
  }

  // ============================================================
  // Protected methods (used by subclasses)
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
      const apiError = new ApiError(
        503,
        extractVaultErrorMessage(error),
        SECRETS_MANAGER_UNAVAILABLE_INTERNAL_CODE,
      );
      apiError.cause = error;
      throw apiError;
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

    const apiError = new ApiError(
      503,
      extractVaultErrorMessage(error),
      SECRETS_MANAGER_UNAVAILABLE_INTERNAL_CODE,
    );
    apiError.cause = error;
    throw apiError;
  }

  /**
   * Build the write payload based on KV version.
   * KV v2 requires wrapping data in { data: ... }.
   */
  protected buildWritePayload(
    data: Record<string, unknown>,
  ): Record<string, unknown> {
    if (this.config.kvVersion === "1") {
      return data;
    }
    return { data };
  }

  /**
   * Write data to a Vault path with auth and token refresh.
   */
  protected async writeToPath(
    path: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await this.ensureInitialized();
    await this.executeWithTokenRefresh(
      () => this.client.write(path, payload),
      "writeToPath",
    );
  }

  /**
   * Delete a secret at a Vault path with auth and token refresh.
   */
  protected async deleteAtPath(path: string): Promise<void> {
    await this.ensureInitialized();
    await this.executeWithTokenRefresh(
      () => this.client.delete(path),
      "deleteAtPath",
    );
  }

  /**
   * Read a secret from a Vault path with auth and token refresh.
   */
  protected async readFromPath(
    path: string,
  ): Promise<{ data: Record<string, unknown> }> {
    await this.ensureInitialized();
    return await this.executeWithTokenRefresh(
      () => this.client.read(path),
      "readFromPath",
    );
  }

  /**
   * List keys at a Vault path with auth and token refresh.
   * Returns an empty array if the path does not exist (404).
   */
  protected async listKeysAtPath(path: string): Promise<string[]> {
    await this.ensureInitialized();
    try {
      const result = await this.executeWithTokenRefresh(
        () => this.client.list(path),
        "listKeysAtPath",
      );
      return (result?.data?.keys as string[] | undefined) ?? [];
    } catch (error) {
      const vaultError = error as { response?: { statusCode?: number } };
      if (vaultError.response?.statusCode === 404) {
        return [];
      }
      throw error;
    }
  }

  /**
   * Get the list path for a folder based on KV version.
   * KV v2 requires using the metadata path for list operations.
   */

  /**
   * Extract secret data from Vault read response based on KV version.
   * KV v1: data is at vaultResponse.data
   * KV v2: data is at vaultResponse.data.data
   */
  protected extractSecretData(vaultResponse: {
    data: Record<string, unknown>;
  }): Record<string, string> {
    if (this.config.kvVersion === "1") {
      return vaultResponse.data as Record<string, string>;
    }
    return vaultResponse.data.data as unknown as Record<string, string>;
  }

  // ============================================================
  // Private methods
  // ============================================================

  /**
   * Check whether refreshing a login-issued token could recover the request.
   */
  private isVaultAuthenticationError(error: unknown): boolean {
    const vaultError = error as { response?: { statusCode?: number } };
    const statusCode = vaultError.response?.statusCode;
    return statusCode === 401 || statusCode === 403;
  }

  /**
   * Execute a Vault operation with automatic token refresh.
   * If a 401/403 error occurs under an auth method that can mint a fresh client
   * token (Kubernetes or AWS IAM login), re-authenticate and retry once.
   * Static token auth has nothing to refresh, so its errors propagate as-is.
   */
  private async executeWithTokenRefresh<T>(
    operation: () => Promise<T>,
    operationName: string,
  ): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      const canReauthenticate =
        this.config.authMethod === "kubernetes" ||
        this.config.authMethod === "aws";
      if (!canReauthenticate || !this.isVaultAuthenticationError(error)) {
        throw error;
      }

      logger.info(
        { operationName, authMethod: this.config.authMethod },
        "VaultClient: authentication rejected, re-authenticating",
      );

      // Reset initialization state and re-authenticate
      this.initialized = false;
      try {
        await this.ensureInitialized();
      } catch (authError) {
        logger.error(
          { authError, operationName },
          "VaultClient: re-authentication failed",
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
      // Throw raw (like loginWithAws): ensureInitialized owns the single
      // ApiError wrap, so wrapping here would only bury the Vault detail.
      throw error;
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
}
