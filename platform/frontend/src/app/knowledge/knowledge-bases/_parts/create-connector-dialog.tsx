"use client";

import { type archestraApiTypes, getConnectorNamePlaceholder } from "@shared";
import { ArrowLeft, ChevronDown } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import { type Path, useForm } from "react-hook-form";
import { KnowledgeSourceVisibilitySelector } from "@/app/knowledge/_parts/knowledge-source-visibility-selector";
import { ExternalDocsLink } from "@/components/external-docs-link";
import { SearchInput } from "@/components/search-input";
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
import { useCreateConnector } from "@/lib/knowledge/connector.query";
import {
  CONNECTOR_OPTIONS,
  ConnectorAdvancedConfigFields,
  ConnectorInlineConfigFields,
  type ConnectorType,
  connectorNeedsEmail,
  getConnectorCredentialConfig,
  getConnectorDocsUrl,
  getConnectorTypeLabel,
  getConnectorUrlConfig,
  getDefaultConnectorConfig,
} from "./connector-dialog-config";
import { ConnectorTypeIcon } from "./connector-icons";
import { SchedulePicker } from "./schedule-picker";
import { transformConfigArrayFields } from "./transform-config-array-fields";

type CreateConnectorFormValues = {
  name: string;
  description: string;
  connectorType: ConnectorType;
  config: Record<string, unknown>;
  email: string;
  apiToken: string;
  schedule: string;
};

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
  const searchRef = useRef<HTMLInputElement>(null);
  const createConnector = useCreateConnector();
  const [step, setStep] = useState<"select" | "configure">("select");
  const [selectedType, setSelectedType] = useState<ConnectorType | null>(null);
  const [visibility, setVisibility] = useState<ConnectorVisibility>("org-wide");
  const [teamIds, setTeamIds] = useState<string[]>([]);
  const [search, setSearch] = useState("");

  const filteredConnectorOptions = CONNECTOR_OPTIONS.filter((option) =>
    option.label.toLowerCase().includes(search.toLowerCase()),
  );

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
    form.setValue("config", getDefaultConnectorConfig(type));
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

  const urlConfig = getConnectorUrlConfig(connectorType);
  const isCloud = form.watch("config.isCloud") as boolean | undefined;
  const needsEmail = connectorNeedsEmail(connectorType);
  const emailRequired = needsEmail && isCloud !== false;
  const connectorDocsUrl = selectedType
    ? getConnectorDocsUrl(selectedType)
    : null;
  const {
    apiTokenHelpText,
    apiTokenLabel,
    apiTokenPlaceholder,
    apiTokenRequiredMessage,
  } = getConnectorCredentialConfig({
    type: connectorType,
    emailRequired,
    mode: "create",
  });

  useLayoutEffect(() => {
    if (open && step === "select") {
      // Wait for dialog animations to complete
      requestAnimationFrame(() => {
        searchRef.current?.focus();
      });
    }
  }, [open, step]);

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
                Select a Connector type to get started.
              </DialogDescription>
            </DialogHeader>
            <DialogBody className="pt-4">
              <SearchInput
                ref={searchRef}
                value={search}
                onSearchChange={setSearch}
                syncQueryParams={false}
                debounceMs={300}
                inputClassName="w-full bg-background/50 backdrop-blur-sm border-border/50 focus:border-primary/50 transition-colors pl-9"
              />
              <div className="grid grid-cols-2 gap-3 pt-4">
                {filteredConnectorOptions.length ? (
                  filteredConnectorOptions.map((option) => (
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
                  ))
                ) : (
                  <div className="col-span-2 flex flex-col items-center gap-2 rounded-lg border border-muted/50 p-5 text-center text-sm text-muted-foreground">
                    No connectors match your filters. Try adjusting your search.
                  </div>
                )}
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
                  {selectedType ? getConnectorTypeLabel(selectedType) : ""}{" "}
                  Connector
                </DialogTitle>
                <DialogDescription>
                  Enter the connection details for your{" "}
                  {selectedType ? getConnectorTypeLabel(selectedType) : ""}{" "}
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
                    name={
                      urlConfig.fieldName as Path<CreateConnectorFormValues>
                    }
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

                <ConnectorInlineConfigFields
                  connectorType={connectorType}
                  form={form}
                  mode="create"
                  emailRequired={emailRequired}
                />

                {connectorType === "file_upload" && (
                  <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
                    After creating the connector, you can upload text files or
                    ZIP archives directly from the connector page.
                  </div>
                )}

                {Boolean(apiTokenLabel) && (
                  <>
                    <FormField
                      control={form.control}
                      name="apiToken"
                      rules={{ required: apiTokenRequiredMessage }}
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
                          mode="create"
                        />
                      </CollapsibleContent>
                    </Collapsible>
                  </>
                )}
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
