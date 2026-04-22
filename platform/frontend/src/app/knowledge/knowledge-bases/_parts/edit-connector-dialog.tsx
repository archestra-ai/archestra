"use client";

import {
  type archestraApiTypes,
  DocsPage,
  getConnectorNamePlaceholder,
} from "@shared";
import { ChevronDown } from "lucide-react";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { KnowledgeSourceVisibilitySelector } from "@/app/knowledge/_parts/knowledge-source-visibility-selector";
import { ExternalDocsLink } from "@/components/external-docs-link";
import { StandardFormDialog } from "@/components/standard-dialog";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Form,
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
import { useUpdateConnector } from "@/lib/knowledge/connector.query";
import { AsanaConfigFields } from "./asana-config-fields";
import { ConfluenceConfigFields } from "./confluence-config-fields";
import { ConnectorTypeIcon } from "./connector-icons";
import { DropboxConfigFields } from "./dropbox-config-fields";
import { GoogleDriveConfigFields } from "./gdrive-config-fields";
import { GithubConfigFields } from "./github-config-fields";
import { GitlabConfigFields } from "./gitlab-config-fields";
import { JiraConfigFields } from "./jira-config-fields";
import { LinearConfigFields } from "./linear-config-fields";
import { NotionConfigFields } from "./notion-config-fields";
import { SchedulePicker } from "./schedule-picker";
import { ServiceNowConfigFields } from "./servicenow-config-fields";
import { SharePointConfigFields } from "./sharepoint-config-fields";
import { transformConfigArrayFields } from "./transform-config-array-fields";

type ConnectorItem = Pick<
  archestraApiTypes.GetConnectorsResponses["200"]["data"][number],
  | "id"
  | "name"
  | "description"
  | "visibility"
  | "teamIds"
  | "connectorType"
  | "config"
  | "schedule"
  | "enabled"
>;

interface EditConnectorFormValues {
  name: string;
  description: string;
  enabled: boolean;
  config: Record<string, unknown>;
  email: string;
  apiToken: string;
  schedule: string;
}

