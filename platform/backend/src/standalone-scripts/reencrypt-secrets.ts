// biome-ignore-all lint/suspicious/noConsole: standalone operator/CI script — console for TTY UX
/**
 * Encryption-key re-encryption migration.
 *
 * ARCHESTRA_AUTH_SECRET historically did double duty: it signed sessions AND
 * derived the key that encrypts DB-stored secrets. Those are now separate
 * (ARCHESTRA_AUTH_SESSION_SECRET and ARCHESTRA_SECRETS_ENCRYPTION_SECRET). When
 * the encryption secret changes — the initial split or any later rotation —
 * every DB-encrypted `secret` row must be decrypted under the previous key and
 * re-encrypted under the new one, or it becomes unreadable.
 *
 * This runs as a one-shot before the app (the Helm pre-upgrade migration Job,
 * chained after `drizzle-kit migrate`). It is idempotent and a no-op when the
 * key is unchanged, so it is safe to run on every deploy.
 *
 *   new  = HKDF(ARCHESTRA_SECRETS_ENCRYPTION_SECRET ?? ARCHESTRA_AUTH_SECRET)
 *   prev = HKDF(ARCHESTRA_SECRETS_ENCRYPTION_SECRET_PREVIOUS ?? ARCHESTRA_AUTH_SECRET)
 *
 * Run (dev, from backend/):
 *   pnpm db:reencrypt-secrets
 * Run (prod image, from /app/backend):
 *   node dist/standalone-scripts/reencrypt-secrets.mjs
 *
 * Needs the same DB env as the server, plus both encryption secrets.
 */
import config from "@/config";
import { reencryptStoredSecrets } from "@/secrets-manager/reencrypt";

async function main(): Promise<void> {
  const nextSecret = config.secretsManager.encryptionSecret;
  const previousSecret = config.secretsManager.encryptionSecretPrevious;

  if (!nextSecret) {
    throw new Error(
      "ARCHESTRA_SECRETS_ENCRYPTION_SECRET (or legacy ARCHESTRA_AUTH_SECRET) must be set",
    );
  }
  if (!previousSecret) {
    console.log(
      "[reencrypt-secrets] no previous encryption secret resolved — nothing to migrate.",
    );
    return;
  }

  const result = await reencryptStoredSecrets({ previousSecret, nextSecret });

  if (result.status === "noop") {
    console.log(
      "[reencrypt-secrets] encryption secret unchanged — nothing to re-encrypt.",
    );
    return;
  }

  console.log(
    `[reencrypt-secrets] done: reencrypted=${result.reencrypted} ` +
      `alreadyNew=${result.alreadyNew} notEncrypted=${result.notEncrypted} ` +
      `unreadable=${result.unreadable} total=${result.total}`,
  );
  if (result.unreadable > 0) {
    console.warn(
      `[reencrypt-secrets] WARNING: ${result.unreadable} secret(s) could not be ` +
        "decrypted with the previous key and must be re-entered.",
    );
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[reencrypt-secrets] failed:", err);
    process.exit(1);
  });
