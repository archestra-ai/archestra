"use client";

import {
  type archestraApiTypes,
  CONNECTOR_TYPE_LABELS,
  DocsPage,
} from "@archestra/shared";
import type { ReactNode } from "react";
import type { UseFormReturn } from "react-hook-form";
import { ExternalDocsLink } from "@/components/external-docs-link";
import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { getFrontendDocsUrl } from "@/lib/docs/docs";
import { AsanaConfigFields } from "./asana-config-fields";
import { ConfluenceConfigFields } from "./confluence-config-fields";
import { DropboxConfigFields } from "./dropbox-config-fields";
import {
  DEFAULT_GDRIVE_AUTH_MODE,
  GoogleDriveAuthFields,
  GoogleDriveConfigFields,
} from "./gdrive-config-fields";
import { GithubConfigFields } from "./github-config-fields";
import { GitlabConfigFields } from "./gitlab-config-fields";
import { JiraConfigFields } from "./jira-config-fields";
import { LinearConfigFields } from "./linear-config-fields";
import { MFilesConfigFields, MFilesInlineFields } from "./mfiles-config-fields";
import { NotionConfigFields } from "./notion-config-fields";
import { OneDriveConfigFields } from "./onedrive-config-fields";
import { OutlineConfigFields } from "./outline-config-fields";
import { PerforceConfigFields } from "./perforce-config-fields";
import { SalesforceConfigFields } from "./salesforce-config-fields";
import { ServiceNowConfigFields } from "./servicenow-config-fields";
import { SharePointConfigFields } from "./sharepoint-config-fields";
import { joinIfArray } from "./transform-config-array-fields";
import { WebCrawlerConfigFields } from "./web-crawler-config-fields";

export type ConnectorType =
  archestraApiTypes.CreateConnectorData["body"]["connectorType"];

export type ConnectorUrlConfig = {
  fieldName: string;
  label: string;
  placeholder: string;
  description: string;
};

export type ConnectorCredentialConfig = {
  apiTokenLabel?: string;
  apiTokenPlaceholder?: string;
  apiTokenRequiredMessage?: string;
  /**
   * Inline content, not a block: the dialogs render it inside the credential
   * field's single description, alongside the edit-mode note and the auto-sync
   * requirement, so the field never stacks two lookalike paragraphs.
   */
  apiTokenHelpText?: ReactNode;
  apiTokenMultiline?: boolean;
};

type ConnectorOption = {
  type: ConnectorType;
  label: string;
  description: string;
};

// biome-ignore lint/suspicious/noExplicitAny: connector config field components accept generic react-hook-form instances
type ConnectorForm = UseFormReturn<any>;

type AdvancedConfigFieldsProps = {
  form: ConnectorForm;
};

const CONNECTOR_DISPLAY_LABELS: Record<ConnectorType, string> = {
  jira: CONNECTOR_TYPE_LABELS.jira,
  confluence: CONNECTOR_TYPE_LABELS.confluence,
  github: CONNECTOR_TYPE_LABELS.github,
  gitlab: CONNECTOR_TYPE_LABELS.gitlab,
  linear: CONNECTOR_TYPE_LABELS.linear,
  servicenow: "ServiceNow",
  notion: CONNECTOR_TYPE_LABELS.notion,
  sharepoint: CONNECTOR_TYPE_LABELS.sharepoint,
  gdrive: CONNECTOR_TYPE_LABELS.gdrive,
  dropbox: "Dropbox",
  asana: CONNECTOR_TYPE_LABELS.asana,
  outline: CONNECTOR_TYPE_LABELS.outline,
  onedrive: CONNECTOR_TYPE_LABELS.onedrive ?? "OneDrive",
  salesforce: CONNECTOR_TYPE_LABELS.salesforce ?? "Salesforce",
  web_crawler: CONNECTOR_TYPE_LABELS.web_crawler,
  perforce: CONNECTOR_TYPE_LABELS.perforce,
  mfiles: CONNECTOR_TYPE_LABELS.mfiles,
};

const CONNECTOR_DOC_ANCHORS: Partial<Record<ConnectorType, string>> = {
  gdrive: "google-drive",
  web_crawler: "web-crawler",
  perforce: "perforce-helix-core",
  mfiles: "m-files",
};

export const CONNECTOR_OPTIONS: ConnectorOption[] = [
  {
    type: "jira",
    label: CONNECTOR_DISPLAY_LABELS.jira,
    description: "Sync issues and projects from Jira",
  },
  {
    type: "confluence",
    label: CONNECTOR_DISPLAY_LABELS.confluence,
    description: "Sync pages and spaces from Confluence",
  },
  {
    type: "github",
    label: CONNECTOR_DISPLAY_LABELS.github,
    description: "Sync issues and pull requests from GitHub",
  },
  {
    type: "gitlab",
    label: CONNECTOR_DISPLAY_LABELS.gitlab,
    description: "Sync issues and merge requests from GitLab",
  },
  {
    type: "linear",
    label: CONNECTOR_DISPLAY_LABELS.linear,
    description: "Sync issues, projects, and cycles from Linear",
  },
  {
    type: "servicenow",
    label: CONNECTOR_DISPLAY_LABELS.servicenow,
    description: "Sync incidents from ServiceNow",
  },
  {
    type: "notion",
    label: CONNECTOR_DISPLAY_LABELS.notion,
    description: "Sync pages and databases from Notion",
  },
  {
    type: "sharepoint",
    label: CONNECTOR_DISPLAY_LABELS.sharepoint,
    description: "Sync documents and pages from SharePoint",
  },
  {
    type: "gdrive",
    label: CONNECTOR_DISPLAY_LABELS.gdrive,
    description: "Sync files and documents from Google Drive",
  },
  {
    type: "dropbox",
    label: CONNECTOR_DISPLAY_LABELS.dropbox,
    description: "Sync files and folders from Dropbox",
  },
  {
    type: "asana",
    label: CONNECTOR_DISPLAY_LABELS.asana,
    description: "Sync tasks and comments from Asana",
  },
  {
    type: "outline",
    label: CONNECTOR_DISPLAY_LABELS.outline,
    description: "Sync documents from Outline",
  },
  {
    type: "onedrive",
    label: CONNECTOR_DISPLAY_LABELS.onedrive,
    description: "Sync files and documents from OneDrive for Business",
  },
  {
    type: "salesforce",
    label: CONNECTOR_DISPLAY_LABELS.salesforce,
    description: "Sync CRM objects from Salesforce",
  },
  {
    type: "web_crawler",
    label: CONNECTOR_DISPLAY_LABELS.web_crawler,
    description: "Crawl and sync static HTML pages",
  },
  {
    type: "perforce",
    label: CONNECTOR_DISPLAY_LABELS.perforce,
    description: "Sync text files from Perforce Helix Core depots",
  },
  {
    type: "mfiles",
    label: CONNECTOR_DISPLAY_LABELS.mfiles,
    description: "Sync documents and permissions from an M-Files vault",
  },
];

