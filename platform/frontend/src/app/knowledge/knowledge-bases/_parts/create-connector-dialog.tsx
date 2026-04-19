"use client";

import {
  type archestraApiTypes,
  CONNECTOR_TYPE_LABELS,
  DocsPage,
  getConnectorNamePlaceholder,
} from "@shared";
import { ArrowLeft, ChevronDown } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { KnowledgeSourceVisibilitySelector } from "@/app/knowledge/_parts/knowledge-source-visibility-selector";
import { ExternalDocsLink } from "@/components/external-docs-link";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogForm,
  DialogHeader,
  DialogStickyFooter,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { useCreateConnector } from "@/lib/knowledge/connector.query";
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

type ConnectorType =
  archestraApiTypes.CreateConnectorData["body"]["connectorType"];

const CONNECTOR_OPTIONS: {
  type: ConnectorType;
  label: string;
  description: string;
}[] = [
  {
    type: "jira",
    label: CONNECTOR_TYPE_LABELS.jira,
    description: "Sync issues and projects from Jira",
  },
  {
    type: "confluence",
    label: CONNECTOR_TYPE_LABELS.confluence,
    description: "Sync pages and spaces from Confluence",
  },
  {
    type: "github",
    label: CONNECTOR_TYPE_LABELS.github,
    description: "Sync issues and pull requests from GitHub",
  },
  {
    type: "gitlab",
    label: CONNECTOR_TYPE_LABELS.gitlab,
    description: "Sync issues and merge requests from GitLab",
  },
  {
    type: "linear",
    label: CONNECTOR_TYPE_LABELS.linear,
    description: "Sync issues, projects, and cycles from Linear",
  },
  {
    type: "servicenow",
    label: "ServiceNow",
    description: "Sync incidents from ServiceNow",
  },
  {
    type: "notion",
    label: CONNECTOR_TYPE_LABELS.notion,
    description: "Sync pages and databases from Notion",
  },
  {
    type: "sharepoint",
    label: CONNECTOR_TYPE_LABELS.sharepoint,
    description: "Sync documents and pages from SharePoint",
  },
  {
    type: "gdrive",
    label: CONNECTOR_TYPE_LABELS.gdrive,
    description: "Sync files and documents from Google Drive",
  },
  {
    type: "dropbox",
    label: "Dropbox",
    description: "Sync files and folders from Dropbox",
  },
  {
    type: "asana",
    label: CONNECTOR_TYPE_LABELS.asana,
    description: "Sync tasks and comments from Asana",
  },
];

interface CreateConnectorFormValues {
  name: string;
  description: string;
  connectorType: ConnectorType;
  config: Record<string, unknown>;
  email: string;
  apiToken: string;
  schedule: string;
}

type ConnectorVisibility = NonNullable<
  archestraApiTypes.CreateConnectorData["body"]["visibility"]
>;

