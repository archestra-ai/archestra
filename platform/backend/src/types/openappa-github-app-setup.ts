import { z } from "zod";

const GithubLoginSchema = z
  .string()
  .trim()
  .min(1)
  .max(39)
  .regex(
    /^[a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9]))*$/,
    "Use the GitHub account name",
  );

/** A repository as `owner/name`, the way GitHub shows it. */
const GithubRepositorySchema = z
  .string()
  .trim()
  .max(140)
  .regex(
    /^[a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9]))*\/[a-zA-Z0-9_.-]+$/,
    "Use owner/name",
  );

/** Registers the App on the account that owns the policy repository. */
export const StartAppaGithubAppSchema = z.object({
  owner: GithubLoginSchema,
});

export const InstallAppaGithubAppSchema = z.object({
  repo: GithubRepositorySchema,
});

export const AppaGithubRepositoryQuerySchema = z.object({
  repo: GithubRepositorySchema,
});

/**
 * `template`: a private, unchanged-looking copy of the template, ready to use.
 * `other`: exists with other content or visibility. `unknown`: no App can see it.
 */
export const AppaGithubRepositoryStatusSchema = z.object({
  status: z.enum(["template", "other", "unknown"]),
});
export type AppaGithubRepositoryStatus = z.infer<
  typeof AppaGithubRepositoryStatusSchema
>;

export const AppaGithubAppAccountsQuerySchema = z.object({
  repo: GithubRepositorySchema.optional(),
});

/** What the browser posts to GitHub to register the App from a manifest. */
export const AppaGithubAppManifestSchema = z.object({
  url: z.string(),
  manifest: z.string(),
});

export const CompleteAppaGithubAppSchema = z.object({
  code: z.string().min(1).max(512),
  state: z.string().min(1).max(256),
});

/** An App created on GitHub that is not installed yet. */
export const PendingAppaGithubAppSchema = z.object({
  name: z.string(),
  slug: z.string(),
  account: z.string(),
  htmlUrl: z.string(),
  installUrl: z.string(),
  /** Where the admin can upload a logo; GitHub's manifest cannot set one. */
  settingsUrl: z.string(),
});
export type PendingAppaGithubApp = z.infer<typeof PendingAppaGithubAppSchema>;

export const AppaGithubAppInstallResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("waiting") }),
  z.object({
    status: z.literal("installed"),
    id: z.string().uuid(),
    name: z.string(),
    account: z.string(),
  }),
]);

/**
 * The GitHub account each organization GitHub App is installed on and, when a
 * repository was given, whether the App can reach it.
 */
export const AppaGithubAppAccountsSchema = z.array(
  z.object({
    id: z.string().uuid(),
    account: z.string().nullable(),
    canAccessRepo: z.boolean().nullable(),
  }),
);