const CONNECTOR_URL_CONFIGS: Record<ConnectorType, ConnectorUrlConfig | null> =
  {
    jira: {
      fieldName: "config.jiraBaseUrl",
      label: "URL",
      placeholder: "https://your-domain.atlassian.net",
      description: "Your Jira instance URL.",
    },
    confluence: {
      fieldName: "config.confluenceUrl",
      label: "URL",
      placeholder: "https://your-domain.atlassian.net/wiki",
      description: "Your Confluence instance URL.",
    },
    github: {
      fieldName: "config.githubUrl",
      label: "GitHub API URL",
      placeholder: "https://api.github.com",
      description:
        "Use https://api.github.com for GitHub.com, or your GitHub Enterprise API URL.",
    },
    gitlab: {
      fieldName: "config.gitlabUrl",
      label: "GitLab URL",
      placeholder: "https://gitlab.com",
      description: "Use https://gitlab.com or your self-hosted GitLab URL.",
    },
    linear: {
      fieldName: "config.linearApiUrl",
      label: "Linear API URL",
      placeholder: "https://api.linear.app",
      description: "Linear GraphQL API base URL.",
    },
    servicenow: {
      fieldName: "config.instanceUrl",
      label: "Instance URL",
      placeholder: "https://your-instance.service-now.com",
      description: "Your ServiceNow instance URL.",
    },
    notion: null,
    sharepoint: {
      fieldName: "config.siteUrl",
      label: "Site URL",
      placeholder: "https://your-tenant.sharepoint.com/sites/your-site",
      description: "Your SharePoint site URL.",
    },
    gdrive: null,
    dropbox: null,
    asana: null,
    onedrive: null,
    outline: {
      fieldName: "config.outlineUrl",
      label: "Instance URL",
      placeholder: "https://app.getoutline.com",
      description:
        "Your Outline instance URL. Use https://app.getoutline.com for the cloud version, or your self-hosted URL.",
    },
    salesforce: {
      fieldName: "config.loginUrl",
      label: "Login URL",
      placeholder: "https://login.salesforce.com",
      description:
        "Use https://login.salesforce.com for production and https://test.salesforce.com for sandbox.",
    },
    web_crawler: {
      fieldName: "config.startUrl",
      label: "Start URL",
      placeholder: "https://docs.example.com/",
      description: "First page to crawl. Crawling stays on the same host.",
    },
    perforce: {
      fieldName: "config.serverUrl",
      label: "Server URL",
      placeholder: "https://perforce.example.com:8080",
      description:
        "Base URL of the P4 REST API, served by the built-in P4 web server (p4 webserver). Use https when the server has an SSL certificate configured.",
    },
    // Rendered inside MFilesInlineFields: the VAF Add On install precedes
    // everything in the connection workflow, so its section must sit above
    // the URL field — outside the shared slot's reach.
    mfiles: null,
  };

const CREATE_ADVANCED_CONFIG_FIELDS: Record<
  ConnectorType,
  (props: AdvancedConfigFieldsProps) => ReactNode
> = {
  jira: ({ form }) => <JiraConfigFields form={form} hideUrl hideIsCloud />,
  confluence: ({ form }) => (
    <ConfluenceConfigFields form={form} hideUrl hideIsCloud />
  ),
  github: ({ form }) => (
    <GithubConfigFields form={form} hideUrl hideOwner hideAuth />
  ),
  gitlab: ({ form }) => <GitlabConfigFields form={form} hideUrl />,
  linear: ({ form }) => <LinearConfigFields form={form} />,
  servicenow: ({ form }) => <ServiceNowConfigFields form={form} hideUrl />,
  notion: ({ form }) => <NotionConfigFields form={form} />,
  sharepoint: ({ form }) => <SharePointConfigFields form={form} />,
  gdrive: ({ form }) => <GoogleDriveConfigFields form={form} />,
  dropbox: ({ form }) => <DropboxConfigFields control={form.control} />,
  asana: ({ form }) => <AsanaConfigFields form={form} hideWorkspaceGid />,
  onedrive: ({ form }) => <OneDriveConfigFields form={form} />,
  outline: ({ form }) => <OutlineConfigFields form={form} />,
  salesforce: ({ form }) => <SalesforceConfigFields form={form} />,
  web_crawler: ({ form }) => <WebCrawlerConfigFields form={form} />,
  perforce: ({ form }) => <PerforceConfigFields form={form} />,
  mfiles: ({ form }) => <MFilesConfigFields form={form} />,
};

const EDIT_ADVANCED_CONFIG_FIELDS: Record<
  ConnectorType,
  (props: AdvancedConfigFieldsProps) => ReactNode
> = {
  ...CREATE_ADVANCED_CONFIG_FIELDS,
  github: ({ form }) => (
    <GithubConfigFields form={form} hideUrl hideOwner hideAuth />
  ),
  asana: ({ form }) => <AsanaConfigFields form={form} />,
};

export function ConnectorAdvancedConfigFields({
  connectorType,
  form,
  mode,
}: {
  connectorType: ConnectorType;
  form: ConnectorForm;
  mode: "create" | "edit";
}) {
  const renderFields =
    mode === "create"
      ? CREATE_ADVANCED_CONFIG_FIELDS[connectorType]
      : EDIT_ADVANCED_CONFIG_FIELDS[connectorType];

  return <>{renderFields({ form })}</>;
}

export function getConnectorTypeLabel(type: ConnectorType): string {
  return CONNECTOR_DISPLAY_LABELS[type];
}

