import { z } from "zod";

/** Who will own the App: a login, or the account's address on any GitHub. */
export const StartGithubAppSchema = z.object({
  organization: z.string().trim().max(500),
});

export const GithubAppManifestSchema = z.object({
  /** GitHub's "create App from manifest" page; the browser posts `manifest` there. */
  url: z.string(),
  manifest: z.string(),
});

export const CompleteGithubAppSchema = z.object({
  code: z.string().min(1).max(512),
  state: z.string().min(1).max(256),
});

/** An App created on GitHub that is not installed yet. */
export const PendingGithubAppSchema = z.object({
  name: z.string(),
  slug: z.string(),
  account: z.string(),
  /** GitHub's ID for the App, to recognize it once it is saved as a credential. */
  appId: z.string(),
  /** The owning account on its GitHub, e.g. https://github.com/my-org. */
  accountUrl: z.string(),
  htmlUrl: z.string(),
  installUrl: z.string(),
  /** Where the admin can upload a logo; GitHub's manifest cannot set one. */
  settingsUrl: z.string(),
});
export type PendingGithubApp = z.infer<typeof PendingGithubAppSchema>;
