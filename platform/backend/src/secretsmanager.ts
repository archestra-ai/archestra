import fs from "node:fs/promises";
import { Sha256 } from "@aws-crypto/sha256-js";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import { SignatureV4 } from "@smithy/signature-v4";
import Vault from "node-vault";
import config from "@/config";
import logger from "@/logging";
import SecretModel from "@/models/secret";
import type { SecretValue, SelectSecret } from "@/types";
import { ApiError } from "@/types/api";
import { parseVaultSecretReference } from "@/types/secret";

/**
 * Result of checking connectivity to the secrets storage
 */
export interface SecretsConnectivityResult {
  /** Number of secrets stored */
  secretCount: number;
}

/**
 * SecretManager interface for managing secrets
 * Can be implemented for different secret storage backends (database, AWS Secrets Manager, etc.)
 */
export interface SecretManager {
  /**
   * The type of secrets manager
   */
  readonly type: SecretsManagerType;
  /**
   * Create a new secret
   * @param secretValue - The secret value as JSON
   * @param name - Human-readable name to identify the secret in external storage
   * @param forceDB - When true, store in database even if using external secret manager (e.g., for OAuth tokens)
   * @returns The created secret with generated ID
   */
  createSecret(
    secretValue: SecretValue,
    name: string,
    forceDB?: boolean,
  ): Promise<SelectSecret>;

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

  /**
   * Check connectivity to the secrets storage and return secret count
   * @returns Connectivity result with secret count
   * @throws ApiError if connectivity check fails or is not supported
   */
  checkConnectivity(): Promise<SecretsConnectivityResult>;

  /**
   * Get user-visible debug info about the secrets manager configuration
   * @returns Debug info object with type and meta dictionary for display
   */
  getUserVisibleDebugInfo(): {
    type: SecretsManagerType;
    meta: Record<string, string>;
  };
}

export class SecretsManagerConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretsManagerConfigurationError";
  }
}

/**
 * Supported secrets manager types
 */
export enum SecretsManagerType {
  DB = "DB",
  Vault = "Vault",
  /** BYOS (Bring Your Own Secrets) - Vault with external team folder support */
  BYOS_VAULT = "BYOS_VAULT",
}

/**
 * Create a secret manager based on environment configuration
 * Uses ARCHESTRA_SECRETS_MANAGER env var to determine the backend:
 * - "Vault": Uses VaultSecretManager (see getVaultConfigFromEnv for required env vars)
 * - "BYOS_VAULT": Uses BYOSVaultSecretManager for external team vault folder support
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
    return new BYOSVaultSecretManager(vaultConfig);
  }

  logger.info("createSecretManager: using DbSecretsManager");
  return new DbSecretsManager();
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

  if (envValue === "READONLY_VAULT") {
    return SecretsManagerType.BYOS_VAULT;
  }

  return SecretsManagerType.DB;
}

/**
 * Database-backed implementation of SecretManager
 * Stores secrets in the database using SecretModel
 */
export class DbSecretsManager implements SecretManager {
  readonly type = SecretsManagerType.DB;