// SPDX-SnippetBegin
// SPDX-SnippetCopyrightText: 2026 Archestra Inc.
// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
type AutoSyncConnectorRequirement = {
  /** Anchor of this connector's "… Auto-Sync Permissions" docs section. */
  docsAnchor: string;
  /**
   * One sentence naming the *kind* of upstream grant this connector's
   * credential is missing when audiences come back empty — enough to tell an
   * admin whether they can fix it and where to look, not enough to replace
   * the docs. The exact roles, scopes, and tables belong there: they are long,
   * they change with the source system, and a form is a bad place to keep
   * either.
   *
   * Where the source has a stable page for making that credential — the one
   * the docs section itself cites — the phrase naming it links straight there,
   * so the admin lands on the console instead of hunting for it. Sources whose
   * console lives on the customer's own instance get no link rather than a
   * guessed one.
   */
  requirement: ReactNode;
};

function UpstreamConsoleLink({
  href,
  children,
}: {
  href: string;
  children: ReactNode;
}) {
  return (
    <ExternalDocsLink href={href} className="underline" showIcon={false}>
      {children}
    </ExternalDocsLink>
  );
}

const ATLASSIAN_API_TOKENS_URL =
  "https://id.atlassian.com/manage-profile/security/api-tokens";

/**
 * Connector types whose backend implementation supports auto-sync-permissions
 * (`supportsPermissionSync`). Keep in sync with the connectors that set
 * `supportsPermissionSync = true`; the backend re-validates on create/update
 * (400 otherwise), so this only gates the UI. Deriving the allowlist from
 * these keys keeps a connector from offering auto-sync permissions without
 * saying what its credential needs first.
 */
const AUTO_SYNC_CONNECTOR_REQUIREMENTS = {
  jira: {
    docsAnchor: "jira-auto-sync-permissions",
    requirement:
      "Auto-sync permissions needs a Jira Cloud admin account that can browse every synced project.",
  },
  confluence: {
    docsAnchor: "confluence-auto-sync-permissions",
    requirement:
      "Auto-sync permissions needs an account that can view every synced space and its page restrictions.",
  },
  github: {
    docsAnchor: "github-auto-sync-permissions",
    requirement:
      "Auto-sync permissions needs extra repository and organization read permissions on this credential.",
  },
  gitlab: {
    docsAnchor: "gitlab-auto-sync-permissions",
    requirement:
      "Auto-sync permissions needs a read_api token with Reporter access on every private project.",
  },
  linear: {
    docsAnchor: "linear-auto-sync-permissions",
    requirement:
      "Auto-sync permissions needs a read key from a member of every private team.",
  },
  servicenow: {
    docsAnchor: "servicenow-auto-sync-permissions",
    requirement:
      "Auto-sync permissions needs extra roles, plus read ACLs on the user-criteria tables.",
  },
  notion: {
    docsAnchor: "notion-auto-sync-permissions",
    // No console link here: this field's help text already links the Notion
    // Developer portal, and one description should not offer the same
    // destination twice.
    requirement:
      "Auto-sync permissions needs the integration's capability to read user email addresses.",
  },
  sharepoint: {
    docsAnchor: "sharepoint-auto-sync-permissions",
    requirement:
      "Auto-sync permissions needs extra admin-consented Microsoft Graph application permissions.",
  },
  gdrive: {
    docsAnchor: "google-drive-auto-sync-permissions",
    requirement: (
      <>
        Auto-sync permissions needs Workspace domain mode, with directory read
        scopes authorized in the{" "}
        <UpstreamConsoleLink href="https://admin.google.com/">
          Admin console
        </UpstreamConsoleLink>
        {"."}
      </>
    ),
  },
  dropbox: {
    docsAnchor: "dropbox-auto-sync-permissions",
    requirement:
      "Auto-sync permissions needs sharing scopes on the app, plus team scopes to expand groups.",
  },
  asana: {
    docsAnchor: "asana-auto-sync-permissions",
    requirement:
      "Auto-sync permissions needs a token from a user with access to every synced private project and team.",
  },
  outline: {
    docsAnchor: "outline-auto-sync-permissions",
    requirement:
      "Auto-sync permissions needs a key scoped to users, groups, collections and shares.",
  },
  onedrive: {
    docsAnchor: "onedrive-auto-sync-permissions",
    requirement:
      "Auto-sync permissions needs extra admin-consented Microsoft Graph application permissions.",
  },
  salesforce: {
    docsAnchor: "salesforce-auto-sync-permissions",
    requirement:
      "Auto-sync permissions needs view-all and share-table read permissions on this user.",
  },
  perforce: {
    docsAnchor: "perforce-auto-sync-permissions",
    requirement:
      "Auto-sync permissions needs an account that can read the full protections table.",
  },
  mfiles: {
    docsAnchor: "m-files-auto-sync-permissions",
    requirement:
      "Auto-sync permissions needs a vault account with full control of the vault.",
  },
} satisfies Partial<Record<ConnectorType, AutoSyncConnectorRequirement>>;

const AUTO_SYNC_CONNECTOR_TYPES: ReadonlySet<ConnectorType> = new Set(
  Object.keys(AUTO_SYNC_CONNECTOR_REQUIREMENTS) as ConnectorType[],
);

export function connectorSupportsAutoSync(
  type: ConnectorType,
  /**
   * Value of the `orchestratorK8sRuntime` feature
   * (`useFeature("orchestratorK8sRuntime")` in the calling component).
   * Perforce permission sync runs the p4 client from an in-cluster pod, so
   * its backend only sets `supportsPermissionSync` when the Kubernetes
   * orchestrator is configured; without it Perforce must behave exactly like
   * a non-perm-sync connector.
   */
  orchestratorK8sRuntime: boolean,
): boolean {
  if (type === "perforce" && !orchestratorK8sRuntime) return false;
  return AUTO_SYNC_CONNECTOR_TYPES.has(type);
}

/**
 * Atlassian Cloud connectors take an optional organization admin API key
 * alongside the product API token: the admin APIs (managed-account email
 * resolution) reject user API tokens, and the product APIs reject org-admin
 * API keys, so one value cannot serve both.
 */
export function connectorSupportsAdminApiKey(type: ConnectorType): boolean {
  return type === "jira" || type === "confluence";
}

