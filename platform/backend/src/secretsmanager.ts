import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import Vault from "node-vault";
import config from "@/config";
import logger from "@/logging";
import SecretModel from "@/models/secret";
import type { SecretValue, SelectSecret } from "@/types";
import { ApiError } from "@/types/api";

/**
 * Result of checking connectivity to the secrets storage
 */
export interface SecretsConnectivityResult {
  /** The type of secrets manager being used */
  type: SecretsManagerType;
  /** Whether the connection was successful */
  connected: true;
  /** Number of secrets stored (only available for Vault) */
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

  /**
   * Check connectivity to the secrets storage and return secret count
   * @returns Connectivity result with secret count
   * @throws ApiError if connectivity check fails or is not supported
   */
  checkConnectivity(): Promise<SecretsConnectivityResult>;
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
}

/**
 * Create a secret manager based on environment configuration
 * Uses ARCHESTRA_SECRETS_MANAGER env var to determine the backend:
 * - "Vault": Uses VaultSecretManager (see getVaultConfigFromEnv for required env vars)
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

  async checkConnectivity(): Promise<SecretsConnectivityResult> {
    throw new ApiError(
      501,
      "Connectivity check not implemented for database storage",
    );
  }
}

export type VaultAuthMethod = "token" | "kubernetes" | "aws";

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
  /** Kubernetes auth mount point in Vault (defaults to "kubernetes") */
  k8sMountPoint?: string;
  /** AWS IAM auth role (required for aws auth) */
  awsRole?: string;
  /** AWS auth mount point in Vault (defaults to "aws") */
  awsMountPoint?: string;
  /** AWS region for STS signing (defaults to us-east-1) */
  awsRegion?: string;
  /** AWS STS endpoint URL (defaults to https://sts.amazonaws.com to match Vault's default) */
  awsStsEndpoint?: string;
  /** Value for X-Vault-AWS-IAM-Server-ID header (optional, for additional security) */
  awsIamServerIdHeader?: string;
  /** Path prefix for secrets in Vault KV v2 engine (defaults to "secret/data/archestra") */
  secretPath: string;
  /** Path prefix for secret metadata in Vault KV v2 engine (defaults to secretPath with /data/ replaced by /metadata/) */
  secretMetadataPath?: string;
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

    // Validate config but defer authentication for k8s/aws
    if (config.authMethod === "kubernetes") {
      if (!config.k8sRole) {
        throw new Error(
          "VaultSecretManager: k8sRole is required for Kubernetes authentication",
        );
      }
      // Authentication deferred to ensureInitialized()
    } else if (config.authMethod === "aws") {
      if (!config.awsRole) {
        throw new Error(
          "VaultSecretManager: awsRole is required for AWS IAM authentication",
        );
      }
      // Authentication deferred to ensureInitialized()
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
      const fs = await import("node:fs/promises");
      const jwt = await fs.readFile(tokenPath, "utf-8");

      const result = await this.client.kubernetesLogin({
        mount_point: this.config.k8sMountPoint as string,
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
   * Authenticate with Vault using AWS IAM credentials
   * Uses the default AWS credential provider chain (env vars, shared credentials, IAM role, etc.)
   */
  private async loginWithAws(): Promise<void> {
    const region = this.config.awsRegion ?? DEFAULT_AWS_REGION;
    const mountPoint = this.config.awsMountPoint ?? DEFAULT_AWS_MOUNT_POINT;
    // Use the STS endpoint from config, or construct based on region
    // Default to global endpoint (sts.amazonaws.com) which matches Vault's default sts_endpoint
    const stsEndpoint = this.config.awsStsEndpoint ?? DEFAULT_AWS_STS_ENDPOINT;

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
    const { SignatureV4 } = await import("@smithy/signature-v4");
    const { Sha256 } = await import("@aws-crypto/sha256-js");

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
   * Each call retries authentication if not yet initialized, allowing recovery if Vault becomes available.
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
      throw new ApiError(
        500,
        "Failed to connect to secrets vault. Please try again later or contact your administrator.",
      );
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
      { error, ...context },
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
    // Use configured metadata path, or fallback to replacing /data/ with /metadata/
    const metadataPath =
      this.config.secretMetadataPath ??
      this.config.secretPath.replace("/data/", "/metadata/");
    return `${metadataPath}/${name}-${id}`;
  }

  async createSecret(
    secretValue: SecretValue,
    name: string,
  ): Promise<SelectSecret> {
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
      await this.client.write(vaultPath, {
        data: { value: JSON.stringify(secretValue) },
      });
      logger.info(
        { vaultPath },
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
      const metadataPath = this.getVaultMetadataPath(dbRecord.name, secid);
      try {
        // Delete metadata to permanently remove all versions of the secret
        await this.client.delete(metadataPath);
        logger.info(
          { metadataPath },
          "VaultSecretManager.deleteSecret: secret permanently deleted",
        );
      } catch (error) {
        this.handleVaultError(error, "deleteSecret", { metadataPath });
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
      await this.client.write(vaultPath, {
        data: { value: JSON.stringify(secretValue) },
      });
      logger.info(
        { vaultPath },
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

    // List secrets at metadata path to get count
    const metadataBasePath =
      this.config.secretMetadataPath ??
      this.config.secretPath.replace("/data/", "/metadata/");

    try {
      const result = await this.client.list(metadataBasePath);
      const keys = (result?.data?.keys as string[] | undefined) ?? [];
      return {
        type: SecretsManagerType.Vault,
        connected: true,
        secretCount: keys.length,
      };
    } catch (error) {
      // Vault returns 404 when the path doesn't exist (no secrets created yet)
      // This is expected and means we're connected with 0 secrets
      const vaultError = error as { response?: { statusCode?: number } };
      if (vaultError.response?.statusCode === 404) {
        logger.info(
          { metadataBasePath },
          "VaultSecretManager.checkConnectivity: path not found, no secrets exist yet",
        );
        return {
          type: SecretsManagerType.Vault,
          connected: true,
          secretCount: 0,
        };
      }

      logger.error(
        { error, metadataBasePath },
        "VaultSecretManager.checkConnectivity: failed to list secrets",
      );
      throw new ApiError(500, "Failed to connect to Vault or list secrets");
    }
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

/** Default Vault Kubernetes auth mount point */
const DEFAULT_K8S_MOUNT_POINT = "kubernetes";

/** Default Vault AWS auth mount point */
const DEFAULT_AWS_MOUNT_POINT = "aws";

/** Default AWS region for STS requests */
const DEFAULT_AWS_REGION = "us-east-1";

/** Default AWS STS endpoint - uses global endpoint to match Vault's default sts_endpoint */
const DEFAULT_AWS_STS_ENDPOINT = "https://sts.amazonaws.com";

/** Default path prefix for secrets in Vault KV v2 engine */
const DEFAULT_SECRET_PATH = "secret/data/archestra";

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
 * - ARCHESTRA_HASHICORP_VAULT_SECRET_PATH: Path prefix for secrets in Vault KV v2 (optional, defaults to "secret/data/archestra")
 *
 * @returns VaultConfig if ARCHESTRA_HASHICORP_VAULT_ADDR is set and configuration is valid, null if VAULT_ADDR is not set
 * @throws SecretsManagerConfigurationError if VAULT_ADDR is set but configuration is incomplete or invalid
 */
export function getVaultConfigFromEnv(): VaultConfig {
  const errors: string[] = [];

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
      token: token as string,
      secretPath:
        process.env.ARCHESTRA_HASHICORP_VAULT_SECRET_PATH ??
        DEFAULT_SECRET_PATH,
      secretMetadataPath:
        process.env.ARCHESTRA_HASHICORP_VAULT_SECRET_METADATA_PATH,
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
      k8sRole: k8sRole as string,
      k8sTokenPath:
        process.env.ARCHESTRA_HASHICORP_VAULT_K8S_TOKEN_PATH ??
        DEFAULT_K8S_TOKEN_PATH,
      k8sMountPoint:
        process.env.ARCHESTRA_HASHICORP_VAULT_K8S_MOUNT_POINT ??
        DEFAULT_K8S_MOUNT_POINT,
      secretPath:
        process.env.ARCHESTRA_HASHICORP_VAULT_SECRET_PATH ??
        DEFAULT_SECRET_PATH,
      secretMetadataPath:
        process.env.ARCHESTRA_HASHICORP_VAULT_SECRET_METADATA_PATH,
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
      awsRole: awsRole as string,
      awsMountPoint:
        process.env.ARCHESTRA_HASHICORP_VAULT_AWS_MOUNT_POINT ??
        DEFAULT_AWS_MOUNT_POINT,
      awsRegion:
        process.env.ARCHESTRA_HASHICORP_VAULT_AWS_REGION ?? DEFAULT_AWS_REGION,
      awsStsEndpoint:
        process.env.ARCHESTRA_HASHICORP_VAULT_AWS_STS_ENDPOINT ??
        DEFAULT_AWS_STS_ENDPOINT,
      awsIamServerIdHeader:
        process.env.ARCHESTRA_HASHICORP_VAULT_AWS_IAM_SERVER_ID,
      secretPath:
        process.env.ARCHESTRA_HASHICORP_VAULT_SECRET_PATH ??
        DEFAULT_SECRET_PATH,
      secretMetadataPath:
        process.env.ARCHESTRA_HASHICORP_VAULT_SECRET_METADATA_PATH,
    };
  }

  throw new SecretsManagerConfigurationError(
    `Invalid ARCHESTRA_HASHICORP_VAULT_AUTH_METHOD="${authMethod}". Expected "TOKEN", "K8S", or "AWS".`,
  );
}

/**
 * Default secret manager instance
 */
export const secretManager: SecretManager = createSecretManager();
