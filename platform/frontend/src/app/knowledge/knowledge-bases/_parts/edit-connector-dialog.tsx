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
import { useUpdateConnector } from "@/lib/connector.query";
import { ConfluenceConfigFields } from "./confluence-config-fields";
import { ConnectorTypeIcon } from "./connector-icons";
import { JiraConfigFields } from "./jira-config-fields";
import { SchedulePicker } from "./schedule-picker";

type ConnectorItem =
  archestraApiTypes.GetConnectorsResponses["200"]["data"][number];

interface EditConnectorFormValues {
  name: string;
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
      config: connector.config as Record<string, unknown>,
      schedule: connector.schedule,
    },
  });

  useEffect(() => {
    if (open) {
      form.reset({
        name: connector.name,
        config: connector.config as Record<string, unknown>,
        schedule: connector.schedule,
      });
    }
  }, [open, connector, form]);

  const connectorType = connector.connectorType;
  const urlFieldName =
    connectorType === "jira" ? "config.jiraBaseUrl" : "config.confluenceUrl";
  const urlPlaceholder =
    connectorType === "jira"
      ? "https://your-domain.atlassian.net"
      : "https://your-domain.atlassian.net/wiki";

  const handleSubmit = async (values: EditConnectorFormValues) => {
    const result = await updateConnector.mutateAsync({
      id: connector.id,
      body: {
        name: values.name,
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
      <DialogContent className="max-w-xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <div className="flex h-7 w-7 items-center justify-center rounded-md bg-muted">
              <ConnectorTypeIcon type={connectorType} className="h-4 w-4" />
            </div>
            Edit {connectorType === "jira" ? "Jira" : "Confluence"} Connector
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
              name={urlFieldName}
              rules={{ required: "URL is required" }}
              render={({ field }) => (
                <FormItem>
                  <FormLabel>URL</FormLabel>
                  <FormControl>
                    <Input
                      placeholder={urlPlaceholder}
                      {...field}
                      value={(field.value as string) ?? ""}
                    />
                  </FormControl>
                  <FormDescription>
                    Your {connectorType === "jira" ? "Jira" : "Confluence"}{" "}
                    instance URL.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <Collapsible>
              <CollapsibleTrigger className="flex w-full items-center justify-between cursor-pointer group rounded-lg border p-3">
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