/**
 * Description of the admin API key field, shared by the create and edit
 * dialogs (each appends its own trailing sentence). Says why the key exists —
 * the email join permission sync needs — and links to the docs for the
 * how-to (creating a scopeless key in Atlassian administration).
 */
export function AdminApiKeyDescription({ type }: { type: ConnectorType }) {
  return (
    <span>
      Create it in{" "}
      <UpstreamConsoleLink href="https://admin.atlassian.com">
        Atlassian administration
      </UpstreamConsoleLink>
      {"."} Auto-sync permissions needs it to read the email of any{" "}
      {getConnectorTypeLabel(type)} user whose profile hides it.{" "}
      <ExternalDocsLink
        href={getFrontendDocsUrl(
          DocsPage.PlatformKnowledge,
          ATLASSIAN_ADMIN_API_KEY_DOC_ANCHOR,
        )}
        className="underline"
        showIcon={false}
      >
        Learn more
      </ExternalDocsLink>
    </span>
  );
}

const ATLASSIAN_ADMIN_API_KEY_DOC_ANCHOR =
  "atlassian-organization-admin-api-key";

/**
 * Points at the setup this connector's credential needs upstream, shown under
 * the credential field only while Auto-sync permissions is the selected
 * visibility. That visibility mirrors the source's own access control, which a
 * credential can authenticate against — and pass Test connection — while still
 * being unable to read, leaving an empty fail-closed snapshot. The roles,
 * scopes, and modes themselves are the docs' job: a form is the wrong place to
 * restate them, and they change with the source, not with us.
 */
export function AutoSyncCredentialRequirement({
  type,
}: {
  type: ConnectorType;
}) {
  const entry = getAutoSyncConnectorRequirement(type);
  if (!entry) return null;
  // A span, not a fragment: this sits beside other conditional description
  // slots, and React must move elements rather than bare text nodes there.
  return (
    <span>
      {entry.requirement}{" "}
      <ExternalDocsLink
        href={getFrontendDocsUrl(DocsPage.PlatformKnowledge, entry.docsAnchor)}
        className="underline"
        showIcon={false}
      >
        Learn more
      </ExternalDocsLink>
    </span>
  );
}

/**
 * Which field on the form the requirement belongs under — the one an admin
 * would change to fix it.
 *
 * - `credential` — the dialog's shared credential input, the usual case.
 * - `connector-fields` — the connector's own fields, when the chosen
 *   authentication mode pastes no credential here at all: a GitHub App's
 *   credentials live in Settings → GitHub, and an individually authorized
 *   Google account is granted through Google.
 * - `permission-sync-fields` — Perforce, whose shared field holds the
 *   *content* identity's login ticket while permission sync signs in as the
 *   separate admin account in its own section.
 */
export function autoSyncRequirementSlot({
  type,
  authMethod,
  authMode,
}: {
  type: ConnectorType;
  authMethod?: string;
  authMode?: string;
}): "credential" | "connector-fields" | "permission-sync-fields" {
  if (type === "perforce") return "permission-sync-fields";
  if (type === "github" && authMethod === "github_app")
    return "connector-fields";
  if (type === "gdrive" && authMode === "oauth") return "connector-fields";
  return "credential";
}

/**
 * Rendered under the visibility selector on the Notion create/edit forms when
 * Auto-sync permissions is selected. Notion's public API cannot report who
 * can see an individual page, so support is deliberately coarse ("Limited"
 * in the docs): no credential fixes this, so it is an audience model the admin
 * has to scope the integration's content access around. What the integration
 * itself needs is on the Integration Token field.
 */
export function NotionAutoSyncPermissionsNote() {
  return (
    <p className="text-sm text-muted-foreground">
      Notion&apos;s API cannot report who can see each page, so auto-sync makes
      every synced page visible to all workspace members matched by email, and
      never to guests. Share only workspace-appropriate teamspaces and pages
      with the integration.
    </p>
  );
}

/**
 * A settings page on the connector's own instance, or null when the form has
 * no usable URL yet — a half-typed host must not become a broken link.
 */
function workspaceSettingsUrl(
  instanceUrl: string | undefined,
  path: string,
): string | null {
  if (!instanceUrl) return null;
  try {
    const { origin, protocol } = new URL(instanceUrl);
    if (protocol !== "https:" && protocol !== "http:") return null;
    return `${origin}${path}`;
  } catch {
    return null;
  }
}

function getAutoSyncConnectorRequirement(
  type: ConnectorType,
): AutoSyncConnectorRequirement | undefined {
  return (
    AUTO_SYNC_CONNECTOR_REQUIREMENTS as Partial<
      Record<ConnectorType, AutoSyncConnectorRequirement>
    >
  )[type];
}
// SPDX-SnippetEnd

export function getConnectorUrlConfig(
  type: ConnectorType,
): ConnectorUrlConfig | null {
  return CONNECTOR_URL_CONFIGS[type];
}

export function getConnectorDocsUrl(type: ConnectorType): string | null {
  return getFrontendDocsUrl(
    DocsPage.PlatformKnowledge,
    CONNECTOR_DOC_ANCHORS[type] ?? type,
  );
}

export function getDefaultConnectorConfig(
  type: ConnectorType,
): Record<string, unknown> {
  const defaultConfigs: Record<ConnectorType, Record<string, unknown>> = {
    jira: { type, isCloud: true },
    confluence: { type, isCloud: true },
    github: { type, githubUrl: "https://api.github.com", authMethod: "pat" },
    gitlab: { type, gitlabUrl: "https://gitlab.com" },
    linear: {
      type,
      linearApiUrl: "https://api.linear.app",
      includeComments: true,
      includeProjects: false,
      includeCycles: false,
    },
    servicenow: { type, syncDataForLastMonths: 6 },
    notion: { type },
    sharepoint: { type, includePages: true, recursive: true },
    gdrive: { type, recursive: true, authMode: DEFAULT_GDRIVE_AUTH_MODE },
    dropbox: { type, rootPath: "" },
    asana: { type },
    onedrive: { type, userIds: "", recursive: true },
    outline: { type, outlineUrl: "https://app.getoutline.com" },
    salesforce: { type, loginUrl: "https://login.salesforce.com" },
    web_crawler: {
      type,
      maxPages: 250,
      maxDepth: 3,
      batchSize: 25,
      allowPrivateNetwork: false,
    },
    perforce: { type },
    // Tuning knobs (batch size, object types, client auth method, extension
    // method) are deliberately not seeded: leaving them absent lets the
    // backend defaults govern instead of pinning today's values into every
    // stored config.
    // authMethod is deliberately absent: Login Account is the default. The
    // two oauth fields are presets for admins who switch the method to
    // Application Account (where the gate allows it).
    mfiles: {
      type,
      oauthAuthConfig: "Technical Credentials",
      oauthAuthConfigScope: "technical",
    },
  };

  return { ...defaultConfigs[type] };
}

