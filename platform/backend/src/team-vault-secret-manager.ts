import Vault from "node-vault";
import config from "@/config";
import logger from "@/logging";
import { ApiError } from "@/types/api";
import {
  getSecretsManagerType,
  getVaultConfigFromEnv,
  SecretsManagerConfigurationError,
  SecretsManagerType,
  type VaultConfig,
} from "./secretsmanager";

/**
 * Item returned when listing secrets in a Vault folder
 */
export interface VaultSecretListItem {
  /** Secret name/key within the folder */
  name: string;
  /** Full Vault path to the secret */
  path: string;
}

/**
 * Result of checking connectivity to a Vault folder
 */
export interface VaultFolderConnectivityResult {
  connected: boolean;
  secretCount: number;
  error?: string;
}

/**
 * TeamVaultSecretManager handles reading secrets from arbitrary Vault paths
 * for the BYOS (Bring Your Own Secrets) feature.
 *
 * Unlike the main VaultSecretManager which manages secrets at a fixed Archestra path,
 * this class reads from team-configured external Vault paths.
 */
export class TeamVaultSecretManager {
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
          "TeamVaultSecretManager: token is required for token authentication",
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
      logger.error({ error }, "TeamVaultSecretManager: initialization failed");
      throw new ApiError(500, extractVaultErrorMessage(error));
    }
  }

  /**
   * Authenticate with Vault using Kubernetes service account token
   */
  private async loginWithKubernetes(): Promise<void> {
    const fs = await import("node:fs/promises");
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
        "TeamVaultSecretManager: authenticated via Kubernetes auth",
      );
    } catch (error) {
      logger.error(
        { error, tokenPath, role: this.config.k8sRole },
        "TeamVaultSecretManager: Kubernetes authentication failed",
      );
      throw error;
    }
  }

  /**
   * Authenticate with Vault using AWS IAM credentials
   */
  private async loginWithAws(): Promise<void> {
    const { Sha256 } = await import("@aws-crypto/sha256-js");
    const { fromNodeProviderChain } = await import(
      "@aws-sdk/credential-providers"
    );
    const { SignatureV4 } = await import("@smithy/signature-v4");

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
        "TeamVaultSecretManager: authenticated via AWS IAM auth",
      );
    } catch (error) {
      logger.error(
        { error, role: this.config.awsRole, region, mountPoint },
        "TeamVaultSecretManager: AWS IAM authentication failed",
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
    return vaultResponse.data.data as Record<string, unknown> as Record<
      string,
      string
    >;
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
      "TeamVaultSecretManager.listSecretsInFolder: listing secrets",
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

      const items: VaultSecretListItem[] = secretKeys.map((name) => ({
        name,
        path: `${folderPath}/${name}`,
      }));

      logger.info(
        { folderPath, count: items.length },
        "TeamVaultSecretManager.listSecretsInFolder: completed",
      );
      return items;
    } catch (error) {
      // Vault returns 404 when the path doesn't exist (no secrets)
      const vaultError = error as { response?: { statusCode?: number } };
      if (vaultError.response?.statusCode === 404) {
        logger.debug(
          { folderPath },
          "TeamVaultSecretManager.listSecretsInFolder: folder empty or not found",
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
      "TeamVaultSecretManager.getSecretFromPath: fetching secret",
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
        "TeamVaultSecretManager.getSecretFromPath: secret retrieved",
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
      "TeamVaultSecretManager.checkFolderConnectivity: checking connectivity",
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
        "TeamVaultSecretManager.checkFolderConnectivity: connected",
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
          "TeamVaultSecretManager.checkFolderConnectivity: connected (empty folder)",
        );
        return {
          connected: true,
          secretCount: 0,
        };
      }

      const errorMessage = extractVaultErrorMessage(error);
      logger.warn(
        { folderPath, error: errorMessage },
        "TeamVaultSecretManager.checkFolderConnectivity: failed",
      );

      return {
        connected: false,
        secretCount: 0,
        error: errorMessage,
      };
    }
  }

  /**
   * Handle Vault operation errors
   */
  private handleVaultError(
    error: unknown,
    operationName: string,
    context: Record<string, unknown> = {},
  ): never {
    logger.error(
      { error, ...context },
      `TeamVaultSecretManager.${operationName}: failed`,
    );

    if (error instanceof ApiError) {
      throw error;
    }

    throw new ApiError(
      500,
      "An error occurred while accessing external Vault secrets. Please try again later or contact your administrator.",
    );
  }
}

/**
 * Extract error message from Vault response
 */
function extractVaultErrorMessage(error: unknown): string {
  const vaultErr = error as {
    response?: { statusCode?: number; body?: { errors?: string[] } };
  };
  const vaultErrors = vaultErr.response?.body?.errors;
  const statusCode = vaultErr.response?.statusCode;

  if (vaultErrors?.length) {
    return `${statusCode}: ${vaultErrors.join(", ")}`;
  }
  if (statusCode) {
    return `${statusCode}`;
  }
  return "Connection failed";
}

/**
 * Create a TeamVaultSecretManager instance if Vault is configured.
 * Returns null if Vault is not configured or enterprise license is not active.
 */
export function createTeamVaultSecretManager(): TeamVaultSecretManager | null {
  const managerType = getSecretsManagerType();

  if (managerType !== SecretsManagerType.Vault) {
    logger.debug(
      "createTeamVaultSecretManager: Vault not configured, returning null",
    );
    return null;
  }

  if (!config.enterpriseLicenseActivated) {
    logger.warn(
      "createTeamVaultSecretManager: Enterprise license not activated, returning null",
    );
    return null;
  }

  let vaultConfig: VaultConfig;
  try {
    vaultConfig = getVaultConfigFromEnv();
  } catch (error) {
    if (error instanceof SecretsManagerConfigurationError) {
      logger.warn(
        { reason: error.message },
        "createTeamVaultSecretManager: Invalid Vault configuration, returning null",
      );
      return null;
    }
    throw error;
  }

  logger.info(
    { address: vaultConfig.address, authMethod: vaultConfig.authMethod },
    "createTeamVaultSecretManager: created TeamVaultSecretManager",
  );

  return new TeamVaultSecretManager(vaultConfig);
}

/**
 * Singleton instance of TeamVaultSecretManager.
 * Will be null if Vault is not configured.
 */
export const teamVaultSecretManager: TeamVaultSecretManager | null =
  createTeamVaultSecretManager();
