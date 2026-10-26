import { z } from "zod";

export const GitHubActionsTokenRequestSchema = z.object({
  /** The job's GitHub Actions OIDC token, requested with this deployment's URL as audience. */
  token: z.string().min(1).max(16_384),
  /** The MCP gateway URL the token is for: `<base URL>/v1/mcp/<gateway id>`. */
  resource: z.string().min(1).max(2048),
});

export const GitHubActionsTokenResponseSchema = z.object({
  /** Bearer token for the gateway in `resource`, acting as the pull request's author. */
  access_token: z.string(),
  token_type: z.literal("Bearer"),
  /** Seconds until `access_token` expires. */
  expires_in: z.number().int().positive(),
  /** GitHub App installation token for the pull request's repository only. */
  github_token: z.string(),
  /** When `github_token` expires, as an ISO 8601 timestamp. */
  github_token_expires_at: z.string(),
  /** The pull request author's GitHub login. */
  github_login: z.string(),
  /** The pull request author's user id in this deployment. */
  user_id: z.string(),
});
export type GitHubActionsTokenResponse = z.infer<
  typeof GitHubActionsTokenResponseSchema
>;

/**
 * - `invalid_request`: the body is malformed, or `resource` is not this
 *   deployment's MCP gateway URL.
 * - `invalid_token`: the OIDC token is not genuine, not for this deployment,
 *   expired, or already exchanged.
 * - `not_trusted`: the gateway does not accept this repository, workflow or
 *   event, the pull request comes from a fork, or the GitHub App cannot read it.
 * - `not_linked`: the pull request's author has not connected GitHub to an
 *   account here through the gateway's GitHub App.
 * - `ambiguous_link`: more than one account here connected that GitHub user.
 * - `forbidden`: the author's account may not use the gateway.
 * - `rate_limited`: too many requests from this address.
 * - `github_error`: GitHub refused or failed a request.
 */
export const GitHubActionsTokenErrorCodeSchema = z.enum([
  "invalid_request",
  "invalid_token",
  "not_trusted",
  "not_linked",
  "ambiguous_link",
  "forbidden",
  "rate_limited",
  "github_error",
]);

export const GitHubActionsTokenErrorSchema = z.object({
  error: GitHubActionsTokenErrorCodeSchema,
  message: z.string(),
  /** The pull request author's GitHub login, once it is known. */
  login: z.string().optional(),
});
export type GitHubActionsTokenError = z.infer<
  typeof GitHubActionsTokenErrorSchema
>;