export function connectorNeedsEmail(type: ConnectorType): boolean {
  return (
    type === "jira" ||
    type === "confluence" ||
    type === "salesforce" ||
    type === "mfiles"
  );
}

export function getConnectorCredentialConfig(params: {
  type: ConnectorType;
  emailRequired: boolean;
  mode: "create" | "edit";
  authMethod?: string;
  /** Google Drive's auth mode; decides whether a credential is pasted at all. */
  authMode?: string;
  /** Whether this field's description also carries the auto-sync pointer. */
  autoSyncRequirementShown?: boolean;
  /**
   * The connector's own instance URL, for sources whose credential is minted
   * inside the customer's workspace rather than on a vendor-wide console.
   */
  instanceUrl?: string;
}): ConnectorCredentialConfig {
  // In individual mode the credential arrives from Google, so there is nothing
  // to type — the field is dropped the same way web_crawler drops it.
  const gdriveUsesOAuth =
    params.type === "gdrive" && params.authMode === "oauth";
  const jiraConfluenceApiTokenLabel = params.emailRequired
    ? "API Token"
    : "API Token / Personal Access Token";
  const jiraConfluenceApiTokenPlaceholder = params.emailRequired
    ? "Your API token"
    : "Your API token or personal access token";
  const jiraConfluenceApiTokenRequiredMessage = params.emailRequired
    ? "API token is required"
    : "API token or personal access token is required";

  const githubUsesApp =
    params.type === "github" && params.authMethod === "github_app";
  // Absent authMethod means the legacy password-token mode, matching the
  // backend default.
  const mfilesUsesOAuth =
    params.type === "mfiles" &&
    (params.authMethod ?? "mfiles_password_token") ===
      "oauth_client_credentials";
  const apiTokenLabels: Record<ConnectorType, string | undefined> = {
    servicenow: "Password",
    notion: "Integration Token",
    sharepoint: "Client Secret",
    gdrive: gdriveUsesOAuth ? undefined : "Service Account JSON Key",
    dropbox: "Access Token",
    outline: "API Key",
    jira: jiraConfluenceApiTokenLabel,
    confluence: jiraConfluenceApiTokenLabel,
    // App auth stores credentials in a github_app_configs row, so there is no
    // inline token field — the config is chosen via the dropdown instead
    github: githubUsesApp ? undefined : "Personal Access Token",
    gitlab: "Personal Access Token",
    linear: "Personal Access Token",
    asana: "Personal Access Token",
    onedrive: "Client Secret",
    salesforce: "Password + Security Token",
    web_crawler: undefined,
    perforce: "Login Ticket",
    mfiles: mfilesUsesOAuth ? "Client Secret" : "Password",
  };

  const createApiTokenPlaceholders: Record<ConnectorType, string | undefined> =
    {
      servicenow: "Your ServiceNow password",
      notion: "ntn_...",
      sharepoint: "Your Azure AD client secret",
      gdrive: gdriveUsesOAuth
        ? undefined
        : "Paste the whole service account key file",
      dropbox: "Your Dropbox access token",
      outline: "Your Outline API key (starts with ol_api_)",
      jira: jiraConfluenceApiTokenPlaceholder,
      confluence: jiraConfluenceApiTokenPlaceholder,
      github: githubUsesApp
        ? "Paste the GitHub App private key PEM"
        : "Your personal access token",
      gitlab: "Your personal access token",
      linear: "Your personal access token",
      asana: "Your personal access token",
      onedrive: "Your Azure AD client secret",
      salesforce: "Your Salesforce password followed by your security token",
      web_crawler: undefined,
      perforce: "Ticket from p4 login -a -p",
      mfiles: mfilesUsesOAuth
        ? "Your Application Account client secret"
        : "Your M-Files service account password",
    };

  const editApiTokenPlaceholders: Record<ConnectorType, string | undefined> = {
    servicenow: "Leave empty to keep existing password",
    salesforce: "Leave empty to keep existing password + security token",
    notion: "Leave empty to keep existing token",
    sharepoint: "Leave empty to keep existing token",
    gdrive: gdriveUsesOAuth
      ? undefined
      : "Leave empty to keep the existing service account key",
    dropbox: "Leave empty to keep existing token",
    outline: "Leave empty to keep existing token",
    jira: "Leave empty to keep existing token",
    confluence: "Leave empty to keep existing token",
    github: githubUsesApp
      ? "Leave empty to keep existing private key"
      : "Leave empty to keep existing token",
    gitlab: "Leave empty to keep existing token",
    linear: "Leave empty to keep existing token",
    asana: "Leave empty to keep existing token",
    onedrive: "Leave empty to keep existing token",
    web_crawler: undefined,
    perforce: "Leave empty to keep existing credentials",
    mfiles: mfilesUsesOAuth
      ? "Leave empty to keep existing client secret"
      : "Leave empty to keep existing password",
  };

  const apiTokenRequiredMessages: Record<ConnectorType, string | undefined> = {
    servicenow: "Password is required",
    notion: "Integration token is required",
    sharepoint: "Client secret is required",
    gdrive: gdriveUsesOAuth
      ? undefined
      : "A service account JSON key is required",
    dropbox: "Access token is required",
    outline: "API key is required",
    jira: jiraConfluenceApiTokenRequiredMessage,
    confluence: jiraConfluenceApiTokenRequiredMessage,
    github: githubUsesApp
      ? "GitHub App private key is required"
      : "Personal access token is required",
    gitlab: "Personal access token is required",
    linear: "Personal access token is required",
    asana: "Personal access token is required",
    onedrive: "Client secret is required",
    salesforce: "Password and security token are required",
    web_crawler: undefined,
    perforce: "Login ticket is required",
    mfiles: mfilesUsesOAuth
      ? "Client secret is required"
      : "Password is required",
  };

  const apiTokenHelpText = getApiTokenHelpText({
    type: params.type,
    mode: params.mode,
    authMethod: params.authMethod,
    authMode: params.authMode,
    emailRequired: params.emailRequired,
    autoSyncRequirementShown: params.autoSyncRequirementShown ?? false,
    instanceUrl: params.instanceUrl,
  });

  return {
    apiTokenLabel: apiTokenLabels[params.type],
    apiTokenPlaceholder:
      params.mode === "create"
        ? createApiTokenPlaceholders[params.type]
        : editApiTokenPlaceholders[params.type],
    apiTokenRequiredMessage: apiTokenRequiredMessages[params.type],
    apiTokenHelpText,
    apiTokenMultiline: githubUsesApp,
  };
}

