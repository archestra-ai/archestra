import { ResourcePermissionGrantSchema } from "@archestra/shared";
import { z } from "zod";

/**
 * The organization: its name on github.com, or its address on any GitHub host
 * (https://github.com/my-org, https://github.example.com/my-org,
 * https://my-company.ghe.com/my-org). The backend parses it.
 */
const GithubOrganizationSchema = z.string().trim().min(1).max(500);

/** Who may use the new key; omitted, everyone in the organization. */
const GrantsSchema = z.array(ResourcePermissionGrantSchema).max(200).optional();

export const StartCopilotGithubAppSchema = z.object({
  organization: GithubOrganizationSchema,
});

/** An App connected to the organization that lacks Copilot Requests on its installation. */
export const CopilotGithubAppNeedsPermissionSchema = z.object({
  status: z.literal("needs_permission"),
  appName: z.string(),
  organization: z.string(),
  /** Where an admin adds the permission. */
  settingsUrl: z.string(),
});

/** Use a GitHub App credential the organization already has. */
/** The new key's name; ignored when the step replaces a key's App. */
const KeyNameSchema = z.string().trim().min(1).max(256).optional();

export const ConnectCopilotGithubAppCredentialSchema = z.object({
  credentialId: z.string().uuid(),
  /** Omitted when reconnecting a key: the key's own organization is used. */
  organization: GithubOrganizationSchema.optional(),
  replaceKeyId: z.string().uuid().optional(),
  grants: GrantsSchema,
  name: KeyNameSchema,
});

export const InstallCopilotGithubAppSchema = z.object({
  grants: GrantsSchema,
  /** Reconnect this key with the new App instead of adding a key. */
  replaceKeyId: z.string().uuid().optional(),
  name: KeyNameSchema,
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
  appId: z.string().trim().regex(/^\d+$/, "GitHub App ID must be a number"),
  /** Omitted when replacing a key's App: the key's own organization is used. */
  organization: GithubOrganizationSchema.optional(),
  /** The App's private key (PEM). Never returned or logged. */
  privateKey: z.string().min(1).max(20_000),
  /** Reconnect this key: its stored organization stands in for `organization`. */
  replaceKeyId: z.string().uuid().optional(),
});

export const ValidateExistingCopilotGithubAppSchema = ExistingAppFieldsSchema;

/** Any input the setup takes as an organization, checked before a step uses it. */
export const CheckCopilotGithubOrganizationSchema = z.object({
  organization: z.string().trim().max(500),
});

export const CopilotGithubOrganizationSchema = z.object({
  /** The organization's login, as GitHub spells it. */
  organization: z.string(),
});

export const ExistingCopilotGithubAppValidationSchema = z.object({
  /** GitHub's own fingerprint format, as on the App settings page. */
  fingerprint: z.string(),
  installationId: z.string(),
  organization: z.string(),
});

export const ConnectExistingCopilotGithubAppSchema =
  ExistingAppFieldsSchema.extend({
    grants: GrantsSchema,
    name: KeyNameSchema,
  });

export const CopilotGithubAppKeySummarySchema = z.object({
  /** The GitHub organization the App is installed on, and billed to. */
  organization: z.string().nullable(),
  appId: z.string(),
  appName: z.string().nullable(),
  /** The App's icon in the credential store, when it has one. */
  appIcon: z.string().nullable(),
  /** The App's page on GitHub, when GitHub could be reached. */
  appUrl: z.string().nullable(),
  /** The web address of the GitHub the organization is on. */
  githubUrl: z.string(),
  /** The private key's fingerprint, as GitHub shows it on the App page. */
  fingerprint: z.string(),
});

export const ConnectCopilotGithubAppCredentialResultSchema =
  z.discriminatedUnion("status", [
    CopilotGithubAppConnectedSchema,
    CopilotGithubAppNeedsPermissionSchema,
  ]);
