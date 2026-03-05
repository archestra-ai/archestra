"use client";

import type { archestraApiTypes } from "@shared";
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
import { useCreateConnector } from "@/lib/connector.query";
import { ConfluenceConfigFields } from "./confluence-config-fields";
import { ConnectorTypeIcon } from "./connector-icons";
import { JiraConfigFields } from "./jira-config-fields";
import { SchedulePicker } from "./schedule-picker";

type ConnectorType = "jira" | "confluence";

const CONNECTOR_OPTIONS: {
  type: ConnectorType;
  label: string;
  description: string;
}[] = [
  {
    type: "jira",
    label: "Jira",
    description: "Sync issues and projects from Jira",
  },
  {
    type: "confluence",
    label: "Confluence",
    description: "Sync pages and spaces from Confluence",
  },
];

interface CreateConnectorFormValues {
  name: string;
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
    form.setValue("config", { type, isCloud: true });
    setStep("configure");
  };

  const handleBack = () => {
    setStep("select");
  };

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

  const urlFieldName =
    connectorType === "jira" ? "config.jiraBaseUrl" : "config.confluenceUrl";
  const urlPlaceholder =
    connectorType === "jira"
      ? "https://your-domain.atlassian.net"
      : "https://your-domain.atlassian.net/wiki";

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-xl max-h-[85vh] overflow-y-auto">
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
          <>
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
                {CONNECTOR_OPTIONS.find((o) => o.type === selectedType)?.label}{" "}
                Connector
              </DialogTitle>
              <DialogDescription>
                Enter the connection details for your{" "}
                {CONNECTOR_OPTIONS.find((o) => o.type === selectedType)?.label}{" "}
                instance.
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
                  <Button type="button" variant="outline" onClick={handleBack}>
                    Back
                  </Button>
                  <Button type="submit" disabled={createConnector.isPending}>
                    {createConnector.isPending
                      ? "Creating..."
                      : "Create Connector"}
                  </Button>
                </DialogFooter>
              </form>
            </Form>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
