import config from "@/config";
import logger from "@/logging";
import EncryptionKeyCanaryModel from "@/models/encryption-key-canary";
import SecretModel from "@/models/secret";
import {
  decryptSecretValue,
  encryptSecretValue,
  isEncryptedSecret,
} from "@/utils/crypto";
import { reencryptStoredSecrets } from "./reencrypt";

/**
 * Startup guard: prove that the key derived from the current
 * ARCHESTRA_AUTH_SECRET is the same key that stored secrets were encrypted
 * with, and abort startup when it is not.
 *
 * A canary blob encrypted with the key is persisted on first run; every later
 * boot decrypts it (AES-GCM authentication makes a successful decrypt proof
 * of the same key). On the very first run — a fresh deployment, or an
 * existing deployment upgrading to the first version with this guard — there
 * is no canary yet, so the current key is validated against the secrets that
 * already exist before being trusted: a deployment that is already mismatched
 * fails the check instead of blessing the wrong key.
 *
 * Operators who rotated ARCHESTRA_AUTH_SECRET deliberately can set
 * ARCHESTRA_SECRETS_ACCEPT_NEW_ENCRYPTION_KEY=true for one boot to accept the
 * new key; secrets encrypted with the old key stay unreadable and must be
 * re-entered.
 */
export async function verifySecretsEncryptionKey(): Promise<void> {
  const canary = await EncryptionKeyCanaryModel.get();

  if (canary) {
    if (canDecrypt(canary.encryptedCanary)) return;

    // The current encryption key can't decrypt the canary — the encryption
    // secret changed. If a previous secret is configured and still decrypts the
    // stored secrets, this is a deliberate rotation (e.g. an upgrade that split
    // ARCHESTRA_SECRETS_ENCRYPTION_SECRET out of ARCHESTRA_AUTH_SECRET): migrate
    // every secret to the new key here, at startup, where both keys are present.
    if (await reencryptForRotation()) {
      await EncryptionKeyCanaryModel.replace(canary.id, newCanaryBlob());
      return;
    }

    const unreadableCount = await countUndecryptableSecrets();
    if (config.secretsManager.acceptNewEncryptionKey) {
      logger.warn(
        { unreadableSecrets: unreadableCount },
        "ARCHESTRA_SECRETS_ACCEPT_NEW_ENCRYPTION_KEY is set: accepting the new encryption key. Secrets encrypted with the previous key remain unreadable and must be re-entered. Unset the variable after this boot.",
      );
      await EncryptionKeyCanaryModel.replace(canary.id, newCanaryBlob());
      return;
    }
    throw new Error(mismatchMessage(unreadableCount));
  }

  // No canary yet — validate the key against pre-existing secrets before
  // trusting it.
  const unreadableCount = await countUndecryptableSecrets();
  if (unreadableCount > 0) {
    if (!config.secretsManager.acceptNewEncryptionKey) {
      throw new Error(mismatchMessage(unreadableCount));
    }
    logger.warn(
      { unreadableSecrets: unreadableCount },
      "ARCHESTRA_SECRETS_ACCEPT_NEW_ENCRYPTION_KEY is set: trusting the current encryption key despite existing secrets it cannot decrypt. Those secrets must be re-entered. Unset the variable after this boot.",
    );
  }
  await EncryptionKeyCanaryModel.create(newCanaryBlob());
}

// ===========================================================================
// Internal helpers
// ===========================================================================

const CANARY_PAYLOAD = { canary: "archestra-encryption-key-canary-v1" };

function newCanaryBlob(): string {
  return encryptSecretValue(CANARY_PAYLOAD).__encrypted;
}

/**
 * Attempt an encryption-key rotation: re-encrypt every stored secret from the
 * previous key to the current one. Returns true only when the migration ran and
 * left no secret unreadable, so the caller can trust the new key. A no-op (keys
 * identical) or any secret that decrypts with neither key returns false, so the
 * normal mismatch handling (abort / accept-new) still applies.
 */
async function reencryptForRotation(): Promise<boolean> {
  const previousSecret = config.secretsManager.encryptionSecretPrevious;
  const nextSecret = config.secretsManager.encryptionSecret;
  if (!previousSecret || !nextSecret) return false;

  const result = await reencryptStoredSecrets({ previousSecret, nextSecret });
  if (result.status === "noop") return false;
  if (result.unreadable > 0) {
    logger.error(
      { unreadable: result.unreadable, total: result.total },
      "Encryption-key rotation: some stored secrets could not be decrypted with " +
        "the previous key; not trusting the new ARCHESTRA_SECRETS_ENCRYPTION_SECRET.",
    );
    return false;
  }
  logger.info(
    { reencrypted: result.reencrypted, alreadyNew: result.alreadyNew },
    "Re-encrypted stored secrets under the new ARCHESTRA_SECRETS_ENCRYPTION_SECRET",
  );
  return true;
}

function canDecrypt(encrypted: string): boolean {
  try {
    decryptSecretValue({ __encrypted: encrypted });
    return true;
  } catch {
    return false;
  }
}

async function countUndecryptableSecrets(): Promise<number> {
  const rows = await SecretModel.findAllRaw();
  let count = 0;
  for (const row of rows) {
    if (!isEncryptedSecret(row.secret)) continue;
    if (!canDecrypt(row.secret.__encrypted)) count++;
  }
  return count;
}

function mismatchMessage(unreadableCount: number): string {
  return (
    "Startup aborted: the key derived from the current ARCHESTRA_SECRETS_ENCRYPTION_SECRET does not match " +
    `the key previously used to encrypt stored secrets (${unreadableCount} stored secret(s) are undecryptable). ` +
    "The encryption secret was changed, or this database came from an environment with a different secret. " +
    "Restore the previous secret, set ARCHESTRA_SECRETS_ENCRYPTION_SECRET_PREVIOUS so startup re-encrypts them, " +
    "or set ARCHESTRA_SECRETS_ACCEPT_NEW_ENCRYPTION_KEY=true to accept the new key — secrets encrypted with the " +
    "previous key will stay unreadable and must be re-entered."
  );
}
