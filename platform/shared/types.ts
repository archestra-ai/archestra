export type ErrorExtended = {
  message: string;
  request?: {
    method: string;
    url: string;
  };
  data?: object;
  stack?: string;
};

/**
 * Supported secrets manager types
 */
export enum SecretsManagerType {
  DB = "DB",
  Vault = "Vault",
  /** BYOS (Bring Your Own Secrets) - Vault with external team folder support */
  BYOS_VAULT = "BYOS_VAULT",
}
