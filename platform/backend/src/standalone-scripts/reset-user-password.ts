// biome-ignore-all lint/suspicious/noConsole: standalone operator CLI — uses console for TTY UX
/**
 * User password-reset CLI.
 *
 * Archestra has no email provider, so there is no self-service "forgot
 * password" flow. This script is the recovery path an operator with shell
 * access to the deployment uses to reset any user's password directly against
 * the database — it is what fulfils the sign-in page's "ask an administrator to
 * reset it" for locked-out members and admins alike.
 *
 * It resets any existing user (matched by email), revokes all of that user's
 * sessions, and can optionally clear a lost second factor. Access control is
 * the shell/database access required to run it, not an in-app role.
 *
 * Run in development (from `backend/`):
 *
 *   tsx --tsconfig standalone-scripts.tsconfig.json \
 *     src/standalone-scripts/reset-user-password.ts --email user@example.com
 *
 * Run in production (the script ships compiled in the image; from `/app/backend`):
 *
 *   node dist/standalone-scripts/reset-user-password.mjs --email user@example.com
 *
 * The process needs the database connection string in its environment
 * (`ARCHESTRA_DATABASE_URL` or `DATABASE_URL`), the same as the server.
 *
 *   e.g. K8s / external-DB Docker (URL already in the pod/container env):
 *     kubectl exec -it deploy/archestra-platform -- sh -c \
 *       'cd /app/backend && node dist/standalone-scripts/reset-user-password.mjs --email user@example.com'
 *
 *   e.g. all-in-one quickstart image with bundled Postgres (the URL is not
 *   exported to an `exec` shell, so pass it explicitly — adjust if you
 *   overrode POSTGRES_USER / POSTGRES_PASSWORD / POSTGRES_DB):
 *     docker exec -it <container> sh -c 'cd /app/backend && \
 *       ARCHESTRA_DATABASE_URL="postgresql://archestra:archestra_dev_password@localhost:5432/archestra_dev?schema=public" \
 *       node dist/standalone-scripts/reset-user-password.mjs --email user@example.com'
 *
 * Options:
 *   --email <email>        (required) email of the user whose password to reset
 *   --password <password>  new password (8–128 chars); omit to generate a
 *                          strong random one and print it
 *   --disable-two-factor   also remove the user's two-factor enrollment
 *                          (recover a user who lost their 2FA device)
 *   --help                 print usage
 */
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { hashPassword } from "better-auth/crypto";
import config from "@/config";
import db, { initializeDatabase } from "@/database";
import logger from "@/logging";
// Import models directly from their files rather than via the "@/models"
// barrel: the barrel eagerly loads every model (some of which pull in services
// and the Better Auth instance), which would boot the whole auth stack just to
// reset a password. A break-glass recovery tool must stay independent of that.
import AccountModel from "@/models/account";
import AuditLogModel from "@/models/audit-log";
import MemberModel from "@/models/member";
import SessionModel from "@/models/session";
import TwoFactorModel from "@/models/two-factor";
import UserModel from "@/models/user";

/** Better Auth's default password length bounds, enforced on sign-in forms. */
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 128;

/**
 * Reset any user's password without an email round-trip.
 *
 * - Creates the credential account if the user is SSO-only, otherwise
 *   replaces the stored hash (same behavior as Better Auth's own reset flow).
 * - Revokes every session so stolen or stale sessions die with the old
 *   password.
 * - Optionally clears two-factor enrollment for lost-device recovery.
 * - Runs all of the above in a single transaction, so a crash mid-reset rolls
 *   back cleanly instead of leaving a new password with live old sessions.
 *
 * There is no in-app role check: the caller is trusted by virtue of having
 * shell/database access to the deployment.
 *
 * @public — exported for testability
 */
export async function resetUserPassword(params: {
  email: string;
  newPassword: string;
  disableTwoFactor?: boolean;
}): Promise<{
  userId: string;
  email: string;
  credentialAccountCreated: boolean;
  twoFactorCleared: boolean;
  userIsBanned: boolean;
}> {
  const email = params.email.trim().toLowerCase();
  const { newPassword, disableTwoFactor = false } = params;

  if (
    newPassword.length < MIN_PASSWORD_LENGTH ||
    newPassword.length > MAX_PASSWORD_LENGTH
  ) {
    throw new Error(
      `Password must be between ${MIN_PASSWORD_LENGTH} and ${MAX_PASSWORD_LENGTH} characters`,
    );
  }

  const user = await UserModel.findByEmail(email);
  if (!user) {
    throw new Error(`No user found with email "${email}"`);
  }

  const passwordHash = await hashPassword(newPassword);

  let credentialAccountCreated = false;
  let twoFactorCleared = false;

  // Run every mutation in one transaction: a crash mid-reset must not leave the
  // user with a new password but still-live old sessions (or a half-cleared
  // second factor). The audit write stays outside — it is best-effort and must
  // never roll back an otherwise-completed reset.
  await db.transaction(async (tx) => {
    const credentialAccount = await AccountModel.getCredentialAccountByUserId(
      user.id,
      tx,
    );
    if (credentialAccount) {
      await AccountModel.setPassword({
        id: credentialAccount.id,
        passwordHash,
        tx,
      });
    } else {
      // SSO-only user: give them an email/password account so they can sign in
      // with the new password.
      await AccountModel.createCredentialAccount({
        userId: user.id,
        passwordHash,
        tx,
      });
      credentialAccountCreated = true;
    }

    if (disableTwoFactor && user.twoFactorEnabled) {
      await TwoFactorModel.deleteAllByUserId(user.id, tx);
      await UserModel.patch(user.id, { twoFactorEnabled: false }, tx);
      twoFactorCleared = true;
    }

    // Sign the user out everywhere: anyone holding a session under the old
    // password loses it.
    await SessionModel.deleteAllByUserId(user.id, tx);
  });

  await writeAuditLog({
    userId: user.id,
    email,
    credentialAccountCreated,
    twoFactorCleared,
  });

  return {
    userId: user.id,
    email,
    credentialAccountCreated,
    twoFactorCleared,
    userIsBanned: user.banned === true,
  };
}

