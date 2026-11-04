import { GitHubActionsTokenErrorCodeSchema } from "@archestra/shared";
import { z } from "zod";

export const GitHubActionsTokenRequestSchema = z.object({
  /** The job's GitHub Actions OIDC token, requested with this deployment's URL as audience. */
  token: z.string().min(1).max(16_384),
  /** The MCP gateway URL the token is for: `<base URL>/v1/mcp/<gateway id or slug>`. */
  resource: z.string().min(1).max(2048),
});

export const GitHubActionsTokenResponseSchema = z.object({
  /** Bearer token for the gateway in `resource`, acting as `github_login`. */
  access_token: z.string(),
  token_type: z.literal("Bearer"),
  /** Seconds until `access_token` expires. */
  expires_in: z.number().int().positive(),
  /** GitHub App installation token for the pull request's repository only. */
  github_token: z.string(),
  /** When `github_token` expires, as an ISO 8601 timestamp. */
  github_token_expires_at: z.string(),
  /**
   * GitHub login of the person the token acts as: the pull request's author,
   * or with the gateway's `actAs: "actor"`, whoever started the run.
   */
  github_login: z.string(),
  /** That person's user id in this deployment. */
  user_id: z.string(),
});
export type GitHubActionsTokenResponse = z.infer<
  typeof GitHubActionsTokenResponseSchema
>;

/** Every refusal; `error` is a stable code a workflow can branch on. */
export const GitHubActionsTokenErrorSchema = z.object({
  error: GitHubActionsTokenErrorCodeSchema,
  message: z.string(),
  /** GitHub login of the person the token would act as, once it is known. */
  login: z.string().optional(),
});
export type GitHubActionsTokenError = z.infer<
  typeof GitHubActionsTokenErrorSchema
>;
