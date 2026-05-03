"use client";

import {
  type archestraApiTypes,
  CONNECTOR_TYPE_LABELS,
  DocsPage,
} from "@shared";
import type { ReactNode } from "react";
import type { UseFormReturn } from "react-hook-form";
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
import { GoogleDriveConfigFields } from "./gdrive-config-fields";
import { GithubConfigFields } from "./github-config-fields";
import { GitlabConfigFields } from "./gitlab-config-fields";
import { JiraConfigFields } from "./jira-config-fields";
import { LinearConfigFields } from "./linear-config-fields";
import { NotionConfigFields } from "./notion-config-fields";
import { OneDriveConfigFields } from "./onedrive-config-fields";
import { OutlineConfigFields } from "./outline-config-fields";
import { SalesforceConfigFields } from "./salesforce-config-fields";
import { ServiceNowConfigFields } from "./servicenow-config-fields";
import { SharePointConfigFields } from "./sharepoint-config-fields";

export type ConnectorType =
  archestraApiTypes.CreateConnectorData["body"]["connectorType"];

export type ConnectorUrlConfig = {
  fieldName: string;
  label: string;
  placeholder: string;
  description: string;
};

export type ConnectorCredentialConfig = {
  apiTokenLabel: string;
  apiTokenPlaceholder: string;
  apiTokenRequiredMessage: string;
  apiTokenHelpText?: ReactNode;
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
  };

const CREATE_ADVANCED_CONFIG_FIELDS: Record<
  ConnectorType,
  (props: AdvancedConfigFieldsProps) => ReactNode
> = {
  jira: ({ form }) => <JiraConfigFields form={form} hideUrl hideIsCloud />,
  confluence: ({ form }) => (
    <ConfluenceConfigFields form={form} hideUrl hideIsCloud />
  ),
  github: ({ form }) => <GithubConfigFields form={form} hideUrl hideOwner />,
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
};

const EDIT_ADVANCED_CONFIG_FIELDS: Record<
  ConnectorType,
  (props: AdvancedConfigFieldsProps) => ReactNode
