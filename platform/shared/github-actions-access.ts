import { z } from "zod";
import { GITHUB_COM_API_URL } from "./github";

/**
 * Who may trade a GitHub Actions OIDC token for access to an MCP gateway.
 * A pull-request job from one of `repositories`, running one of `workflows`,
 * acts as the pull request's author when that author connected the GitHub App
 * named by `githubAppCredentialKey` to their own account.
 */
export const GITHUB_ACTIONS_ACCESS_MAX_ENTRIES = 50;

/**
 * `owner/name`, as GitHub spells a repository's full name, or `owner/*` for
 * every repository of that owner, including ones created later.
 */
export const GITHUB_REPOSITORY_FULL_NAME_REGEX =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/(?:[A-Za-z0-9._-]{1,100}|\*)$/;

/**
 * A `job_workflow_ref` claim: `owner/repo/.github/workflows/<file>@<ref>`.
 * The ref must be a branch, a tag, or a full commit SHA. A pull request's own
 * ref is refused: its workflow file is whatever the pull request says.
 */
export const GITHUB_JOB_WORKFLOW_REF_REGEX =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}\/\.github\/workflows\/[A-Za-z0-9._/-]+\.ya?ml@(?:refs\/heads\/[^\s@]+|refs\/tags\/[^\s@]+|[0-9a-f]{40})$/;

export const GITHUB_REPOSITORY_FULL_NAME_MESSAGE =
  "Enter a repository as owner/name, or owner/* for all of an owner's repositories";
export const GITHUB_JOB_WORKFLOW_REF_MESSAGE =
  "Enter a workflow as owner/repo/.github/workflows/<file>.yml@<ref>, where <ref> is refs/heads/<branch>, refs/tags/<tag>, or a full commit SHA";

export const GitHubActionsAccessSchema = z.object({
  /** Key of the organization `github_app` credential the jobs post as. */
  githubAppCredentialKey: z.string().min(1).max(200),
  /** Repositories whose pull-request jobs may ask; matched case-insensitively. */
  repositories: z
    .array(
      z.string().max(140).regex(GITHUB_REPOSITORY_FULL_NAME_REGEX, {
        message: GITHUB_REPOSITORY_FULL_NAME_MESSAGE,
      }),
    )
    .min(1, { message: "Add at least one repository" })
    .max(GITHUB_ACTIONS_ACCESS_MAX_ENTRIES)
    .refine(
      (repositories) =>
        new Set(repositories.map((repository) => repository.toLowerCase()))
          .size === repositories.length,
      { message: "Each repository can be listed once" },
    ),
  /** Trusted `job_workflow_ref` claim values; matched exactly. */
  workflows: z
    .array(
      z.string().max(400).regex(GITHUB_JOB_WORKFLOW_REF_REGEX, {
        message: GITHUB_JOB_WORKFLOW_REF_MESSAGE,
      }),
    )
    .min(1, { message: "Add at least one trusted workflow" })
    .max(GITHUB_ACTIONS_ACCESS_MAX_ENTRIES)
    .refine((workflows) => new Set(workflows).size === workflows.length, {
      message: "Each workflow can be listed once",
    }),
});
export type GitHubActionsAccess = z.infer<typeof GitHubActionsAccessSchema>;

/**
 * Whether a listed entry admits a repository: the same `owner/name`, or
 * `owner/*` for any repository of that owner. Case-insensitive, as GitHub is.
 */
export function gitHubRepositoryMatches(
  allowed: string,
  repository: string,
): boolean {
  const entry = allowed.toLowerCase();
  const name = repository.toLowerCase();
  if (!entry.endsWith("/*")) return entry === name;
  const owner = entry.slice(0, -1);
  return name.startsWith(owner) && !name.slice(owner.length).includes("/");
}

/**
 * Whether a credential can be the App a GitHub Actions setting names: an
 * organization GitHub App on GitHub.com, where Actions OIDC tokens come from,
 * with the app ID and installation ID that minting tokens needs.
 */
export function isGitHubActionsAppCredential<
  T extends {
    kind: string;
    allowOrganization: boolean;
    githubUrl: string | null;
    appId: string | null;
    installationId: string | null;
  },
>(
  credential: T | null | undefined,
): credential is T & {
  kind: "github_app";
  githubUrl: string;
  appId: string;
  installationId: string;
} {
  return (
    credential?.kind === "github_app" &&
    credential.allowOrganization &&
    credential.githubUrl === GITHUB_COM_API_URL &&
    !!credential.appId &&
    !!credential.installationId
  );
}

/**
 * Why `POST /api/github-actions/token` refused, in its `error` field.
 *
 * - `invalid_request`: the body is malformed, or `resource` is not an MCP
 *   gateway URL of the deployment.
 * - `invalid_token`: the OIDC token is not genuine, not for the deployment,
 *   expired, or already exchanged.
 * - `not_trusted`: the gateway does not accept this run, the pull request comes
 *   from a fork, or the GitHub App cannot read it.
 * - `not_author`: someone other than the pull request's author started the run.
 * - `not_linked`: the author has no working GitHub connection through the
 *   gateway's GitHub App.
 * - `ambiguous_link`: more than one account connected that GitHub user.
 * - `forbidden`: the author's account may not use the gateway.
 * - `rate_limited`: too many requests from this address.
 * - `github_error`: GitHub refused or failed a request, or the App credential
 *   could not be used.
 * - `server_error`: the exchange failed unexpectedly.
 */
export const GitHubActionsTokenErrorCodeSchema = z.enum([
  "invalid_request",
  "invalid_token",
  "not_trusted",
  "not_author",
  "not_linked",
  "ambiguous_link",
  "forbidden",
  "rate_limited",
  "github_error",
  "server_error",
]);
export type GitHubActionsTokenErrorCode = z.infer<
  typeof GitHubActionsTokenErrorCodeSchema
>;