export function EditConnectorDialog({
  connector,
  open,
  onOpenChange,
}: {
  connector: ConnectorItem;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const updateConnector = useUpdateConnector();
  const [visibility, setVisibility] = useState(connector.visibility);
  const [teamIds, setTeamIds] = useState<string[]>(connector.teamIds);

  const form = useForm<EditConnectorFormValues>({
    defaultValues: {
      name: connector.name,
      description: connector.description ?? "",
      enabled: connector.enabled,
      config: connector.config,
      email: "",
      apiToken: "",
      schedule: connector.schedule,
    },
  });

  useEffect(() => {
    if (open) {
      setVisibility(connector.visibility);
      setTeamIds(connector.teamIds);
      form.reset({
        name: connector.name,
        description: connector.description ?? "",
        enabled: connector.enabled,
        config: connector.config,
        email: "",
        apiToken: "",
        schedule: connector.schedule,
      });
    }
  }, [open, connector, form]);

  const connectorType = connector.connectorType;
  const { typeLabel, urlFields: urlConfig } = getEditUrlConfig(connectorType);
  const connectorDocsUrl = getConnectorDocsUrl(connectorType);

  const needsEmail = connectorType === "jira" || connectorType === "confluence";
  const isCloud = form.watch("config.isCloud") as boolean | undefined;
  const emailRequired = needsEmail && isCloud !== false;

  const handleSubmit = async (values: EditConnectorFormValues) => {
    const hasCredentials = values.apiToken.length > 0;
    const result = await updateConnector.mutateAsync({
      id: connector.id,
      body: {
        name: values.name,
        description: values.description || null,
        visibility,
        teamIds: visibility === "team-scoped" ? teamIds : [],
        enabled: values.enabled,
        config: transformConfigArrayFields(
          values.config,
        ) as archestraApiTypes.CreateConnectorData["body"]["config"],
        schedule: values.schedule,
        ...(hasCredentials && {
          credentials: {
            ...(values.email && { email: values.email }),
            apiToken: values.apiToken,
          },
        }),
      },
    });
    if (result) {
      onOpenChange(false);
    }
  };

  return (
    <StandardFormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={
        <span className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-muted">
            <ConnectorTypeIcon type={connectorType} className="h-4 w-4" />
          </div>
          Edit {typeLabel} Connector
        </span>
      }
      description={
        <>
          Update the settings for this connector.{" "}
          <ExternalDocsLink
            href={connectorDocsUrl}
            className="underline"
            showIcon={false}
          >
            Learn more
          </ExternalDocsLink>
        </>
      }
      size="medium"
      onSubmit={form.handleSubmit(handleSubmit)}
      footer={
        <>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={updateConnector.isPending}>
            {updateConnector.isPending ? "Saving..." : "Save Changes"}
          </Button>
        </>
      }
    >
      <Form {...form}>
        <div className="space-y-4">
          <FormField
            control={form.control}
            name="enabled"
            render={({ field }) => (
              <FormItem className="flex items-center justify-between rounded-lg border p-3">
                <div>
                  <FormLabel className="text-sm font-medium">Enabled</FormLabel>
                  <FormDescription className="text-xs">
                    When disabled, scheduled syncs will not run.
                  </FormDescription>
                </div>
                <FormControl>
                  <Switch
                    checked={field.value}
                    onCheckedChange={field.onChange}
                  />
                </FormControl>
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="name"
            rules={{ required: "Name is required" }}
            render={({ field }) => (
              <FormItem>
                <FormLabel>Name</FormLabel>
                <FormControl>
                  <Input
                    placeholder={getConnectorNamePlaceholder(
                      connector.connectorType,
                    )}
                    {...field}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="description"
            render={({ field }) => (
              <FormItem>
                <FormLabel>
                  Description{" "}
                  <span className="text-muted-foreground font-normal">
                    (optional)
                  </span>
                </FormLabel>
                <FormControl>
                  <Input
                    placeholder="A short description of this connector"
                    {...field}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <KnowledgeSourceVisibilitySelector
            visibility={visibility}
            onVisibilityChange={setVisibility}
            teamIds={teamIds}
            onTeamIdsChange={setTeamIds}
            showTeamRequired
          />

          {urlConfig && (
            <FormField
              control={form.control}
              // biome-ignore lint/suspicious/noExplicitAny: form field name requires dynamic typing
              name={urlConfig.fieldName as any}
              rules={{ required: `${urlConfig.label} is required` }}
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{urlConfig.label}</FormLabel>
                  <FormControl>
                    <Input
                      placeholder={urlConfig.placeholder}
                      {...field}
                      value={(field.value as string) ?? ""}
                    />
                  </FormControl>
                  <FormDescription>{urlConfig.description}</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
          )}

          {(connectorType === "jira" || connectorType === "confluence") && (
            <FormField
              control={form.control}
              // biome-ignore lint/suspicious/noExplicitAny: form field name requires dynamic typing
              name={"config.isCloud" as any}
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
          )}

          {needsEmail && (
            <FormField
              control={form.control}
              name="email"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Email{!emailRequired && " (optional)"}</FormLabel>
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
                  <FormDescription>
                    Leave empty to keep existing credentials unchanged.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
          )}

          {connectorType === "servicenow" && (
            <FormField
              control={form.control}
              name="email"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Username</FormLabel>
                  <FormControl>
                    <Input placeholder="admin" {...field} />
                  </FormControl>
                  <FormDescription>
                    Leave empty to keep existing credentials unchanged.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
          )}

          {connectorType === "sharepoint" && (
            <FormField
              control={form.control}
              name="config.tenantId"
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
          )}

          {connectorType === "sharepoint" && (
            <FormField
              control={form.control}
              name="email"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Client ID</FormLabel>
                  <FormControl>
                    <Input
                      placeholder="Leave empty to keep existing credentials"
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
          )}

          <FormField
            control={form.control}
            name="apiToken"
            render={({ field }) => (
              <FormItem>
                <FormLabel>
                  {connectorType === "servicenow"
                    ? "Password"
                    : connectorType === "notion"
                      ? "Integration Token"
                      : connectorType === "sharepoint"
                        ? "Client Secret"
                        : connectorType === "gdrive"
                          ? "Service Account Key / OAuth Token"
                          : connectorType === "dropbox"
                            ? "Access Token"
                            : needsEmail
                              ? emailRequired
                                ? "API Token"
                                : "API Token / Personal Access Token"
                              : "Personal Access Token"}
                </FormLabel>
                <FormControl>
                  <Input
                    type="password"
                    placeholder={
                      connectorType === "servicenow"
                        ? "Leave empty to keep existing password"
                        : "Leave empty to keep existing token"
                    }
                    {...field}
                  />
                </FormControl>
                <FormDescription>
                  Leave empty to keep existing credentials unchanged.
                </FormDescription>
                {connectorType === "sharepoint" && (
                  <p className="text-[0.8rem] text-muted-foreground">
                    The Azure AD app registration requires the{" "}
                    <code>Sites.Read.All</code> permission on Microsoft Graph.
                  </p>
                )}
                {connectorType === "gdrive" && (
                  <p className="text-[0.8rem] text-muted-foreground">
                    Paste a service account JSON key (entire file content) or an
                    OAuth2 access token with <code>drive.readonly</code> scope.
                  </p>
                )}
                <FormMessage />
              </FormItem>
            )}
          />

          <Collapsible>
            <CollapsibleTrigger className="flex w-full items-center justify-between cursor-pointer group border-t pt-3">
              <span className="text-sm font-medium">Advanced</span>
              <ChevronDown className="h-4 w-4 text-muted-foreground transition-transform duration-200 group-data-[state=open]:rotate-180" />
            </CollapsibleTrigger>
            <CollapsibleContent className="pt-4 space-y-4">
              <SchedulePicker form={form} name="schedule" />
              {connectorType === "jira" && (
                <JiraConfigFields form={form} hideUrl hideIsCloud />
              )}
              {connectorType === "confluence" && (
                <ConfluenceConfigFields form={form} hideUrl hideIsCloud />
              )}
              {connectorType === "github" && (
                <GithubConfigFields form={form} hideUrl />
              )}
              {connectorType === "gitlab" && (
                <GitlabConfigFields form={form} hideUrl />
              )}
              {connectorType === "linear" && <LinearConfigFields form={form} />}
              {connectorType === "servicenow" && (
                <ServiceNowConfigFields form={form} hideUrl />
              )}
              {connectorType === "notion" && <NotionConfigFields form={form} />}
              {connectorType === "sharepoint" && (
                <SharePointConfigFields form={form} />
              )}
              {connectorType === "gdrive" && (
                <GoogleDriveConfigFields form={form} />
              )}
              {connectorType === "dropbox" && (
                <DropboxConfigFields control={form.control} />
              )}
              {connectorType === "asana" && <AsanaConfigFields form={form} />}
            </CollapsibleContent>
          </Collapsible>
        </div>
      </Form>
    </StandardFormDialog>
  );
}

type ConnectorType =
  archestraApiTypes.CreateConnectorData["body"]["connectorType"];

function getEditUrlConfig(type: ConnectorType): {
  typeLabel: string;
  urlFields: {
    fieldName: string;
    label: string;
    placeholder: string;
    description: string;
  } | null;
} {
  switch (type) {
    case "jira":
      return {
        typeLabel: "Jira",
        urlFields: {
          fieldName: "config.jiraBaseUrl",
          label: "URL",
          placeholder: "https://your-domain.atlassian.net",
          description: "Your Jira instance URL.",
        },
      };
    case "confluence":
      return {
        typeLabel: "Confluence",
        urlFields: {
          fieldName: "config.confluenceUrl",
          label: "URL",
          placeholder: "https://your-domain.atlassian.net/wiki",
          description: "Your Confluence instance URL.",
        },
      };
    case "github":
      return {
        typeLabel: "GitHub",
        urlFields: {
          fieldName: "config.githubUrl",
          label: "GitHub API URL",
          placeholder: "https://api.github.com",
          description:
            "Use https://api.github.com for GitHub.com, or your GitHub Enterprise API URL.",
        },
      };
    case "gitlab":
      return {
        typeLabel: "GitLab",
        urlFields: {
          fieldName: "config.gitlabUrl",
          label: "GitLab URL",
          placeholder: "https://gitlab.com",
          description: "Use https://gitlab.com or your self-hosted GitLab URL.",
        },
      };
    case "servicenow":
      return {
        typeLabel: "ServiceNow",
        urlFields: {
          fieldName: "config.instanceUrl",
          label: "Instance URL",
          placeholder: "https://your-instance.service-now.com",
          description: "Your ServiceNow instance URL.",
        },
      };
    case "linear":
      return {
        typeLabel: "Linear",
        urlFields: {
          fieldName: "config.linearApiUrl",
          label: "Linear API URL",
          placeholder: "https://api.linear.app",
          description: "Linear GraphQL API base URL.",
        },
      };
    case "notion":
      return { typeLabel: "Notion", urlFields: null };
    case "gdrive":
      return { typeLabel: "Google Drive", urlFields: null };
    case "asana":
      return { typeLabel: "Asana", urlFields: null };
    case "sharepoint":
      return {
        typeLabel: "SharePoint",
        urlFields: {
          fieldName: "config.siteUrl",
          label: "Site URL",
          placeholder: "https://your-tenant.sharepoint.com/sites/your-site",
          description: "Your SharePoint site URL.",
        },
      };
    case "dropbox":
      return { typeLabel: "Dropbox", urlFields: null };
    default:
      return {
        typeLabel: type,
        urlFields: {
          fieldName: "config.url",
          label: "URL",
          placeholder: "",
          description: "",
        },
      };
  }
}

function getConnectorDocsUrl(type: ConnectorType): string | null {
  return getFrontendDocsUrl(DocsPage.PlatformKnowledgeConnectors, type);
}