> = {
  ...CREATE_ADVANCED_CONFIG_FIELDS,
  github: ({ form }) => <GithubConfigFields form={form} hideUrl />,
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

export function getConnectorUrlConfig(
  type: ConnectorType,
): ConnectorUrlConfig | null {
  return CONNECTOR_URL_CONFIGS[type];
}

export function getConnectorDocsUrl(type: ConnectorType): string | null {
  return getFrontendDocsUrl(DocsPage.PlatformKnowledgeConnectors, type);
}

export function getDefaultConnectorConfig(
  type: ConnectorType,
): Record<string, unknown> {
  const defaultConfigs: Record<ConnectorType, Record<string, unknown>> = {
    jira: { type, isCloud: true },
    confluence: { type, isCloud: true },
    github: { type, githubUrl: "https://api.github.com" },
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
    gdrive: { type, recursive: true },
    dropbox: { type, rootPath: "" },
    asana: { type },
    onedrive: { type, userIds: "", recursive: true },
    outline: { type, outlineUrl: "https://app.getoutline.com" },
    salesforce: { type, loginUrl: "https://login.salesforce.com" },
  };

  return { ...defaultConfigs[type] };
}

export function connectorNeedsEmail(type: ConnectorType): boolean {
  return type === "jira" || type === "confluence" || type === "salesforce";
}

export function getConnectorCredentialConfig(params: {
  type: ConnectorType;
  emailRequired: boolean;
  mode: "create" | "edit";
}): ConnectorCredentialConfig {
  const jiraConfluenceApiTokenLabel = params.emailRequired
    ? "API Token"
    : "API Token / Personal Access Token";
  const jiraConfluenceApiTokenPlaceholder = params.emailRequired
    ? "Your API token"
    : "Your API token or personal access token";
  const jiraConfluenceApiTokenRequiredMessage = params.emailRequired
    ? "API token is required"
    : "API token or personal access token is required";

  const apiTokenLabels: Record<ConnectorType, string> = {
    servicenow: "Password",
    notion: "Integration Token",
    sharepoint: "Client Secret",
    gdrive: "Service Account Key / OAuth Token",
    dropbox: "Access Token",
    outline: "API Key",
    jira: jiraConfluenceApiTokenLabel,
    confluence: jiraConfluenceApiTokenLabel,
    github: "Personal Access Token",
    gitlab: "Personal Access Token",
    linear: "Personal Access Token",
    asana: "Personal Access Token",
    onedrive: "Client Secret",
    salesforce: "Password + Security Token",
  };

  const createApiTokenPlaceholders: Record<ConnectorType, string> = {
    servicenow: "Your ServiceNow password",
    notion: "secret_...",
    sharepoint: "Your Azure AD client secret",
    gdrive: "Paste service account JSON key or OAuth access token",
    dropbox: "Your Dropbox access token",
    outline: "Your Outline API key (starts with ol_api_)",
    jira: jiraConfluenceApiTokenPlaceholder,
    confluence: jiraConfluenceApiTokenPlaceholder,
    github: "Your personal access token",
    gitlab: "Your personal access token",
    linear: "Your personal access token",
    asana: "Your personal access token",
    onedrive: "Your Azure AD client secret",
    salesforce: "Your Salesforce password followed by your security token",
  };

  const editApiTokenPlaceholders: Record<ConnectorType, string> = {
    servicenow: "Leave empty to keep existing password",
    salesforce: "Leave empty to keep existing password + security token",
    notion: "Leave empty to keep existing token",
    sharepoint: "Leave empty to keep existing token",
    gdrive: "Leave empty to keep existing token",
    dropbox: "Leave empty to keep existing token",
    outline: "Leave empty to keep existing token",
    jira: "Leave empty to keep existing token",
    confluence: "Leave empty to keep existing token",
    github: "Leave empty to keep existing token",
    gitlab: "Leave empty to keep existing token",
    linear: "Leave empty to keep existing token",
    asana: "Leave empty to keep existing token",
    onedrive: "Leave empty to keep existing token",
  };

  const apiTokenRequiredMessages: Record<ConnectorType, string> = {
    servicenow: "Password is required",
    notion: "Integration token is required",
    sharepoint: "Client secret is required",
    gdrive: "Service account key or OAuth token is required",
    dropbox: "Access token is required",
    outline: "API key is required",
    jira: jiraConfluenceApiTokenRequiredMessage,
    confluence: jiraConfluenceApiTokenRequiredMessage,
    github: "Personal access token is required",
    gitlab: "Personal access token is required",
    linear: "Personal access token is required",
    asana: "Personal access token is required",
    onedrive: "Client secret is required",
    salesforce: "Password and security token are required",
  };

  const apiTokenHelpText = getApiTokenHelpText({
    type: params.type,
    mode: params.mode,
  });

  return {
    apiTokenLabel: apiTokenLabels[params.type],
    apiTokenPlaceholder:
      params.mode === "create"
        ? createApiTokenPlaceholders[params.type]
        : editApiTokenPlaceholders[params.type],
    apiTokenRequiredMessage: apiTokenRequiredMessages[params.type],
    apiTokenHelpText,
  };
}

function getApiTokenHelpText(params: {
  type: ConnectorType;
  mode: "create" | "edit";
}): ReactNode | undefined {
  if (params.type === "sharepoint") {
    return (
      <p className="text-[0.8rem] text-muted-foreground">
        The Azure AD app registration requires the <code>Sites.Read.All</code>{" "}
        permission on Microsoft Graph.
      </p>
    );
  }

  if (params.type === "onedrive") {
    return (
      <p className="text-[0.8rem] text-muted-foreground">
        The Azure AD app registration requires the <code>Files.Read.All</code>{" "}
        permission on Microsoft Graph.
      </p>
    );
  }

  if (params.type === "gdrive") {
    return (
      <p className="text-[0.8rem] text-muted-foreground">
        Paste a service account JSON key (entire file content) or an OAuth2
        access token with <code>drive.readonly</code> scope.
      </p>
    );
  }

  if (params.mode === "edit") return undefined;

  if (params.type === "notion") {
    return (
      <p className="text-[0.8rem] text-muted-foreground">
        Your Notion integration token (starts with <code>secret_</code>). Create
        one at notion.so/my-integrations.
      </p>
    );
  }

  if (params.type === "dropbox") {
    return (
      <p className="text-[0.8rem] text-muted-foreground">
        Your Dropbox access token. Generate one in your Dropbox App Console.
      </p>
    );
  }

  if (params.type === "outline") {
    return (
      <p className="text-[0.8rem] text-muted-foreground">
        Your Outline API key. Create one under{" "}
        <strong>Settings &rarr; API &amp; Apps</strong>. Keys start with{" "}
        <code>ol_api_</code>.
      </p>
    );
  }

  return undefined;
}

type InlineConfigFieldsProps = {
  form: ConnectorForm;
  emailRequired: boolean;
  mode: "create" | "edit";
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
            <FormControl>
              <Input
                type="email"
                placeholder={
                  emailRequired
                    ? "user@example.com"
                    : "Required for basic auth, leave empty for PAT"
                }
                {...field}
              />
            </FormControl>
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
            <FormControl>
              <Input
                type="email"
                placeholder={
                  emailRequired
                    ? "user@example.com"
                    : "Required for basic auth, leave empty for PAT"
                }
                {...field}
              />
            </FormControl>
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
            <FormMessage />
          </FormItem>
        )}
      />
    </>
  ),
  github: ({ form, mode }) =>
    mode === "create" ? (
      <FormField
        control={form.control}
        name={"config.owner"}
        rules={{ required: "Owner is required" }}
        render={({ field }) => (
          <FormItem>
            <FormLabel>Owner</FormLabel>
            <FormControl>
              <Input
                placeholder="my-org"
                {...field}
                value={(field.value as string) ?? ""}
              />
            </FormControl>
            <FormDescription>GitHub organization or username.</FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />
    ) : null,
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
            <FormControl>
              <Input
                placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                {...field}
                value={(field.value as string) ?? ""}
              />
            </FormControl>
            <FormDescription>
              Your Azure AD (Entra ID) tenant ID or domain.
            </FormDescription>
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
            <FormDescription>
              Azure AD app registration Client ID.
            </FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />
    </>
  ),
  gdrive: () => <></>,
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
            <FormControl>
              <Input
                placeholder="1234567890"
                {...field}
                value={(field.value as string) ?? ""}
              />
            </FormControl>
            <FormDescription>
              Your Asana workspace GID. Syncs top-level tasks only &mdash;
              subtasks aren&apos;t supported in the initial version.
            </FormDescription>
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
            <FormControl>
              <Input
                placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                {...field}
                value={(field.value as string) ?? ""}
              />
            </FormControl>
            <FormDescription>
              Your Azure AD (Entra ID) tenant ID or domain.
            </FormDescription>
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
            <FormDescription>
              Azure AD app registration Client ID.
            </FormDescription>
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
            <FormDescription>
              Comma-separated list of user principal names or object IDs whose
              OneDrive to sync.
            </FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />
    </>
  ),
  outline: () => <></>,
  salesforce: ({ form, mode }) => (
    <FormField
      control={form.control}
      name="email"
      rules={mode === "create" ? { required: "Email is required" } : undefined}
      render={({ field }) => (
        <FormItem>
          <FormLabel>Email{mode === "edit" && " (optional)"}</FormLabel>
          <FormControl>
            <Input
              type="email"
              placeholder={
                mode === "create"
                  ? "user@example.com"
                  : "Leave empty to keep existing credentials"
              }
              {...field}
            />
          </FormControl>
          {mode === "edit" && (
            <FormDescription>
              Leave empty to keep existing credentials unchanged.
            </FormDescription>
          )}
          <FormMessage />
        </FormItem>
      )}
    />
  ),
};

export function ConnectorInlineConfigFields({
  connectorType,
  form,
  mode,
  emailRequired,
}: {
  connectorType: ConnectorType;
  form: ConnectorForm;
  mode: "create" | "edit";
  emailRequired: boolean;
}) {
  const renderFields = INLINE_CONFIG_FIELDS[connectorType];
  return <>{renderFields({ form, emailRequired, mode })}</>;
}