function getApiTokenHelpText(params: {
  type: ConnectorType;
  mode: "create" | "edit";
  authMethod?: string;
  authMode?: string;
  /** Atlassian Cloud, where the token has an address we can link to. */
  emailRequired: boolean;
  instanceUrl?: string;
  /**
   * Whether the auto-sync requirement pointer shares this description. When it
   * does, sentences naming individual upstream grants stand down: the pointer
   * sends the reader to the docs for exactly that, and a paragraph that names
   * one permission and then defers the rest reads like two half-answers.
   */
  autoSyncRequirementShown: boolean;
}): ReactNode | undefined {
  const { autoSyncRequirementShown: pointerShown, mode, type } = params;

  if (type === "jira" || type === "confluence") {
    // Server and Data Center mint their token on the customer's own instance,
    // which has no address we can link to from here.
    if (!params.emailRequired) return undefined;
    return (
      <>
        Create one in{" "}
        <UpstreamConsoleLink href={ATLASSIAN_API_TOKENS_URL}>
          Atlassian account security
        </UpstreamConsoleLink>
        {"."}
      </>
    );
  }

  if (type === "github") {
    return (
      <>
        Fine-grained or classic — see{" "}
        <UpstreamConsoleLink href="https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens">
          managing your personal access tokens
        </UpstreamConsoleLink>
        {"."}
      </>
    );
  }

  if (type === "gitlab") {
    return (
      <>
        Create one under{" "}
        <UpstreamConsoleLink href="https://docs.gitlab.com/user/profile/personal_access_tokens/">
          Edit profile &rarr; Access tokens
        </UpstreamConsoleLink>
        {"."}
      </>
    );
  }

  if (type === "outline") {
    const settingsUrl = workspaceSettingsUrl(
      params.instanceUrl,
      "/settings/api-and-apps",
    );
    const where = settingsUrl ? (
      <UpstreamConsoleLink href={settingsUrl}>
        Settings &rarr; API &amp; Apps
      </UpstreamConsoleLink>
    ) : (
      <strong>Settings &rarr; API &amp; Apps</strong>
    );
    return (
      <>
        Create one under {where}
        {"."} Keys start with <code>ol_api_</code>.
      </>
    );
  }

  if (type === "linear") {
    return (
      <>
        Create one under{" "}
        <UpstreamConsoleLink href="https://linear.app/docs/api-and-webhooks">
          Settings &rarr; Security &amp; access
        </UpstreamConsoleLink>
        {"."}
      </>
    );
  }

  if (type === "asana") {
    return (
      <>
        Create one in the{" "}
        <UpstreamConsoleLink href="https://app.asana.com/0/my-apps">
          Asana Developer Console
        </UpstreamConsoleLink>
        {"."}
      </>
    );
  }

  if (type === "sharepoint" || type === "onedrive") {
    const contentPermission =
      type === "sharepoint" ? "Sites.Read.All" : "Files.Read.All";
    return (
      <>
        Create the app registration and its secret in the{" "}
        <UpstreamConsoleLink href="https://entra.microsoft.com">
          Microsoft Entra admin center
        </UpstreamConsoleLink>
        {"."}{" "}
        {/* The pointer covers the fuller permission list for auto-sync. */}
        {pointerShown ? null : (
          <span>
            It requires the <code>{contentPermission}</code> permission on
            Microsoft Graph.
          </span>
        )}
      </>
    );
  }

  if (type === "gdrive") {
    // What the file must contain is about the value being pasted, so it holds
    // either way; what to grant the key upstream is the pointer's business.
    const grantNote = pointerShown
      ? null
      : params.authMode === "service_account_delegated"
        ? "Its client ID must be authorized for domain-wide delegation with the drive.readonly and admin.directory.user.readonly scopes."
        : "Grant it access by sharing each folder or shared drive with the key's own email address.";
    return (
      <>
        The entire key file, including its <code>private_key</code>, from the{" "}
        <UpstreamConsoleLink href="https://console.cloud.google.com/">
          Google Cloud console
        </UpstreamConsoleLink>
        {"."} {grantNote ? <span>{grantNote}</span> : null}
      </>
    );
  }

  if (type === "notion") {
    return (
      <>
        Your Notion internal integration secret (starts with <code>ntn_</code>,
        older <code>secret_</code> tokens keep working). Create one in the{" "}
        <UpstreamConsoleLink href="https://app.notion.com/developers/connections">
          Notion Developer portal
        </UpstreamConsoleLink>
        {"."}
      </>
    );
  }

  if (type === "dropbox") {
    return (
      <>
        Your Dropbox access token. Generate one in the{" "}
        <UpstreamConsoleLink href="https://www.dropbox.com/developers/apps">
          Dropbox App Console
        </UpstreamConsoleLink>
        {"."}
      </>
    );
  }

  if (type === "mfiles") {
    const usesOAuth =
      (params.authMethod ?? "mfiles_password_token") ===
      "oauth_client_credentials";
    if (usesOAuth) {
      return (
        <>
          The client secret of an{" "}
          <UpstreamConsoleLink href="https://userguide.m-files.com/user-guide/manage/latest/eng/application_accounts.html">
            M-Files Application Account
          </UpstreamConsoleLink>
          {"."}
        </>
      );
    }
    if (mode === "edit") return undefined;
    return (
      <>
        Exchanged for short-lived MFWS tokens; never sent with content requests.
      </>
    );
  }

  if (mode === "edit") return undefined;

  if (type === "perforce") {
    return (
      <>
        A login ticket valid for all hosts, generated with{" "}
        <code>p4 login -a -p</code>. For long-lived access, use a service
        account whose group has an unlimited ticket timeout.
      </>
    );
  }

  return undefined;
}

