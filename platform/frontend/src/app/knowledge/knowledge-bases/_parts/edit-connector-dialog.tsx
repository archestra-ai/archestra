"use client";

import { type archestraApiTypes, getConnectorNamePlaceholder } from "@shared";
import { ChevronDown } from "lucide-react";
import { useEffect, useState } from "react";
import { type Path, useForm } from "react-hook-form";
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
import { useUpdateConnector } from "@/lib/knowledge/connector.query";
import {
  ConnectorAdvancedConfigFields,
  ConnectorInlineConfigFields,
  connectorNeedsEmail,
  getConnectorCredentialConfig,
  getConnectorDocsUrl,
  getConnectorTypeLabel,
  getConnectorUrlConfig,
} from "./connector-dialog-config";
import { ConnectorTypeIcon } from "./connector-icons";
import { SchedulePicker } from "./schedule-picker";
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

type EditConnectorFormValues = {
  name: string;
  description: string;
  enabled: boolean;
  config: Record<string, unknown>;
  email: string;
  apiToken: string;
  schedule: string;
};

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
  const typeLabel = getConnectorTypeLabel(connectorType);
  const urlConfig = getConnectorUrlConfig(connectorType);
  const connectorDocsUrl = getConnectorDocsUrl(connectorType);

  const needsEmail = connectorNeedsEmail(connectorType);
  const isCloud = form.watch("config.isCloud") as boolean | undefined;
  const emailRequired = needsEmail && isCloud !== false;
  const { apiTokenHelpText, apiTokenLabel, apiTokenPlaceholder } =
    getConnectorCredentialConfig({
      type: connectorType,
      emailRequired,
      mode: "edit",
    });

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
              name={urlConfig.fieldName as Path<EditConnectorFormValues>}
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

          <ConnectorInlineConfigFields
            connectorType={connectorType}
            form={form}
            mode="edit"
            emailRequired={emailRequired}
          />

          <FormField
            control={form.control}
            name="apiToken"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{apiTokenLabel}</FormLabel>
                <FormControl>
                  <Input
                    type="password"
                    placeholder={apiTokenPlaceholder}
                    {...field}
                  />
                </FormControl>
                <FormDescription>
                  Leave empty to keep existing credentials unchanged.
                </FormDescription>
                {apiTokenHelpText}
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
              <ConnectorAdvancedConfigFields
                connectorType={connectorType}
                form={form}
                mode="edit"
              />
            </CollapsibleContent>
          </Collapsible>
        </div>
      </Form>
    </StandardFormDialog>
  );
}
