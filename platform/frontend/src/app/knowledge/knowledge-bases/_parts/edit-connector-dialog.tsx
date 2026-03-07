"use client";

import type { archestraApiTypes } from "@shared";
import { ChevronDown } from "lucide-react";
import { useEffect } from "react";
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
  DialogFooter,
  DialogHeader,
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
import { useUpdateConnector } from "@/lib/connector.query";
import { ConfluenceConfigFields } from "./confluence-config-fields";
import { ConnectorTypeIcon } from "./connector-icons";
import { GithubConfigFields } from "./github-config-fields";
import { GitlabConfigFields } from "./gitlab-config-fields";
import { JiraConfigFields } from "./jira-config-fields";
import { SchedulePicker } from "./schedule-picker";

type ConnectorItem = Pick<
  archestraApiTypes.GetConnectorsResponses["200"]["data"][number],
  "id" | "name" | "connectorType" | "config" | "schedule" | "enabled"
>;

interface EditConnectorFormValues {
  name: string;
  enabled: boolean;
  config: Record<string, unknown>;
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

  const form = useForm<EditConnectorFormValues>({
    defaultValues: {
      name: connector.name,
      enabled: connector.enabled,
      config: connector.config as Record<string, unknown>,
      schedule: connector.schedule,
    },
  });

  useEffect(() => {
    if (open) {
      form.reset({
        name: connector.name,
        enabled: connector.enabled,
        config: connector.config as Record<string, unknown>,
        schedule: connector.schedule,
      });
    }
  }, [open, connector, form]);

  const connectorType = connector.connectorType;
  const urlConfig = getEditUrlConfig(connectorType);

  const handleSubmit = async (values: EditConnectorFormValues) => {
    const result = await updateConnector.mutateAsync({
      id: connector.id,
      body: {
        name: values.name,
        enabled: values.enabled,
        config:
          values.config as archestraApiTypes.CreateConnectorData["body"]["config"],
        schedule: values.schedule,
      },
    });
    if (result) {
      onOpenChange(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <div className="flex h-7 w-7 items-center justify-center rounded-md bg-muted">
              <ConnectorTypeIcon type={connectorType} className="h-4 w-4" />
            </div>
            Edit {urlConfig.typeLabel} Connector
          </DialogTitle>
          <DialogDescription>
            Update the settings for this connector.
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form
            onSubmit={form.handleSubmit(handleSubmit)}
            className="space-y-4"
          >
            <FormField
              control={form.control}
              name="name"
              rules={{ required: "Name is required" }}
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Name</FormLabel>
                  <FormControl>
                    <Input placeholder="Connector name" {...field} />
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

            <FormField
              control={form.control}
              name="enabled"
              render={({ field }) => (
                <FormItem className="flex items-center justify-between rounded-lg border p-3">
                  <div>
                    <FormLabel className="text-sm font-medium">
                      Enabled
                    </FormLabel>
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

            <Collapsible>
              <CollapsibleTrigger className="flex w-full items-center justify-between cursor-pointer group border-t pt-3">
                <span className="text-sm font-medium">Advanced</span>
                <ChevronDown className="h-4 w-4 text-muted-foreground transition-transform duration-200 group-data-[state=open]:rotate-180" />
              </CollapsibleTrigger>
              <CollapsibleContent className="pt-4 space-y-4">
                <SchedulePicker form={form} name="schedule" />
                {connectorType === "jira" && (
                  <JiraConfigFields form={form} hideUrl />
                )}
                {connectorType === "confluence" && (
                  <ConfluenceConfigFields form={form} hideUrl />
                )}
                {connectorType === "github" && (
                  <GithubConfigFields form={form} hideUrl />
                )}
                {connectorType === "gitlab" && (
                  <GitlabConfigFields form={form} hideUrl />
                )}
              </CollapsibleContent>
            </Collapsible>

            <DialogFooter>
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
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

type ConnectorType =
  archestraApiTypes.CreateConnectorData["body"]["connectorType"];

function getEditUrlConfig(type: ConnectorType): {
  fieldName: string;
  label: string;
  placeholder: string;
  description: string;
  typeLabel: string;
} {
  switch (type) {
    case "jira":
      return {
        fieldName: "config.jiraBaseUrl",
        label: "URL",
        placeholder: "https://your-domain.atlassian.net",
        description: "Your Jira instance URL.",
        typeLabel: "Jira",
      };
    case "confluence":
      return {
        fieldName: "config.confluenceUrl",
        label: "URL",
        placeholder: "https://your-domain.atlassian.net/wiki",
        description: "Your Confluence instance URL.",
        typeLabel: "Confluence",
      };
    case "github":
      return {
        fieldName: "config.githubUrl",
        label: "GitHub API URL",
        placeholder: "https://api.github.com",
        description:
          "Use https://api.github.com for GitHub.com, or your GitHub Enterprise API URL.",
        typeLabel: "GitHub",
      };
    case "gitlab":
      return {
        fieldName: "config.gitlabUrl",
        label: "GitLab URL",
        placeholder: "https://gitlab.com",
        description: "Use https://gitlab.com or your self-hosted GitLab URL.",
        typeLabel: "GitLab",
      };
    default:
      return {
        fieldName: "config.url",
        label: "URL",
        placeholder: "",
        description: "",
        typeLabel: type,
      };
  }
}
