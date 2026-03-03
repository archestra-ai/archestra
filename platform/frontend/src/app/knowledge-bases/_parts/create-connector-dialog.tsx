"use client";

import type { archestraApiTypes } from "@shared";
import { ChevronDown } from "lucide-react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useCreateConnector } from "@/lib/connector.query";
import { ConfluenceConfigFields } from "./confluence-config-fields";
import { JiraConfigFields } from "./jira-config-fields";
import { SchedulePicker } from "./schedule-picker";

interface CreateConnectorFormValues {
  name: string;
  connectorType: "jira" | "confluence";
  config: Record<string, unknown>; // cast to discriminated union in handleSubmit
  email: string;
  apiToken: string;
  schedule: string;
}

export function CreateConnectorDialog({
  knowledgeBaseId,
  open,
  onOpenChange,
}: {
  knowledgeBaseId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const createConnector = useCreateConnector(knowledgeBaseId);

  const form = useForm<CreateConnectorFormValues>({
    defaultValues: {
      name: "",
      connectorType: "jira",
      config: { type: "jira", isCloud: true },
      email: "",
      apiToken: "",
      schedule: "0 */6 * * *",
    },
  });

  const connectorType = form.watch("connectorType");

  const handleSubmit = async (values: CreateConnectorFormValues) => {
    const result = await createConnector.mutateAsync({
      name: values.name,
      connectorType: values.connectorType,
      config:
        values.config as archestraApiTypes.CreateConnectorData["body"]["config"],
      credentials: {
        email: values.email,
        apiToken: values.apiToken,
      },
      schedule: values.schedule,
    });
    if (result) {
      form.reset();
      onOpenChange(false);
    }
  };

  const handleClose = (open: boolean) => {
    if (!open) {
      form.reset();
    }
    onOpenChange(open);
  };

  const urlFieldName =
    connectorType === "jira" ? "config.jiraBaseUrl" : "config.confluenceUrl";
  const urlPlaceholder =
    connectorType === "jira"
      ? "https://your-domain.atlassian.net"
      : "https://your-domain.atlassian.net/wiki";

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add Connector</DialogTitle>
          <DialogDescription>
            Configure a connector to sync data into this knowledge base.
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
                    <Input
                      placeholder="Engineering Jira Connector"
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="connectorType"
              rules={{ required: "Connector type is required" }}
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Connector Type</FormLabel>
                  <Select
                    onValueChange={(value) => {
                      field.onChange(value);
                      form.setValue("config", {
                        type: value,
                        isCloud: true,
                      });
                    }}
                    defaultValue={field.value}
                  >
                    <FormControl>
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder="Select connector type" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="jira">Jira</SelectItem>
                      <SelectItem value="confluence">Confluence</SelectItem>
                    </SelectContent>
                  </Select>
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

            <FormField
              control={form.control}
              name="email"
              rules={{ required: "Email is required" }}
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Email</FormLabel>
                  <FormControl>
                    <Input
                      type="email"
                      placeholder="user@example.com"
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="apiToken"
              rules={{ required: "API token is required" }}
              render={({ field }) => (
                <FormItem>
                  <FormLabel>API Token</FormLabel>
                  <FormControl>
                    <Input
                      type="password"
                      placeholder="Your API token"
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <SchedulePicker form={form} name="schedule" />

            <Collapsible>
              <CollapsibleTrigger className="flex w-full items-center justify-between cursor-pointer group rounded-lg border p-3">
                <span className="text-sm font-medium">Advanced</span>
                <ChevronDown className="h-4 w-4 text-muted-foreground transition-transform duration-200 group-data-[state=open]:rotate-180" />
              </CollapsibleTrigger>
              <CollapsibleContent className="pt-4">
                {connectorType === "jira" && (
                  <JiraConfigFields form={form} hideUrl />
                )}
                {connectorType === "confluence" && (
                  <ConfluenceConfigFields form={form} hideUrl />
                )}
              </CollapsibleContent>
            </Collapsible>

            <DialogFooter>
              <Button type="submit" disabled={createConnector.isPending}>
                {createConnector.isPending ? "Creating..." : "Create Connector"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
