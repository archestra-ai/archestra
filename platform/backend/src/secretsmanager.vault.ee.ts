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
} from "./secretmanager.types";
import { extractVaultErrorMessage } from "./secretmanager.utils";
import { ApiError, type SecretValue, type SelectSecret } from "./types";

/**
 * Vault-backed implementation of SecretManager
 * Stores secret metadata in PostgreSQL with isVault=true, actual secrets in HashiCorp Vault
 */
export default class VaultSecretManager implements ISecretManager {
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