export function CreateConnectorDialog({
  knowledgeBaseId,
  open,
  onOpenChange,
  onBack,
}: {
  knowledgeBaseId?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onBack?: () => void;
}) {
  const createConnector = useCreateConnector();
  const [step, setStep] = useState<"select" | "configure">("select");
  const [selectedType, setSelectedType] = useState<ConnectorType | null>(null);
  const [visibility, setVisibility] = useState<ConnectorVisibility>("org-wide");
  const [teamIds, setTeamIds] = useState<string[]>([]);

  const form = useForm<CreateConnectorFormValues>({
    defaultValues: {
      name: "",
      description: "",
      connectorType: "jira",
      config: { type: "jira", isCloud: true },
      email: "",
      apiToken: "",
      schedule: "0 */6 * * *",
    },
  });

  const connectorType = form.watch("connectorType");

  const handleSelectType = (type: ConnectorType) => {
    setSelectedType(type);
    form.setValue("connectorType", type);
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
      sharepoint: { type, includePages: true },
      gdrive: { type, recursive: true },
      dropbox: { type, rootPath: "" },
      asana: { type },
    };
    form.setValue("config", defaultConfigs[type]);
    setStep("configure");
  };

  const handleBack = () => {
    setStep("select");
  };

  const handleBackToChooser = () => {
    form.reset();
    setStep("select");
    setSelectedType(null);
    onBack?.();
  };

  const handleSubmit = async (values: CreateConnectorFormValues) => {
    const config = transformConfigArrayFields(values.config);
    const result = await createConnector.mutateAsync({
      name: values.name,
      description: values.description || null,
      visibility,
      teamIds: visibility === "team-scoped" ? teamIds : [],
      connectorType: values.connectorType,
      config: config as archestraApiTypes.CreateConnectorData["body"]["config"],
      credentials: {
        ...(values.email && { email: values.email }),
        apiToken: values.apiToken,
      },
      schedule: values.schedule,
      ...(knowledgeBaseId && { knowledgeBaseIds: [knowledgeBaseId] }),
    });
    if (result) {
      form.reset();
      setStep("select");
      setSelectedType(null);
      setVisibility("org-wide");
      setTeamIds([]);
      onOpenChange(false);
    }
  };

  const handleClose = (isOpen: boolean) => {
    if (!isOpen) {
      form.reset();
      setStep("select");
      setSelectedType(null);
      setVisibility("org-wide");
      setTeamIds([]);
    }
    onOpenChange(isOpen);
  };

  const urlConfig = getUrlConfig(connectorType);
  const isCloud = form.watch("config.isCloud") as boolean | undefined;
  const needsEmail = connectorType === "jira" || connectorType === "confluence";
  const emailRequired = needsEmail && isCloud !== false;
  const connectorDocsUrl = selectedType
    ? getConnectorDocsUrl(selectedType)
    : null;

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col overflow-hidden">
        {step === "select" ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                {onBack && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    onClick={handleBackToChooser}
                  >
                    <ArrowLeft className="h-4 w-4" />
                  </Button>
                )}
                Add Connector
              </DialogTitle>
              <DialogDescription>
                Select a connector type to get started.
              </DialogDescription>
            </DialogHeader>
            <DialogBody className="pt-4">
              <div className="grid grid-cols-2 gap-3">
                {CONNECTOR_OPTIONS.map((option) => (
                  <button
                    key={option.type}
                    type="button"
                    onClick={() => handleSelectType(option.type)}
                    className="flex cursor-pointer flex-col items-center gap-3 rounded-lg border p-5 text-center transition-colors hover:bg-muted/50"
                  >
                    <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-muted">
                      <ConnectorTypeIcon
                        type={option.type}
                        className="h-7 w-7"
                      />
                    </div>
                    <div>
                      <div className="font-medium">{option.label}</div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        {option.description}
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            </DialogBody>
          </>
        ) : (
          <Form {...form}>
            <DialogForm
              onSubmit={form.handleSubmit(handleSubmit)}
              className="flex min-h-0 flex-1 flex-col"
            >
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    onClick={handleBack}
                  >
                    <ArrowLeft className="h-4 w-4" />
                  </Button>
                  Configure{" "}
                  {
                    CONNECTOR_OPTIONS.find((o) => o.type === selectedType)
                      ?.label
                  }{" "}
                  Connector
                </DialogTitle>
                <DialogDescription>
                  Enter the connection details for your{" "}
                  {
                    CONNECTOR_OPTIONS.find((o) => o.type === selectedType)
                      ?.label
                  }{" "}
                  instance.{" "}
                  <ExternalDocsLink
                    href={connectorDocsUrl}
                    className="underline"
                    showIcon={false}
                  >
                    Learn more
                  </ExternalDocsLink>
                </DialogDescription>
              </DialogHeader>

              <DialogBody className="space-y-4">
                <FormField
                  control={form.control}
                  name="name"
                  rules={{ required: "Name is required" }}
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Name</FormLabel>
                      <FormControl>
                        <Input
                          placeholder={
                            selectedType
                              ? getConnectorNamePlaceholder(selectedType)
                              : ""
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
                        <FormDescription>
                          {urlConfig.description}
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                )}

                {(connectorType === "jira" ||
                  connectorType === "confluence") && (
                  <FormField
                    control={form.control}
                    name="config.isCloud"
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

                {connectorType === "github" && (
                  <FormField
                    control={form.control}
                    name="config.owner"
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
                        <FormDescription>
                          GitHub organization or username.
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                )}

                {connectorType === "asana" && (
                  <FormField
                    control={form.control}
                    name="config.workspaceGid"
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
                          Your Asana workspace GID. Syncs top-level tasks only
                          &mdash; subtasks aren&apos;t supported in the initial
                          version.
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                )}

                {needsEmail && (
                  <FormField
                    control={form.control}
                    name="email"
                    rules={{
                      validate: (value) => {
                        const currentIsCloud = form.getValues("config.isCloud");
                        if (currentIsCloud !== false && !value)
                          return "Email is required";
                        return true;
                      },
                    }}
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>
                          Email{!emailRequired && " (optional)"}
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
                        {!emailRequired && (
                          <FormDescription>
                            Leave empty to authenticate with a personal access
                            token instead.
                          </FormDescription>
                        )}
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                )}

                {connectorType === "servicenow" && (
                  <FormField
                    control={form.control}
                    name="email"
                    rules={{ required: "Username is required" }}
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Username</FormLabel>
                        <FormControl>
                          <Input placeholder="admin" {...field} />
                        </FormControl>
                        <FormDescription>
                          Your ServiceNow username for basic authentication.
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
                    rules={{ required: "Tenant ID is required" }}
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
                    rules={{ required: "Client ID is required" }}
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Client ID</FormLabel>
                        <FormControl>
                          <Input
                            placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
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
                  rules={{
                    required: needsEmail
                      ? emailRequired
                        ? "API token is required"
                        : "API token or personal access token is required"
                      : connectorType === "servicenow"
                        ? "Password is required"
                        : connectorType === "notion"
                          ? "Integration token is required"
                          : connectorType === "sharepoint"
                            ? "Client secret is required"
                            : connectorType === "gdrive"
                              ? "Service account key or OAuth token is required"
                              : connectorType === "dropbox"
                                ? "Access token is required"
                                : "Personal access token is required",
                  }}
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
                              ? "Your ServiceNow password"
                              : connectorType === "notion"
                                ? "secret_..."
                                : connectorType === "sharepoint"
                                  ? "Your Azure AD client secret"
                                  : connectorType === "gdrive"
                                    ? "Paste service account JSON key or OAuth access token"
                                    : connectorType === "dropbox"
                                      ? "Your Dropbox access token"
                                      : needsEmail
                                        ? emailRequired
                                          ? "Your API token"
                                          : "Your API token or personal access token"
                                        : "Your personal access token"
                          }
                          {...field}
                        />
                      </FormControl>
                      {connectorType === "notion" && (
                        <p className="text-[0.8rem] text-muted-foreground">
                          Your Notion integration token (starts with{" "}
                          <code>secret_</code>). Create one at
                          notion.so/my-integrations.
                        </p>
                      )}
                      {connectorType === "sharepoint" && (
                        <p className="text-[0.8rem] text-muted-foreground">
                          The Azure AD app registration requires the{" "}
                          <code>Sites.Read.All</code> permission on Microsoft
                          Graph.
                        </p>
                      )}
                      {connectorType === "dropbox" && (
                        <p className="text-[0.8rem] text-muted-foreground">
                          Your Dropbox access token. Generate one in your
                          Dropbox App Console.
                        </p>
                      )}
                      {connectorType === "gdrive" && (
                        <p className="text-[0.8rem] text-muted-foreground">
                          Paste a service account JSON key (entire file content)
                          or an OAuth2 access token with{" "}
                          <code>drive.readonly</code> scope.
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
                    {connectorType === "linear" && (
                      <LinearConfigFields form={form} />
                    )}
                    {connectorType === "servicenow" && (
                      <ServiceNowConfigFields form={form} hideUrl />
                    )}
                    {connectorType === "notion" && (
                      <NotionConfigFields form={form} />
                    )}
                    {connectorType === "sharepoint" && (
                      <SharePointConfigFields form={form} />
                    )}
                    {connectorType === "gdrive" && (
                      <GoogleDriveConfigFields form={form} />
                    )}
                    {connectorType === "dropbox" && (
                      <DropboxConfigFields control={form.control} />
                    )}
                    {connectorType === "asana" && (
                      <AsanaConfigFields form={form} hideWorkspaceGid />
                    )}
                  </CollapsibleContent>
                </Collapsible>
              </DialogBody>

              <DialogStickyFooter className="mt-0">
                <Button type="button" variant="outline" onClick={handleBack}>
                  Back
                </Button>
                <Button type="submit" disabled={createConnector.isPending}>
                  {createConnector.isPending
                    ? "Creating..."
                    : "Create Connector"}
                </Button>
              </DialogStickyFooter>
            </DialogForm>
          </Form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function getUrlConfig(type: ConnectorType): {
  fieldName: string;
  label: string;
  placeholder: string;
  description: string;
} | null {
  switch (type) {
    case "jira":
      return {
        fieldName: "config.jiraBaseUrl",
        label: "URL",
        placeholder: "https://your-domain.atlassian.net",
        description: "Your Jira instance URL.",
      };
    case "confluence":
      return {
        fieldName: "config.confluenceUrl",
        label: "URL",
        placeholder: "https://your-domain.atlassian.net/wiki",
        description: "Your Confluence instance URL.",
      };
    case "github":
      return {
        fieldName: "config.githubUrl",
        label: "GitHub API URL",
        placeholder: "https://api.github.com",
        description:
          "Use https://api.github.com for GitHub.com, or your GitHub Enterprise API URL.",
      };
    case "gitlab":
      return {
        fieldName: "config.gitlabUrl",
        label: "GitLab URL",
        placeholder: "https://gitlab.com",
        description: "Use https://gitlab.com or your self-hosted GitLab URL.",
      };
    case "servicenow":
      return {
        fieldName: "config.instanceUrl",
        label: "Instance URL",
        placeholder: "https://your-instance.service-now.com",
        description: "Your ServiceNow instance URL.",
      };
    case "linear":
      return {
        fieldName: "config.linearApiUrl",
        label: "Linear API URL",
        placeholder: "https://api.linear.app",
        description: "Linear GraphQL API base URL.",
      };
    case "notion":
      return null;
    case "gdrive":
      return null;
    case "asana":
      return null;
    case "sharepoint":
      return {
        fieldName: "config.siteUrl",
        label: "Site URL",
        placeholder: "https://your-tenant.sharepoint.com/sites/your-site",
        description: "Your SharePoint site URL.",
      };
    default:
      return null;
  }
}

function getConnectorDocsUrl(type: ConnectorType): string | null {
  return getFrontendDocsUrl(DocsPage.PlatformKnowledgeConnectors, type);
}
