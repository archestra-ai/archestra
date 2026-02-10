import type { VaultConfig, VaultKvVersion } from "@/types";

export class SecretsManagerConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretsManagerConfigurationError";
  }
}

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
