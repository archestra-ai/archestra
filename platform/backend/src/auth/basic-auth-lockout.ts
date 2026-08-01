import { and, eq, ne, notExists } from "drizzle-orm";
import config from "@/config";
import { CREDENTIAL_PROVIDER_ID } from "@/constants";
import db, { schema } from "@/database";
import logger from "@/logging";

/**
 * When ARCHESTRA_AUTH_DISABLE_BASIC_AUTH is on, revoke the sessions of every
 * user who can only have signed in with a password.
 *
 * The `session` row records nothing about how it was created — there is no
 * provider column — so a password session cannot be told apart from an SSO one
 * by inspection. What *can* be established is whether a user holds any
 * non-credential account: if they do not, every session they have was
 * necessarily obtained with a password, and the endpoints that could have
 * produced it are now closed.
 *
 * That makes this safe to run on every boot rather than once behind a marker:
 * users with a federated account are never touched, so deploys do not
 * repeatedly sign people out, and users without one cannot create a new
 * session for a later boot to sweep.
 *
 * The residual, stated plainly: a user holding *both* a credential account and
 * a linked SSO account keeps their current session even if it came from a
 * password. Telling those apart needs the provider recorded on the session at
 * creation time — a schema change, not a sweep. Such a user can already reach
 * the same access through SSO, so the gap is small, but it is not zero: this
 * is not "revoke every password session".
 *
 * Users with no accounts at all are swept too, since they also have no
 * federated account. That is intended: they cannot sign in by any route, so
 * leaving them a live session would serve nothing.
 */
export async function revokeBasicAuthOnlySessions(): Promise<void> {
  if (!config.auth.disableBasicAuth) {
    return;
  }

  const hasFederatedAccount = db
    .select({ one: schema.accountsTable.id })
    .from(schema.accountsTable)
    .where(
      and(
        eq(schema.accountsTable.userId, schema.sessionsTable.userId),
        ne(schema.accountsTable.providerId, CREDENTIAL_PROVIDER_ID),
      ),
    );

  const revoked = await db
    .delete(schema.sessionsTable)
    .where(notExists(hasFederatedAccount))
    .returning({ id: schema.sessionsTable.id });

  if (revoked.length > 0) {
    logger.warn(
      { revokedSessions: revoked.length },
      "[auth] basic auth is disabled — revoked sessions for users with no federated account; they must sign in through an identity provider",
    );
  }
}