type InlineConfigFieldsProps = {
  form: ConnectorForm;
  emailRequired: boolean;
  mode: "create" | "edit";
  /**
   * The auto-sync requirement line, passed only to the connectors whose
   * credential is chosen here rather than in the dialog's shared credential
   * field (see `autoSyncRequirementSlot`).
   */
  autoSyncRequirement?: ReactNode;
};

const INLINE_CONFIG_FIELDS: Record<
  ConnectorType,
  (props: InlineConfigFieldsProps) => ReactNode
> = {
  jira: ({ form, emailRequired, mode }) => (
    <>
      <FormField
        control={form.control}
        name={"config.isCloud"}
        render={({ field }) => (
          <FormItem className="flex items-center justify-between rounded-lg border p-3">
            <div className="space-y-0.5">
              <FormLabel>Cloud Instance</FormLabel>
              <FormDescription>
                Enable if this is a cloud-hosted instance.
              </FormDescription>
            </div>
            <FormControl>
              <Switch
                checked={(field.value as boolean) ?? true}
                onCheckedChange={field.onChange}
              />
            </FormControl>
          </FormItem>
        )}
      />
      <FormField
        control={form.control}
        name="email"
        rules={
          mode === "create"
            ? {
                validate: (value) => {
                  const currentIsCloud = form.getValues("config.isCloud");
                  if (currentIsCloud !== false && !value)
                    return "Email is required";
                  return true;
                },
              }
            : undefined
        }
        render={({ field }) => (
          <FormItem>
            <FormLabel>
              Email{(mode === "edit" || !emailRequired) && " (optional)"}
            </FormLabel>
            {mode === "edit" && (
              <FormDescription>
                Leave empty to keep existing credentials unchanged.
              </FormDescription>
            )}
            {mode === "create" && !emailRequired && (
              <FormDescription>
                Leave empty to authenticate with a personal access token
                instead.
              </FormDescription>
            )}
            <FormControl>
              <Input
                type="email"
                placeholder={
                  emailRequired
                    ? "user@example.com"
                    : "Required for basic auth, leave empty for PAT"
                }
                autoComplete="off"
                data-1p-ignore
                data-lpignore="true"
                {...field}
              />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />
    </>
  ),
  confluence: ({ form, emailRequired, mode }) => (
    <>
      <FormField
        control={form.control}
        name={"config.isCloud"}
        render={({ field }) => (
          <FormItem className="flex items-center justify-between rounded-lg border p-3">
            <div className="space-y-0.5">
              <FormLabel>Cloud Instance</FormLabel>
              <FormDescription>
                Enable if this is a cloud-hosted instance.
              </FormDescription>
            </div>
            <FormControl>
              <Switch
                checked={(field.value as boolean) ?? true}
                onCheckedChange={field.onChange}
              />
            </FormControl>
          </FormItem>
        )}
      />
      <FormField
        control={form.control}
        name="email"
        rules={
          mode === "create"
            ? {
                validate: (value) => {
                  const currentIsCloud = form.getValues("config.isCloud");
                  if (currentIsCloud !== false && !value)
                    return "Email is required";
                  return true;
                },
              }
            : undefined
        }
        render={({ field }) => (
          <FormItem>
            <FormLabel>
              Email{(mode === "edit" || !emailRequired) && " (optional)"}
            </FormLabel>
            {mode === "edit" && (
              <FormDescription>
                Leave empty to keep existing credentials unchanged.
              </FormDescription>
            )}
            {mode === "create" && !emailRequired && (
              <FormDescription>
                Leave empty to authenticate with a personal access token
                instead.
              </FormDescription>
            )}
            <FormControl>
              <Input
                type="email"
                placeholder={
                  emailRequired
                    ? "user@example.com"
                    : "Required for basic auth, leave empty for PAT"
                }
                autoComplete="off"
                data-1p-ignore
                data-lpignore="true"
                {...field}
              />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />
    </>
  ),
  github: ({ form, autoSyncRequirement }) => (
    <GithubConfigFields
      form={form}
      hideUrl
      hideRepositoryOptions
      appConfigDescription={autoSyncRequirement}
    />
  ),
  gitlab: () => null,
  linear: () => null,
  servicenow: ({ form, mode }) => (
    <FormField
      control={form.control}
      name="email"
      rules={
        mode === "create" ? { required: "Username is required" } : undefined
      }
      render={({ field }) => (
        <FormItem>
          <FormLabel>Username</FormLabel>
          {mode === "create" && (
            <FormDescription>
              Your ServiceNow username for basic authentication.
            </FormDescription>
          )}
          {mode === "edit" && (
            <FormDescription>
              Leave empty to keep existing credentials unchanged.
            </FormDescription>
          )}
          <FormControl>
            <Input
              placeholder={
                mode === "create"
                  ? "admin"
                  : "Leave empty to keep existing credentials"
              }
              {...field}
            />
          </FormControl>
          <FormMessage />
        </FormItem>
      )}
    />
  ),
  notion: () => <></>,
  sharepoint: ({ form, mode }) => (
    <>
      <FormField
        control={form.control}
        name={"config.tenantId"}
        rules={
          mode === "create" ? { required: "Tenant ID is required" } : undefined
        }
        render={({ field }) => (
          <FormItem>
            <FormLabel>Tenant ID</FormLabel>
            <FormDescription>
              Your Azure AD (Entra ID) tenant ID or domain.
            </FormDescription>
            <FormControl>
              <Input
                placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                {...field}
                value={(field.value as string) ?? ""}
              />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />
      <FormField
        control={form.control}
        name="email"
        rules={
          mode === "create" ? { required: "Client ID is required" } : undefined
        }
        render={({ field }) => (
          <FormItem>
            <FormLabel>Client ID</FormLabel>
            <FormDescription>
              Azure AD app registration Client ID.
            </FormDescription>
            <FormControl>
              <Input
                placeholder={
                  mode === "create"
                    ? "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                    : "Leave empty to keep existing credentials"
                }
                {...field}
              />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />
    </>
  ),
  gdrive: ({ form, autoSyncRequirement }) => (
    <GoogleDriveAuthFields
      form={form}
      authModeDescription={autoSyncRequirement}
    />
  ),
  dropbox: () => <></>,
  asana: ({ form, mode }) =>
    mode === "create" ? (
      <FormField
        control={form.control}
        name={"config.workspaceGid"}
        rules={{ required: "Workspace GID is required" }}
        render={({ field }) => (
          <FormItem>
            <FormLabel>Workspace GID</FormLabel>
            <FormDescription>
              Your Asana workspace GID. Syncs top-level tasks only &mdash;
              subtasks aren&apos;t supported in the initial version.
            </FormDescription>
            <FormControl>
              <Input
                placeholder="1234567890"
                {...field}
                value={(field.value as string) ?? ""}
              />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />
    ) : null,
  onedrive: ({ form, mode }) => (
    <>
      <FormField
        control={form.control}
        name={"config.tenantId"}
        rules={
          mode === "create" ? { required: "Tenant ID is required" } : undefined
        }
        render={({ field }) => (
          <FormItem>
            <FormLabel>Tenant ID</FormLabel>
            <FormDescription>
              Your Azure AD (Entra ID) tenant ID or domain.
            </FormDescription>
            <FormControl>
              <Input
                placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                {...field}
                value={(field.value as string) ?? ""}
              />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />
      <FormField
        control={form.control}
        name="email"
        rules={
          mode === "create" ? { required: "Client ID is required" } : undefined
        }
        render={({ field }) => (
          <FormItem>
            <FormLabel>Client ID</FormLabel>
            <FormDescription>
              Azure AD app registration Client ID.
            </FormDescription>
            <FormControl>
              <Input
                placeholder={
                  mode === "create"
                    ? "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                    : "Leave empty to keep existing credentials"
                }
                {...field}
              />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />
      <FormField
        control={form.control}
        name={"config.userIds"}
        rules={
          mode === "create"
            ? { required: "At least one user ID is required" }
            : undefined
        }
        render={({ field }) => (
          <FormItem>
            <FormLabel>User IDs</FormLabel>
            <FormDescription>
              Comma-separated list of user principal names or object IDs whose
              OneDrive to sync.
            </FormDescription>
            <FormControl>
              <Input
                placeholder="user@example.com, user2@example.com"
                {...field}
                value={
                  Array.isArray(field.value)
                    ? (field.value as string[]).join(", ")
                    : ((field.value as string) ?? "")
                }
              />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />
    </>
  ),
  outline: () => <></>,
  web_crawler: ({ form }) => (
    <FormField
      control={form.control}
      name="config.allowPrivateNetwork"
      render={({ field }) => (
        <FormItem className="flex items-center justify-between rounded-lg border p-3">
          <div className="space-y-0.5">
            <FormLabel>Allow internal network addresses</FormLabel>
            <FormDescription>
              By default the crawler refuses hosts that resolve to private or
              internal addresses. Enable to crawl an internal site reachable
              from the workers.
            </FormDescription>
          </div>
          <FormControl>
            <Switch
              checked={(field.value as boolean) ?? false}
              onCheckedChange={field.onChange}
            />
          </FormControl>
        </FormItem>
      )}
    />
  ),
  salesforce: ({ form, mode }) => (
    <FormField
      control={form.control}
      name="email"
      rules={mode === "create" ? { required: "Email is required" } : undefined}
      render={({ field }) => (
        <FormItem>
          <FormLabel>Email{mode === "edit" && " (optional)"}</FormLabel>
          {mode === "edit" && (
            <FormDescription>
              Leave empty to keep existing credentials unchanged.
            </FormDescription>
          )}
          <FormControl>
            <Input
              type="email"
              placeholder={
                mode === "create"
                  ? "user@example.com"
                  : "Leave empty to keep existing credentials"
              }
              autoComplete="off"
              data-1p-ignore
              data-lpignore="true"
              {...field}
            />
          </FormControl>
          <FormMessage />
        </FormItem>
      )}
    />
  ),
  perforce: ({ form, mode }) => (
    <>
      <FormField
        control={form.control}
        name={"config.depotPaths"}
        rules={{ required: "At least one depot path is required" }}
        render={({ field }) => (
          <FormItem>
            <FormLabel>Depot Paths</FormLabel>
            <FormDescription>
              Comma-separated depot paths in depot syntax, e.g.{" "}
              <code>{"//depot/docs"}</code>. Each path is synced recursively.
            </FormDescription>
            <FormControl>
              <Input
                placeholder="//depot/docs, //stream/main/specs"
                {...field}
                value={joinIfArray(field.value)}
              />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />
      <FormField
        control={form.control}
        name="email"
        rules={
          mode === "create" ? { required: "Username is required" } : undefined
        }
        render={({ field }) => (
          <FormItem>
            <FormLabel>Username</FormLabel>
            {mode === "create" && (
              <FormDescription>
                The Perforce user (P4USER) the connector authenticates as.
              </FormDescription>
            )}
            {mode === "edit" && (
              <FormDescription>
                Leave empty to keep existing credentials unchanged.
              </FormDescription>
            )}
            <FormControl>
              <Input
                placeholder={
                  mode === "create"
                    ? "svc-knowledge"
                    : "Leave empty to keep existing credentials"
                }
                autoComplete="off"
                data-1p-ignore
                data-lpignore="true"
                {...field}
              />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />
    </>
  ),
  mfiles: ({ form, mode }) => <MFilesInlineFields form={form} mode={mode} />,
};

export function ConnectorInlineConfigFields({
  connectorType,
  form,
  mode,
  emailRequired,
  autoSyncRequirement,
}: {
  connectorType: ConnectorType;
  form: ConnectorForm;
  mode: "create" | "edit";
  emailRequired: boolean;
  autoSyncRequirement?: ReactNode;
}) {
  const renderFields = INLINE_CONFIG_FIELDS[connectorType];
  return (
    <>{renderFields({ form, emailRequired, mode, autoSyncRequirement })}</>
  );
}
