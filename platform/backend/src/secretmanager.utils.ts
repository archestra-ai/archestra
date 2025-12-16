/**
 * Extract error message from Vault response
 * Returns only the Vault response details (status code and errors array)
 */
export function extractVaultErrorMessage(error: unknown): string {
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