  async createSecret(
    secretValue: SecretValue,
    name: string,
    _forceDB?: boolean,
  ): Promise<SelectSecret> {
    // forceDB is ignored for DbSecretsManager since it always uses DB
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

  async checkConnectivity(): Promise<SecretsConnectivityResult> {
    throw new ApiError(
      501,
      "Connectivity check not implemented for database storage",
    );
  }

  getUserVisibleDebugInfo() {
    return {
      type: this.type,
      meta: {},
    };
  }
}

export type VaultAuthMethod = "token" | "kubernetes" | "aws";

export type VaultKvVersion = "1" | "2";

export interface VaultConfig {
  /** Vault server address (default: http://localhost:8200) */
  address: string;
  /** Path prefix for secrets in Vault KV engine (defaults based on kvVersion: "secret/data/archestra" for v2, "secret/archestra" for v1) */
  secretPath: string;
  /** Path prefix for secret metadata in Vault KV v2 engine (only used for v2, defaults to secretPath with /data/ replaced by /metadata/) */
  secretMetadataPath?: string;
  /** Authentication method to use */
  authMethod: VaultAuthMethod;
  /** KV secrets engine version (default: "2") */
  kvVersion: VaultKvVersion;
  /** Vault token for authentication (required for token auth) */
  token?: string;
  /** Kubernetes auth role (required for kubernetes auth) */
  k8sRole?: string;
  /** Path to service account token file (default: /var/run/secrets/kubernetes.io/serviceaccount/token) */
  k8sTokenPath: string;
  /** Kubernetes auth mount point in Vault (default: "kubernetes") */
  k8sMountPoint: string;
  /** AWS IAM auth role (required for aws auth) */
  awsRole?: string;
  /** AWS auth mount point in Vault (default: "aws") */
  awsMountPoint: string;
  /** AWS region for STS signing (default: "us-east-1") */
  awsRegion: string;
  /** AWS STS endpoint URL (default: "https://sts.amazonaws.com" to match Vault's default) */
  awsStsEndpoint: string;
  /** Value for X-Vault-AWS-IAM-Server-ID header (optional, for additional security) */
  awsIamServerIdHeader?: string;
}

/**
 * Vault-backed implementation of SecretManager
 * Stores secret metadata in PostgreSQL with isVault=true, actual secrets in HashiCorp Vault
 */
export class VaultSecretManager implements SecretManager {
  readonly type = SecretsManagerType.Vault;
  private client: ReturnType<typeof Vault>;
  private initialized = false;
  private config: VaultConfig;

