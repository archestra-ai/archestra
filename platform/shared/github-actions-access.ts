import { z } from "zod";

/**
 * Who may trade a GitHub Actions OIDC token for access to an MCP gateway.
 * A pull-request job from one of `repositories`, running one of `workflows`,
 * acts as the pull request's author when that author connected the GitHub App
 * named by `githubAppCredentialKey` to their own account.
 */
export const GITHUB_ACTIONS_ACCESS_MAX_ENTRIES = 50;

/** `owner/name`, as GitHub spells a repository's full name. */
export const GITHUB_REPOSITORY_FULL_NAME_REGEX =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

/**
 * A `job_workflow_ref` claim: `owner/repo/.github/workflows/<file>@<ref>`.
 * The ref must be a branch, a tag, or a full commit SHA. A pull request's own
 * ref is refused: its workflow file is whatever the pull request says.
 */
export const GITHUB_JOB_WORKFLOW_REF_REGEX =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}\/\.github\/workflows\/[A-Za-z0-9._/-]+\.ya?ml@(?:refs\/heads\/[^\s@]+|refs\/tags\/[^\s@]+|[0-9a-f]{40})$/;

export const GITHUB_REPOSITORY_FULL_NAME_MESSAGE =
  "Enter a repository as owner/name";
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
