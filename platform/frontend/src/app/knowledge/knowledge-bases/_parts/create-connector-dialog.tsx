"use client";

import {
  type archestraApiTypes,
  CONNECTOR_TYPE_LABELS,
  getConnectorNamePlaceholder,
} from "@shared";
import { ArrowLeft, ChevronDown } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogDescription,
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
import { useCreateConnector } from "@/lib/connector.query";
import { ConfluenceConfigFields } from "./confluence-config-fields";
import { ConnectorTypeIcon } from "./connector-icons";
import { GithubConfigFields } from "./github-config-fields";
import { GitlabConfigFields } from "./gitlab-config-fields";
import { JiraConfigFields } from "./jira-config-fields";
import { SchedulePicker } from "./schedule-picker";
import { ServiceNowConfigFields } from "./servicenow-config-fields";
import { transformConfigArrayFields } from "./transform-config-array-fields";

type ConnectorType = "jira" | "confluence" | "github" | "gitlab" | "servicenow";

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
    type: "servicenow",
    label: "ServiceNow",
    description: "Sync incidents from ServiceNow",
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

export function CreateConnectorDialog({
  knowledgeBaseId,
  open,
  onOpenChange,
}: {
  knowledgeBaseId?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const createConnector = useCreateConnector();
  const [step, setStep] = useState<"select" | "configure">("select");
  const [selectedType, setSelectedType] = useState<ConnectorType | null>(null);

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
      servicenow: { type, initialSyncMonths: 6 },
    };
    form.setValue("config", defaultConfigs[type]);
    setStep("configure");
  };

  const handleBack = () => {
    setStep("select");
  };

  const handleSubmit = async (values: CreateConnectorFormValues) => {
    const config = transformConfigArrayFields(values.config);
    const result = await createConnector.mutateAsync({
      name: values.name,
      description: values.description || null,
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
      onOpenChange(false);
    }
  };

  const handleClose = (isOpen: boolean) => {
    if (!isOpen) {
      form.reset();
      setStep("select");
      setSelectedType(null);
    }
    onOpenChange(isOpen);
  };

  const urlConfig = getUrlConfig(connectorType);
  const isCloud = form.watch("config.isCloud") as boolean | undefined;
  const needsEmail = connectorType === "jira" || connectorType === "confluence";
  const emailRequired = needsEmail && isCloud !== false;

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col overflow-y-auto">
        {step === "select" ? (
          <>
            <DialogHeader>
              <DialogTitle>Add Connector</DialogTitle>
              <DialogDescription>
                Select a connector type to get started.
              </DialogDescription>
            </DialogHeader>
            <div className="grid grid-cols-2 gap-3 py-2">
              {CONNECTOR_OPTIONS.map((option) => (
                <button
                  key={option.type}
                  type="button"
                  onClick={() => handleSelectType(option.type)}
                  className="flex flex-col items-center gap-3 rounded-lg border p-5 text-center transition-colors hover:bg-muted/50 cursor-pointer"
                >
                  <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-muted">
                    <ConnectorTypeIcon type={option.type} className="h-7 w-7" />
                  </div>
                  <div>
                    <div className="font-medium">{option.label}</div>
                    <div className="text-xs text-muted-foreground mt-1">
                      {option.description}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </>
        ) : (
          <Form {...form}>
            <form onSubmit={form.handleSubmit(handleSubmit)}>
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
                  instance.
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-4 py-4">
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

                <FormField
                  control={form.control}
                  // biome-ignore lint/suspicious/noExplicitAny: dynamic field name for connector-specific URL
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
                        : "Personal access token is required",
                  }}
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>
                        {connectorType === "servicenow"
                          ? "Password"
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
                              : needsEmail
                                ? emailRequired
                                  ? "Your API token"
                                  : "Your API token or personal access token"
                                : "Your personal access token"
                          }
                          {...field}
                        />
                      </FormControl>
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
                    {connectorType === "servicenow" && (
                      <ServiceNowConfigFields form={form} hideUrl />
                    )}
                  </CollapsibleContent>
                </Collapsible>
              </div>

              <DialogStickyFooter>
                <Button type="button" variant="outline" onClick={handleBack}>
                  Back
                </Button>
                <Button type="submit" disabled={createConnector.isPending}>
                  {createConnector.isPending
                    ? "Creating..."
                    : "Create Connector"}
                </Button>
              </DialogStickyFooter>
            </form>
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
} {
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
  }
}
