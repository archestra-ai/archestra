import type { SecretsManagerType } from "../../shared";
import type { SecretValue, SelectSecret } from "./types";

/**
 * SecretManager interface for managing secrets
 * Can be implemented for different secret storage backends (database, AWS Secrets Manager, etc.)
 */
export interface ISecretManager {
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

/**
 * Result of checking connectivity to the secrets storage
 */
export interface SecretsConnectivityResult {
  /** Number of secrets stored */
  secretCount: number;
}

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

export type VaultAuthMethod = "token" | "kubernetes" | "aws";

export type VaultKvVersion = "1" | "2";
