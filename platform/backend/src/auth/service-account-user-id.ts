/** Prefix of the synthetic user id minted for service-account principals. */
export const SERVICE_ACCOUNT_USER_ID_PREFIX = "service-account:";

/**
 * Whether a user id is the synthetic id minted for service-account principals
 * (`service-account:<id>`, see fastify-plugin/middleware.ts). Such ids have no
 * `users` row, so anything that writes a `user_id` foreign key must not use them.
 */
export const isServiceAccountUserId = (userId: string): boolean =>
  userId.startsWith(SERVICE_ACCOUNT_USER_ID_PREFIX);
