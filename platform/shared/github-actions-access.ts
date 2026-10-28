import { z } from "zod";
import { GITHUB_COM_API_URL } from "./github";

/**
 * Who may trade a GitHub Actions OIDC token for access to an MCP gateway.
 * A pull-request job from one of `repositories`, running one of `workflows`,
 * acts as the pull request's author, or with `actAs: "actor"` as the GitHub
 * user who started the run, when that person connected the GitHub App named
 * by `githubAppCredentialKey` to their own account.
 */
export const GITHUB_ACTIONS_ACCESS_MAX_ENTRIES = 50;

/**
 * An entry of `repositories`: `owner/name`, as GitHub spells a repository's
 * full name, or `owner/*` for every repository of that owner, including ones
 * created later. Not a repository name: it can hold a wildcard.
 */
export const GITHUB_ACTIONS_REPOSITORY_REGEX =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/(?:[A-Za-z0-9._-]{1,100}|\*)$/;

/**
 * A `job_workflow_ref` claim: `owner/repo/.github/workflows/<file>@<ref>`.
 * The ref must be a branch, a tag, or a full commit SHA. A pull request's own
 * ref is refused: its workflow file is whatever the pull request says.
 */
export const GITHUB_JOB_WORKFLOW_REF_REGEX =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}\/\.github\/workflows\/[A-Za-z0-9._/-]+\.ya?ml@(?:refs\/heads\/[^\s@]+|refs\/tags\/[^\s@]+|[0-9a-f]{40})$/;

export const GITHUB_ACTIONS_REPOSITORY_MESSAGE =
  "Enter a repository as owner/name, or owner/* for all of an owner's repositories";
export const GITHUB_JOB_WORKFLOW_REF_MESSAGE =
  "Enter a workflow as owner/repo/.github/workflows/<file>.yml@<ref>, where <ref> is refs/heads/<branch>, refs/tags/<tag>, or a full commit SHA";

export const GitHubActionsAccessSchema = z.object({
  /** Key of the organization `github_app` credential the jobs post as. */
  githubAppCredentialKey: z.string().min(1).max(200),
  /** Repositories whose pull-request jobs may ask; matched case-insensitively. */
  repositories: z
    .array(
      z.string().max(140).regex(GITHUB_ACTIONS_REPOSITORY_REGEX, {
        message: GITHUB_ACTIONS_REPOSITORY_MESSAGE,
      }),
    )
    .min(1, { message: "Add at least one repository" })
    .max(GITHUB_ACTIONS_ACCESS_MAX_ENTRIES)
    .refine(
      (repositories) =>
        new Set(repositories.map((repository) => repository.toLowerCase()))
          .size === repositories.length,
      { message: "Each repository can be listed once" },
    )
    .refine(
      (repositories) => {
        const owners = new Set(
          repositories
            .filter((repository) => repository.endsWith("/*"))
            .map((repository) => repositoryOwner(repository)),
        );
        return repositories.every(
          (repository) =>
            repository.endsWith("/*") ||
            !owners.has(repositoryOwner(repository)),
        );
      },
      { message: "An owner/* entry already covers that owner's repositories" },
    ),
  /**
   * Whose account a run uses. `author` (the default): the pull request's
   * author, and only for a run the author started. `actor`: whoever started
   * the run, so someone who asks for a review on another person's pull
   * request uses their own account; the trusted workflow then decides whose
   * runs to start.
   */
  actAs: z.enum(["author", "actor"]).optional(),
  /**
   * True: the repository token also gets contents: write, which GitHub
   * requires to resolve a review thread. Otherwise it reads contents only.
   */
  resolveReviewThreads: z.boolean().optional(),
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
 * A stored setting as reads return it. The entries are not checked again, so
 * a row that a later or earlier version saved with other rules still loads;
 * saving it goes through `GitHubActionsAccessSchema`.
 */
export const StoredGitHubActionsAccessSchema = z.object({
  githubAppCredentialKey: z.string(),
  repositories: z.array(z.string()),
  // A value this version does not know reads as the default, the author.
  actAs: z.enum(["author", "actor"]).optional().catch(undefined),
  resolveReviewThreads: z.boolean().optional().catch(undefined),
  workflows: z.array(z.string()),
});

/**
 * Whether a listed entry admits a repository: the same `owner/name`, or
 * `owner/*` for any repository of that owner. Case-insensitive, as GitHub is.
 */
export function gitHubRepositoryMatches(
  allowed: string,
  repository: string,
): boolean {
  // An entry that is not exactly owner/name or owner/* (a stored row can hold
  // one) matches nothing, rather than a shorter, broader rule.
  const entry = repositoryParts(allowed);
  const name = repositoryParts(repository);
  if (!entry || !name) return false;
  return entry[0] === name[0] && (entry[1] === "*" || entry[1] === name[1]);
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
 * - `not_author`: the gateway acts only as the pull request's author, and
 *   someone else started the run.
 * - `not_linked`: the person the token would act as has no working GitHub
 *   connection through the gateway's GitHub App.
 * - `ambiguous_link`: more than one account connected that GitHub user.
 * - `forbidden`: the account of the person the token would act as may not use
 *   the gateway.
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

function repositoryOwner(repository: string): string {
  return repository.slice(0, repository.indexOf("/")).toLowerCase();
}

/** `[owner, name]` in lower case, or null unless both are non-empty. */
function repositoryParts(repository: string): [string, string] | null {
  const parts = repository.toLowerCase().split("/");
  return parts.length === 2 && parts[0] && parts[1]
    ? [parts[0], parts[1]]
    : null;
}
