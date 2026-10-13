import { z } from "zod";
import { PolicyTestDirectorySchema } from "./openappa-policy-tests";

/** A repository as `owner/name`, the way GitHub shows it. */
const GithubRepositorySchema = z
  .string()
  .trim()
  .max(140)
  .regex(
    /^[a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9]))*\/[a-zA-Z0-9_.-]+$/,
    "Use owner/name",
  );

/** The GitHub to use: https://github.com, or an Enterprise Server address. */
const GithubUrlSchema = z.string().trim().url().max(500);

/** A GitHub login, or anything that names one, like a pasted profile URL. */
const GithubLoginSchema = z
  .string()
  .trim()
  .max(39)
  .regex(
    /^[a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9]))*$/,
    "Use a GitHub organization name",
  );

/** Registers the App on the organization that owns the policy repository. */
export const StartAppaGithubAppSchema = z.object({
  githubUrl: GithubUrlSchema,
  owner: GithubLoginSchema,
});

export const AppaGithubRepositoryQuerySchema = z.object({
  /** The App to look through; setup always has one by now. */
  credentialId: z.string().uuid(),
  repo: GithubRepositorySchema,
  ref: z.string().trim().min(1).max(200).optional(),
  path: z
    .string()
    .trim()
    .max(500)
    .regex(/^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*\.toml$/)
    .optional(),
  validationDirectory: PolicyTestDirectorySchema.optional(),
});

/**
 * `template`: a private copy of the template, seeded with the current policy.
 * `empty`: no commits yet; setup writes the template's files and the policy.
 * `policy`: already holds the policy file, which becomes the policy source.
 * `other`: readable, without the policy file.
 * `unreachable`: the App cannot read the repository.
 * `app_error`: the App cannot sign in to GitHub at all.
 *
 * `validations` says whether the validations folder exists, for `policy` and
 * `other`; template copies and empty repositories get it from the template.
 */
export const AppaGithubRepositoryStatusSchema = z.object({
  status: z.enum([
    "template",
    "empty",
    "policy",
    "other",
    "unreachable",
    "app_error",
  ]),
  validations: z.boolean().nullable(),
});
export type AppaGithubRepositoryStatus = z.infer<
  typeof AppaGithubRepositoryStatusSchema
>;

export const AppaGithubAppRepositoriesQuerySchema = z.object({
  credentialId: z.string().uuid(),
});

/**
 * Repositories a GitHub App can reach, recent template copies first, and
 * GitHub's page for changing that list.
 */
export const AppaGithubAppRepositoriesSchema = z.object({
  repositories: z.array(
    z.object({
      fullName: z.string(),
      private: z.boolean(),
      description: z.string().nullable(),
      template: z.boolean(),
    }),
  ),
  manageUrl: z.string().nullable(),
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
  /** GitHub's ID for the App, to recognize it once it is saved as a credential. */
  appId: z.string(),
  /** The owning account on its GitHub, e.g. https://github.com/acme. */
  accountUrl: z.string(),
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

/** The GitHub account each organization GitHub App is installed on. */
export const AppaGithubAppAccountsSchema = z.array(
  z.object({
    id: z.string().uuid(),
    account: z.string().nullable(),
  }),
);
