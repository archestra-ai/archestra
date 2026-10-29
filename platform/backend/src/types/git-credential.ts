import { z } from "zod";
import { GitProviderSchema } from "./git-host";

/** A stored credential that reads repositories: a GitHub App or a GitLab token. */
export const GitCredentialSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  provider: GitProviderSchema,
  kind: z.enum(["github_app", "gitlab_token"]),
  /** Web address of its host, e.g. https://github.com or https://gitlab.example.com. */
  webUrl: z.string(),
  createdAt: z.date(),
});

export const CreateGitlabTokenRequestSchema = z.object({
  name: z.string().trim().min(1).max(120),
  gitlabUrl: z
    .string()
    .trim()
    .default("https://gitlab.com")
    .describe("GitLab web address, e.g. https://gitlab.com"),
  token: z
    .string()
    .trim()
    .min(1)
    .describe(
      "A project, group, or personal access token. Write-only: never returned.",
    ),
});

export const GitRepositorySummarySchema = z.object({
  path: z.string(),
  private: z.boolean(),
  defaultBranch: z.string().nullable(),
});

export type GitCredential = z.infer<typeof GitCredentialSchema>;
export type CreateGitlabTokenRequest = z.infer<
  typeof CreateGitlabTokenRequestSchema
>;
