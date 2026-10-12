import { z } from "zod";

const GithubLoginSchema = z
  .string()
  .trim()
  .min(1)
  .max(39)
  .regex(
    /^[a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9]))*$/,
    "Use the organization's GitHub name",
  );

export const StartAppaGithubAppSchema = z.object({
  organization: GithubLoginSchema,
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
  z.object({ id: z.string().uuid(), account: z.string().nullable() }),
);
