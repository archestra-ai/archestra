/**
 * Agents with no setup script, recognised only from their gateway OAuth
 * client (services/connected-client-oauth.ts). Dependency-free so the
 * matcher's unit tests can load it without a database.
 */
export const OAUTH_ONLY_CLIENT_IDS = ["amp"] as const;
