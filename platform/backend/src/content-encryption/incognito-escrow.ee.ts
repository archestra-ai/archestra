// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { SecretsManagerType } from "@archestra/shared";
import logger from "@/logging";
import { secretManager } from "@/secrets-manager";
import type VaultSecretManager from "@/secrets-manager/vault.ee";
import { ApiError, type IncognitoEscrowWrappedDek } from "@/types";

/**
 * Enterprise Vault sink for incognito key escrow. The wrapped DEK is written
 * to the configured HashiCorp Vault backend at `incognito-escrow/<id>` (under
 * the configured secret path prefix) and the conversation row stores only a
 * reference marker.
 *
 * The platform only ever WRITES that path — a create-only Vault policy makes
 * it write-only from the app's perspective, which is also why a deleted or
 * rotated blob cannot be detected from the row.
 *
 * The default `db` sink and the RSA wrapping itself are not Enterprise; see
 * content-encryption/incognito-escrow.ts.
 */

/** Relative Vault folder (under the configured secret path) for escrow blobs. */
const VAULT_ESCROW_FOLDER = "incognito-escrow";

/**
 * Write the wrapped blob to Vault at `incognito-escrow/<conversationId>`
 * (relative to the configured secret path). Returns the full Vault path for
 * the reference marker. Any failure — including a non-Vault secrets backend,
 * which the boot guard should have prevented — throws a 500 BEFORE the
 * conversation row is inserted.
 */
export async function writeEscrowBlobToVault(params: {
  conversationId: string;
  blob: IncognitoEscrowWrappedDek;
}): Promise<string> {
  const manager = secretManager();
  if (manager.type !== SecretsManagerType.Vault) {
    // Boot guard enforces ARCHESTRA_SECRETS_MANAGER=Vault, but an invalid
    // Vault configuration silently falls back to the DB manager — fail the
    // creation rather than storing the blob somewhere readable.
    throw new ApiError(
      500,
      "Incognito escrow is configured with the Vault sink but the Vault " +
        "secrets backend is not active; the conversation was not created.",
    );
  }
  const vaultManager = manager as VaultSecretManager;
  try {
    return await vaultManager.writeValueAtRelativePath({
      relativePath: `${VAULT_ESCROW_FOLDER}/${params.conversationId}`,
      value: JSON.stringify(params.blob),
    });
  } catch (error) {
    logger.error(
      { error, conversationId: params.conversationId },
      "Incognito escrow Vault write failed; failing conversation creation (fail closed)",
    );
    throw new ApiError(
      500,
      "Failed to write the incognito escrow key to Vault; the conversation " +
        "was not created.",
    );
  }
}
