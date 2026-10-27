import { ResourcePermissionGrantSchema } from "@archestra/shared";
import { z } from "zod";

/** The GitHub to use: https://github.com, or an Enterprise address. */
const GithubUrlSchema = z.string().trim().url().max(500);

/** A GitHub organization login. */
const GithubOrganizationSchema = z
  .string()
  .trim()
  .max(39)
  .regex(
    /^[a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9]))*$/,
    "Use a GitHub organization name",
  );

/** Who may use the new key; omitted, everyone in the organization. */
const GrantsSchema = z.array(ResourcePermissionGrantSchema).max(200).optional();

export const StartCopilotGithubAppSchema = z.object({
  githubUrl: GithubUrlSchema.default("https://github.com"),
  organization: GithubOrganizationSchema,
});

export const CopilotGithubAppManifestSchema = z.object({
  /** GitHub's "create App from manifest" page; the browser posts `manifest` there. */
  url: z.string().url(),
  manifest: z.string(),
});

export const CompleteCopilotGithubAppSchema = z.object({
  code: z.string().trim().min(1).max(200),
  state: z.string().trim().min(1).max(200),
});

export const PendingCopilotGithubAppSchema = z.object({
  name: z.string(),
  slug: z.string(),
  organization: z.string(),
  appId: z.string(),
  /** GitHub's install page for the organization. */
  installUrl: z.string().url(),
  settingsUrl: z.string().url(),
});
export type PendingCopilotGithubApp = z.infer<
  typeof PendingCopilotGithubAppSchema
>;

export const InstallCopilotGithubAppSchema = z.object({
  grants: GrantsSchema,
});

export const CopilotGithubAppConnectedSchema = z.object({
  status: z.literal("installed"),
  /** The provider key that now holds the App. */
  id: z.string().uuid(),
  organization: z.string(),
  modelIds: z.array(z.string()),
});

export const CopilotGithubAppInstallResultSchema = z.discriminatedUnion(
  "status",
  [z.object({ status: z.literal("waiting") }), CopilotGithubAppConnectedSchema],
);

const ExistingAppFieldsSchema = z.object({
  githubUrl: GithubUrlSchema.default("https://github.com"),
  appId: z.string().trim().regex(/^\d+$/, "GitHub App ID must be a number"),
  organization: GithubOrganizationSchema,
  /** The App's private key (PEM). Never returned or logged. */
  privateKey: z.string().min(1).max(20_000),
});

export const ValidateExistingCopilotGithubAppSchema = ExistingAppFieldsSchema;

export const ExistingCopilotGithubAppValidationSchema = z.object({
  /** GitHub's own fingerprint format, as on the App settings page. */
  fingerprint: z.string(),
  installationId: z.string(),
  organization: z.string(),
});

export const ConnectExistingCopilotGithubAppSchema =
  ExistingAppFieldsSchema.extend({
    grants: GrantsSchema,
    /** Replace the App credentials of this key instead of adding a key. */
    replaceKeyId: z.string().uuid().optional(),
  });

export const CopilotGithubAppKeySummarySchema = z.object({
  /** The GitHub organization the App is installed on, and billed to. */
  organization: z.string().nullable(),
  appId: z.string(),
  appName: z.string().nullable(),
  /** The private key's fingerprint, as GitHub shows it on the App page. */
  fingerprint: z.string(),
  modelCount: z.number().int(),
});

export const ReplaceCopilotGithubAppPrivateKeySchema = z.object({
  /** The App's new private key (PEM). Never returned or logged. */
  privateKey: z.string().min(1).max(20_000),
});