  constructor(config: VaultConfig) {
    this.config = config;
    // Normalize endpoint: remove trailing slash to avoid double-slash URLs
    const normalizedEndpoint = config.address.replace(/\/+$/, "");
    logger.info({ config }, "VaultSecretManager: got client config");
    this.client = Vault({
      endpoint: normalizedEndpoint,
    });

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
    } else if (config.authMethod === "token") {
      if (!config.token) {
        throw new Error(
          "VaultSecretManager: token is required for token authentication",
        );
      }
      this.client.token = config.token;
      this.initialized = true;
    } else {
      throw new Error("VaultSecretManager: invalid authentication method");
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
   * Authenticate with Vault using AWS IAM credentials
   * Uses the default AWS credential provider chain (env vars, shared credentials, IAM role, etc.)
   */
  private async loginWithAws(): Promise<void> {
    const region = this.config.awsRegion;
    const mountPoint = this.config.awsMountPoint;
    const stsEndpoint = this.config.awsStsEndpoint;

    try {
      // Get credentials from the default provider chain
      const credentialProvider = fromNodeProviderChain();
      const credentials = await credentialProvider();

      // Build the signed request for Vault
      // Vault expects the IAM request to be signed and sent as base64-encoded data
      const stsUrl = stsEndpoint.endsWith("/")
        ? stsEndpoint
        : `${stsEndpoint}/`;

      // Create the request body for GetCallerIdentity
      const requestBody = "Action=GetCallerIdentity&Version=2011-06-15";

      // Sign the request using AWS Signature V4
      const signedRequest = await this.signAwsRequest({
        method: "POST",
        url: stsUrl,
        body: requestBody,
        region,
        credentials,
        serverIdHeader: this.config.awsIamServerIdHeader,
      });

      // Prepare the login payload for Vault
      const loginPayload = {
        role: this.config.awsRole,
        iam_http_request_method: "POST",
        iam_request_url: Buffer.from(stsUrl).toString("base64"),
        iam_request_body: Buffer.from(requestBody).toString("base64"),
        iam_request_headers: Buffer.from(
          JSON.stringify(signedRequest.headers),
        ).toString("base64"),
      };

      // Authenticate with Vault
      const result = await this.client.write(
        `auth/${mountPoint}/login`,
        loginPayload,
      );

      this.client.token = result.auth.client_token;
      logger.info(
        { role: this.config.awsRole, region, mountPoint },
        "VaultSecretManager: authenticated via AWS IAM auth",
      );
    } catch (error) {
      logger.error(
        { error, role: this.config.awsRole, region, mountPoint },
        "VaultSecretManager: AWS IAM authentication failed",
      );
      throw error;
    }
  }

  /**
   * Sign an AWS request using Signature V4
   */
  private async signAwsRequest(options: {
    method: string;
    url: string;
    body: string;
    region: string;
    credentials: {
      accessKeyId: string;
      secretAccessKey: string;
      sessionToken?: string;
    };
    serverIdHeader?: string;
  }): Promise<{ headers: Record<string, string> }> {
    const url = new URL(options.url);
    const headers: Record<string, string> = {
      host: url.host,
      "content-type": "application/x-www-form-urlencoded; charset=utf-8",
    };

    // Add server ID header if configured (for additional security)
    if (options.serverIdHeader) {
      headers["x-vault-aws-iam-server-id"] = options.serverIdHeader;
    }

    const signer = new SignatureV4({
      service: "sts",
      region: options.region,
      credentials: options.credentials,
      sha256: Sha256,
    });

    const signedRequest = await signer.sign({
      method: options.method,
      protocol: url.protocol,
      hostname: url.hostname,
      path: url.pathname,
      headers,
      body: options.body,
    });

    return { headers: signedRequest.headers as Record<string, string> };
  }

  /**
   * Ensure authentication is complete before any operation.
   * For k8s/aws auth, this triggers the login on first call (lazy initialization).
   * Each call retries authentication if not yet initialized.
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
      logger.error({ error }, "VaultSecretManager: initialization failed");
      throw new ApiError(500, extractVaultErrorMessage(error));
    }
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
      { error, vaultError: extractVaultErrorMessage(error), ...context },
      `VaultSecretManager.${operationName}: failed`,
    );

    // Re-throw ApiError as-is (e.g., from ensureInitialized)
    if (error instanceof ApiError) {
      throw error;
    }

    throw new ApiError(
      500,
      "An error occurred while accessing secrets. Please try again later or contact your administrator.",
    );
  }

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
   * Build the write payload based on KV version
   * v2 requires { data: { value: ... } }, v1 requires { value: ... }
   */
  private buildWritePayload(value: string): Record<string, unknown> {
    if (this.config.kvVersion === "1") {
      return { value };
    }
    return { data: { value } };
  }

  /**
   * Extract the secret value from Vault read response based on KV version
   * v2 response: vaultResponse.data.data.value
   * v1 response: vaultResponse.data.value
   */
  private extractSecretValue(vaultResponse: {
    data: Record<string, unknown>;
  }): string {
    if (this.config.kvVersion === "1") {
      return vaultResponse.data.value as string;
    }
    return (vaultResponse.data.data as Record<string, unknown>).value as string;
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

    try {
      await this.ensureInitialized();
    } catch (error) {
      this.handleVaultError(error, "createSecret", { name });
    }

    // Sanitize name to conform to Vault naming rules
    const sanitizedName = sanitizeVaultSecretName(name);

    const dbRecord = await SecretModel.create({
      name: sanitizedName,
      secret: {},
      isVault: true,
    });

    const vaultPath = this.getVaultPath(dbRecord.name, dbRecord.id);
    try {
      await this.client.write(
        vaultPath,
        this.buildWritePayload(JSON.stringify(secretValue)),
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
    try {
      await this.ensureInitialized();
    } catch (error) {
      this.handleVaultError(error, "deleteSecret", { secid });
    }

    const dbRecord = await SecretModel.findById(secid);
    if (!dbRecord) {
      return false;
    }

    if (dbRecord.isVault) {
      const deletePath = this.getVaultMetadataPath(dbRecord.name, secid);
      try {
        // For v2: Delete metadata to permanently remove all versions of the secret
        // For v1: Delete the secret directly (no versioning)
        await this.client.delete(deletePath);
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
    try {
      await this.ensureInitialized();
    } catch (error) {
      this.handleVaultError(error, "getSecret", { secid });
    }

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
        this.extractSecretValue(vaultResponse),
      ) as SecretValue;
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
    try {
      await this.ensureInitialized();
    } catch (error) {
      this.handleVaultError(error, "updateSecret", { secid });
    }

    const dbRecord = await SecretModel.findById(secid);
    if (!dbRecord) {
      return null;
    }

    if (!dbRecord.isVault) {
      return await SecretModel.update(secid, { secret: secretValue });
    }

    const vaultPath = this.getVaultPath(dbRecord.name, secid);
    try {
      await this.client.write(
        vaultPath,
        this.buildWritePayload(JSON.stringify(secretValue)),
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
    await this.ensureInitialized();

    const listBasePath = this.getListBasePath();

    try {
      const result = await this.client.list(listBasePath);
      const keys = (result?.data?.keys as string[] | undefined) ?? [];
      return { secretCount: keys.length };
    } catch (error) {
      // Vault returns 404 when the path doesn't exist (no secrets created yet)
      // This is expected and means we're connected with 0 secrets
      const vaultError = error as { response?: { statusCode?: number } };
      if (vaultError.response?.statusCode === 404) {
        logger.info(
          { listBasePath, kvVersion: this.config.kvVersion },
          "VaultSecretManager.checkConnectivity: path not found, no secrets exist yet",
        );
        return { secretCount: 0 };
      }

      logger.error(
        { error, listBasePath, kvVersion: this.config.kvVersion },
        "VaultSecretManager.checkConnectivity: failed to list secrets",
      );
      throw new ApiError(500, extractVaultErrorMessage(error));
    }
  }

  getUserVisibleDebugInfo() {
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
}

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
 * BYOSVaultSecretManager - Manages secrets stored in external (customer-owned) Vault folders.
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
export class BYOSVaultSecretManager implements SecretManager {
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

/**
 * Extract error message from Vault response
 * Returns only the Vault response details (status code and errors array)
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

/** Default Vault Kubernetes auth mount point */
const DEFAULT_K8S_MOUNT_POINT = "kubernetes";

/** Default Vault AWS auth mount point */
const DEFAULT_AWS_MOUNT_POINT = "aws";

/** Default AWS region for STS requests */
const DEFAULT_AWS_REGION = "us-east-1";

/** Default AWS STS endpoint - uses global endpoint to match Vault's default sts_endpoint */
const DEFAULT_AWS_STS_ENDPOINT = "https://sts.amazonaws.com";

/** Default path prefix for secrets in Vault KV v2 engine */
const DEFAULT_SECRET_PATH_V2 = "secret/data/archestra";

/** Default path prefix for secrets in Vault KV v1 engine */
const DEFAULT_SECRET_PATH_V1 = "secret/archestra";

/** Default KV version */
const DEFAULT_KV_VERSION: VaultKvVersion = "2";

/**
 * Get Vault configuration from environment variables
 *
 * Required:
 * - ARCHESTRA_HASHICORP_VAULT_ADDR: Vault server address
 *
 * Optional:
 * - ARCHESTRA_HASHICORP_VAULT_AUTH_METHOD: "TOKEN" (default), "K8S", or "AWS"
 *
 * For token auth (ARCHESTRA_HASHICORP_VAULT_AUTH_METHOD=TOKEN or not set):
 * - ARCHESTRA_HASHICORP_VAULT_TOKEN: Vault token (required)
 *
 * For Kubernetes auth (ARCHESTRA_HASHICORP_VAULT_AUTH_METHOD=K8S):
 * - ARCHESTRA_HASHICORP_VAULT_K8S_ROLE: Vault role bound to K8s service account (required)
 * - ARCHESTRA_HASHICORP_VAULT_K8S_TOKEN_PATH: Path to SA token (optional, defaults to /var/run/secrets/kubernetes.io/serviceaccount/token)
 * - ARCHESTRA_HASHICORP_VAULT_K8S_MOUNT_POINT: Vault K8s auth mount point (optional, defaults to "kubernetes")
 *
 * For AWS IAM auth (ARCHESTRA_HASHICORP_VAULT_AUTH_METHOD=AWS):
 * - ARCHESTRA_HASHICORP_VAULT_AWS_ROLE: Vault role bound to AWS IAM principal (required)
 * - ARCHESTRA_HASHICORP_VAULT_AWS_MOUNT_POINT: Vault AWS auth mount point (optional, defaults to "aws")
 * - ARCHESTRA_HASHICORP_VAULT_AWS_REGION: AWS region for STS signing (optional, defaults to "us-east-1")
 * - ARCHESTRA_HASHICORP_VAULT_AWS_STS_ENDPOINT: STS endpoint URL (optional, defaults to "https://sts.amazonaws.com" to match Vault's default)
 * - ARCHESTRA_HASHICORP_VAULT_AWS_IAM_SERVER_ID: Value for X-Vault-AWS-IAM-Server-ID header (optional, for additional security)
 *
 * Common (all auth methods):
 * - ARCHESTRA_HASHICORP_VAULT_KV_VERSION: KV secrets engine version, "1" or "2" (optional, defaults to "2")
 * - ARCHESTRA_HASHICORP_VAULT_SECRET_PATH: Path prefix for secrets in Vault KV (optional, defaults based on KV version)
 *
 * @returns VaultConfig if ARCHESTRA_HASHICORP_VAULT_ADDR is set and configuration is valid, null if VAULT_ADDR is not set
 * @throws SecretsManagerConfigurationError if VAULT_ADDR is set but configuration is incomplete or invalid
 */
export function getVaultConfigFromEnv(): VaultConfig {
  const errors: string[] = [];

  // Parse KV version first (needed for default secret path)
  const kvVersionEnv = process.env.ARCHESTRA_HASHICORP_VAULT_KV_VERSION;
  let kvVersion: VaultKvVersion = DEFAULT_KV_VERSION;

  if (kvVersionEnv) {
    if (kvVersionEnv === "1" || kvVersionEnv === "2") {
      kvVersion = kvVersionEnv;
    } else {
      errors.push(
        `Invalid ARCHESTRA_HASHICORP_VAULT_KV_VERSION="${kvVersionEnv}". Expected "1" or "2".`,
      );
    }
  }

  // Get default secret path based on KV version
  const defaultSecretPath =
    kvVersion === "1" ? DEFAULT_SECRET_PATH_V1 : DEFAULT_SECRET_PATH_V2;

  const authMethod =
    process.env.ARCHESTRA_HASHICORP_VAULT_AUTH_METHOD?.toUpperCase() ?? "TOKEN";

  if (authMethod === "TOKEN") {
    const address = process.env.ARCHESTRA_HASHICORP_VAULT_ADDR;
    if (!address) {
      errors.push("ARCHESTRA_HASHICORP_VAULT_ADDR is not set.");
    }
    const token = process.env.ARCHESTRA_HASHICORP_VAULT_TOKEN;
    if (!token) {
      errors.push("ARCHESTRA_HASHICORP_VAULT_TOKEN is not set.");
    }
    if (errors.length > 0) {
      throw new SecretsManagerConfigurationError(errors.join(" "));
    }
    return {
      address: address as string,
      authMethod: "token",
      kvVersion,
      token: token as string,
      secretPath:
        process.env.ARCHESTRA_HASHICORP_VAULT_SECRET_PATH || defaultSecretPath,
      secretMetadataPath:
        process.env.ARCHESTRA_HASHICORP_VAULT_SECRET_METADATA_PATH || undefined,
      k8sTokenPath:
        process.env.ARCHESTRA_HASHICORP_VAULT_K8S_TOKEN_PATH ||
        DEFAULT_K8S_TOKEN_PATH,
      k8sMountPoint:
        process.env.ARCHESTRA_HASHICORP_VAULT_K8S_MOUNT_POINT ||
        DEFAULT_K8S_MOUNT_POINT,
      awsMountPoint:
        process.env.ARCHESTRA_HASHICORP_VAULT_AWS_MOUNT_POINT ||
        DEFAULT_AWS_MOUNT_POINT,
      awsRegion:
        process.env.ARCHESTRA_HASHICORP_VAULT_AWS_REGION || DEFAULT_AWS_REGION,
      awsStsEndpoint:
        process.env.ARCHESTRA_HASHICORP_VAULT_AWS_STS_ENDPOINT ||
        DEFAULT_AWS_STS_ENDPOINT,
    };
  }

  if (authMethod === "K8S") {
    const address = process.env.ARCHESTRA_HASHICORP_VAULT_ADDR;
    if (!address) {
      errors.push("ARCHESTRA_HASHICORP_VAULT_ADDR is not set.");
    }
    const k8sRole = process.env.ARCHESTRA_HASHICORP_VAULT_K8S_ROLE;
    if (!k8sRole) {
      errors.push("ARCHESTRA_HASHICORP_VAULT_K8S_ROLE is not set.");
    }
    if (errors.length > 0) {
      throw new SecretsManagerConfigurationError(errors.join(" "));
    }
    return {
      address: address as string,
      authMethod: "kubernetes",
      kvVersion,
      k8sRole: k8sRole as string,
      k8sTokenPath:
        process.env.ARCHESTRA_HASHICORP_VAULT_K8S_TOKEN_PATH ||
        DEFAULT_K8S_TOKEN_PATH,
      k8sMountPoint:
        process.env.ARCHESTRA_HASHICORP_VAULT_K8S_MOUNT_POINT ||
        DEFAULT_K8S_MOUNT_POINT,
      awsMountPoint:
        process.env.ARCHESTRA_HASHICORP_VAULT_AWS_MOUNT_POINT ||
        DEFAULT_AWS_MOUNT_POINT,
      awsRegion:
        process.env.ARCHESTRA_HASHICORP_VAULT_AWS_REGION || DEFAULT_AWS_REGION,
      awsStsEndpoint:
        process.env.ARCHESTRA_HASHICORP_VAULT_AWS_STS_ENDPOINT ||
        DEFAULT_AWS_STS_ENDPOINT,
      secretPath:
        process.env.ARCHESTRA_HASHICORP_VAULT_SECRET_PATH || defaultSecretPath,
      secretMetadataPath:
        process.env.ARCHESTRA_HASHICORP_VAULT_SECRET_METADATA_PATH || undefined,
    };
  }

  if (authMethod === "AWS") {
    const address = process.env.ARCHESTRA_HASHICORP_VAULT_ADDR;
    if (!address) {
      errors.push("ARCHESTRA_HASHICORP_VAULT_ADDR is not set.");
    }
    const awsRole = process.env.ARCHESTRA_HASHICORP_VAULT_AWS_ROLE;
    if (!awsRole) {
      errors.push("ARCHESTRA_HASHICORP_VAULT_AWS_ROLE is not set.");
    }
    if (errors.length > 0) {
      throw new SecretsManagerConfigurationError(errors.join(" "));
    }
    return {
      address: address as string,
      authMethod: "aws",
      kvVersion,
      awsRole: awsRole as string,
      k8sTokenPath:
        process.env.ARCHESTRA_HASHICORP_VAULT_K8S_TOKEN_PATH ||
        DEFAULT_K8S_TOKEN_PATH,
      k8sMountPoint:
        process.env.ARCHESTRA_HASHICORP_VAULT_K8S_MOUNT_POINT ||
        DEFAULT_K8S_MOUNT_POINT,
      awsMountPoint:
        process.env.ARCHESTRA_HASHICORP_VAULT_AWS_MOUNT_POINT ||
        DEFAULT_AWS_MOUNT_POINT,
      awsRegion:
        process.env.ARCHESTRA_HASHICORP_VAULT_AWS_REGION || DEFAULT_AWS_REGION,
      awsStsEndpoint:
        process.env.ARCHESTRA_HASHICORP_VAULT_AWS_STS_ENDPOINT ||
        DEFAULT_AWS_STS_ENDPOINT,
      awsIamServerIdHeader:
        process.env.ARCHESTRA_HASHICORP_VAULT_AWS_IAM_SERVER_ID || undefined,
      secretPath:
        process.env.ARCHESTRA_HASHICORP_VAULT_SECRET_PATH || defaultSecretPath,
      secretMetadataPath:
        process.env.ARCHESTRA_HASHICORP_VAULT_SECRET_METADATA_PATH || undefined,
    };
  }

  throw new SecretsManagerConfigurationError(
    `Invalid ARCHESTRA_HASHICORP_VAULT_AUTH_METHOD="${authMethod}". Expected "TOKEN", "K8S", or "AWS".`,
  );
}

/**
 * Check if BYOS (Bring Your Own Secrets) feature is enabled
 * BYOS allows teams to use external Vault folders for secrets
 * @returns true if ARCHESTRA_SECRETS_MANAGER=BYOS_VAULT and enterprise license is active
 */
export function isByosEnabled(): boolean {
  return (
    getSecretsManagerType() === SecretsManagerType.BYOS_VAULT &&
    config.enterpriseLicenseActivated
  );
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
  return DEFAULT_KV_VERSION;
}

/**
 * Default secret manager instance (uses configured backend)
 */
export const secretManager: SecretManager = createSecretManager();
