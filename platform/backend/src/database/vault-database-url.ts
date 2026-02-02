import config from "@/config";
import logger from "@/logging";

/**
 * Environment variable for specifying database URL in Vault.
 * Format: path:key (e.g., "secret/data/archestra/config:database_url")
 */
export const DATABASE_URL_VAULT_REF_ENV = "ARCHESTRA_DATABASE_URL_VAULT_REF";

/**
 * Check if READONLY_VAULT secrets manager is enabled.
 * This checks the env vars directly to avoid circular dependencies with @/secrets-manager.
 */
export function isReadonlyVaultEnabled(): boolean {
  const secretsManager =
    process.env.ARCHESTRA_SECRETS_MANAGER?.toUpperCase() === "READONLY_VAULT";
  return secretsManager && config.enterpriseLicenseActivated;
}

/**
 * Parse the vault reference string in "path:key" format.
 * @returns Object with path and key, or null if ref is invalid
 */
export function parseDatabaseUrlVaultRef(
  ref: string,
): { path: string; key: string } | null {
  const colonIndex = ref.lastIndexOf(":");
  if (colonIndex === -1) {
    logger.error(
      { ref },
      `Invalid ${DATABASE_URL_VAULT_REF_ENV} format. Expected: path:key`,
    );
    return null;
  }

  const path = ref.slice(0, colonIndex);
  const key = ref.slice(colonIndex + 1);

  if (!path || !key) {
    logger.error(
      { ref },
      `Invalid ${DATABASE_URL_VAULT_REF_ENV} format. Path and key cannot be empty.`,
    );
    return null;
  }

  return { path, key };
}

/**
 * Read the database URL from Vault.
 *
 * @param vaultRef - The vault reference in "path:key" format
 * @returns The database URL from Vault, or null if parsing fails
 * @throws Error if the key is not found in Vault
 */
export async function getDatabaseUrlFromVault(
  vaultRef: string,
): Promise<string | null> {
  const parsed = parseDatabaseUrlVaultRef(vaultRef);
  if (!parsed) {
    return null;
  }

  const { path, key } = parsed;

  // Dynamically import to avoid circular dependency
  const { assertByosEnabled } = await import("@/secrets-manager");

  // Use the global READONLY_VAULT secret manager
  const vaultManager = assertByosEnabled();

  // Fetch the secret from Vault
  const secretData = await vaultManager.getSecretFromPath(path);
  const databaseUrl = secretData[key];

  if (!databaseUrl) {
    throw new Error(
      `Key "${key}" not found in Vault path "${path}". Available keys: ${Object.keys(secretData).join(", ")}`,
    );
  }

  logger.info({ path }, "Database URL loaded from Vault");
  return databaseUrl;
}