/**
 * CLI entry point
 */
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli()
    .then((exitCode) => process.exit(exitCode))
    .catch((error) => {
      console.error(`\n❌ ${error instanceof Error ? error.message : error}`);
      process.exit(1);
    });
}

// ===== Internal helpers =====

/**
 * Audit rows are scoped to an organization, so attribute the reset to the
 * user's first organization. A user with no membership yet (e.g. mid-
 * provisioning) simply produces no audit row — the reset still stands. The
 * write never fails the command (same stance as the auth-surface audit writes).
 */
async function writeAuditLog(params: {
  userId: string;
  email: string;
  credentialAccountCreated: boolean;
  twoFactorCleared: boolean;
}): Promise<void> {
  const membership = await MemberModel.getFirstMembershipForUser(params.userId);
  if (!membership) {
    logger.debug(
      { userId: params.userId },
      "[reset-user-password] user has no organization; skipping audit row",
    );
    return;
  }

  try {
    await AuditLogModel.create({
      organizationId: membership.organizationId,
      actorId: null,
      actorType: "system",
      actorName: "reset-user-password CLI",
      actorEmail: null,
      action: "user.password_reset",
      outcome: "success",
      resourceType: "user",
      resourceId: params.userId,
      before: null,
      after: {
        email: params.email,
        credentialAccountCreated: params.credentialAccountCreated,
        twoFactorCleared: params.twoFactorCleared,
        sessionsRevoked: true,
      },
      occurredAt: new Date(),
    });
  } catch (err) {
    logger.error(
      { err, userId: params.userId },
      "[reset-user-password] failed to write audit row",
    );
  }
}

async function runCli(): Promise<number> {
  const { values } = parseArgs({
    options: {
      email: { type: "string" },
      password: { type: "string" },
      "disable-two-factor": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });

  if (values.help || !values.email) {
    printUsage();
    return values.help ? 0 : 1;
  }

  const generatedPassword = values.password ? null : generatePassword();
  const newPassword = values.password ?? generatedPassword;
  if (!newPassword) {
    throw new Error("Unable to determine a new password");
  }

  await initializeDatabase();

  const result = await resetUserPassword({
    email: values.email,
    newPassword,
    disableTwoFactor: values["disable-two-factor"],
  });

  console.log(`\n✅ Password reset for ${result.email}`);
  if (generatedPassword) {
    console.log(`\n   New password: ${generatedPassword}\n`);
    console.log(
      "   Store it securely — it is not persisted anywhere else. The user",
    );
    console.log(
      "   should sign in and change it under Settings → Your Account.",
    );
  }
  if (result.credentialAccountCreated) {
    console.log(
      "\nℹ️  The user had no email/password account (SSO-only); one was created.",
    );
  }
  if (result.twoFactorCleared) {
    console.log("\nℹ️  Two-factor authentication was disabled for the user.");
  }
  console.log("\nℹ️  All of the user's sessions were revoked.");
  if (result.userIsBanned) {
    console.log(
      "\n⚠️  This user is banned and still cannot sign in until unbanned.",
    );
  }
  if (config.auth.disableBasicAuth) {
    console.log(
      "\n⚠️  ARCHESTRA_AUTH_DISABLE_BASIC_AUTH is enabled: email/password sign-in",
    );
    console.log(
      "   is currently turned off, so the new password is only usable after",
    );
    console.log("   re-enabling basic auth.");
  }

  return 0;
}

function generatePassword(): string {
  // 18 random bytes → 24 base64url chars (~144 bits of entropy), well within
  // Better Auth's 8–128 length bounds.
  return randomBytes(18).toString("base64url");
}

function printUsage(): void {
  console.log(`
Reset an Archestra user's password (no email required).

Usage (development, from backend/):
  tsx --tsconfig standalone-scripts.tsconfig.json \\
    src/standalone-scripts/reset-user-password.ts --email <email> [options]

Usage (production image, from /app/backend):
  node dist/standalone-scripts/reset-user-password.mjs --email <email> [options]

Options:
  --email <email>        (required) email of the user whose password to reset
  --password <password>  new password (${MIN_PASSWORD_LENGTH}-${MAX_PASSWORD_LENGTH} chars); omit to generate a
                         strong random one and print it
  --disable-two-factor   also remove the user's two-factor enrollment
                         (recover a user who lost their 2FA device)
  --help                 print this help
`);
}
