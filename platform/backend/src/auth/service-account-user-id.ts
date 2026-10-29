/** Prefix of the synthetic user id minted for service-account principals. */
export const SERVICE_ACCOUNT_USER_ID_PREFIX = "service-account:";

/**
 * Whether a user id is the synthetic id minted for service-account principals
 * (`service-account:<id>`, see fastify-plugin/middleware.ts). Such ids have no
 * `users` row, so anything that writes a `user_id` foreign key must not use them.
 */
export const isServiceAccountUserId = (userId: string): boolean =>
  userId.startsWith(SERVICE_ACCOUNT_USER_ID_PREFIX);

/** The synthetic user id a service account acts under. */
export const serviceAccountUserId = (serviceAccountId: string): string =>
  `${SERVICE_ACCOUNT_USER_ID_PREFIX}${serviceAccountId}`;

/** The service account behind a synthetic user id, or null for anyone else. */
export const serviceAccountIdFromUserId = (userId: string): string | null =>
  isServiceAccountUserId(userId)
    ? userId.slice(SERVICE_ACCOUNT_USER_ID_PREFIX.length)
    : null;

/** Runtime ownership uses an actor pair rather than a human-only user FK. */
export function actorFromUserId(userId: string): {
  kind: "user" | "serviceAccount";
  id: string;
} {
  const id = serviceAccountIdFromUserId(userId);
  return id ? { kind: "serviceAccount", id } : { kind: "user", id: userId };
}

/**
 * Owner columns for a principal on a table owned by a person (`user_id`) or a
 * service account (`service_account_id`); exactly one is set.
 */
export function ownerColumnsFromUserId(userId: string): {
  userId: string | null;
  serviceAccountId: string | null;
} {
  const serviceAccountId = serviceAccountIdFromUserId(userId);
  return serviceAccountId
    ? { userId: null, serviceAccountId }
    : { userId, serviceAccountId: null };
}

/** The principal id behind a row's owner columns; inverse of {@link ownerColumnsFromUserId}. */
export function userIdFromOwnerColumns(row: {
  userId: string | null;
  serviceAccountId: string | null;
}): string {
  if (row.userId) return row.userId;
  if (row.serviceAccountId) return serviceAccountUserId(row.serviceAccountId);
  throw new Error("row has no owner");
}
