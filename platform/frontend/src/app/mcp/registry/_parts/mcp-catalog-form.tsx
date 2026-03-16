"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import type { archestraApiTypes } from "@shared";
import {
  ChevronRight,
  Globe,
  Info,
  Lock,
  Plus,
  Server,
  Trash2,
  Users,
} from "lucide-react";
import { lazy, useEffect, useMemo, useRef, useState } from "react";
import { useFieldArray, useForm } from "react-hook-form";
import { AgentIconPicker } from "@/components/agent-icon-picker";
import {
  type ProfileLabel,
  ProfileLabels,
  type ProfileLabelsRef,
} from "@/components/agent-labels";
import { EnvironmentVariablesFormField } from "@/components/environment-variables-form-field";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { Label } from "@/components/ui/label";
import { MultiSelectCombobox } from "@/components/ui/multi-select-combobox";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { SearchableSelect } from "@/components/ui/searchable-select";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  type VisibilityOption,
  VisibilitySelector,
} from "@/components/visibility-selector";
import { LOCAL_MCP_DISABLED_MESSAGE } from "@/consts";
import { useHasPermissions } from "@/lib/auth.query";
import { useFeature } from "@/lib/config.query";
import { useK8sImagePullSecrets } from "@/lib/internal-mcp-catalog.query";
import { useGetSecret } from "@/lib/secrets.query";
import { useTeams } from "@/lib/team.query";
import {
  formSchema,
  type McpCatalogFormValues,
} from "./mcp-catalog-form.types";
import { transformCatalogItemToFormValues } from "./mcp-catalog-form.utils";

const ExternalSecretSelector = lazy(
  () =>
    // biome-ignore lint/style/noRestrictedImports: lazy loading
    import("@/components/external-secret-selector.ee"),
);

interface McpCatalogFormProps {
  mode: "create" | "edit";
  initialValues?: archestraApiTypes.GetInternalMcpCatalogResponses["200"][number];
  onSubmit: (values: McpCatalogFormValues) => void;
  footer?:
    | React.ReactNode
    | ((opts: { isDirty: boolean; onReset: () => void }) => React.ReactNode);
  nameDisabled?: boolean;
  catalogButton?: React.ReactNode;
  formValues?: McpCatalogFormValues;
  /** Called when form dirty state changes */
  onDirtyChange?: (isDirty: boolean) => void;
  /** Ref to imperatively trigger form submission */
  submitRef?: React.MutableRefObject<(() => Promise<void>) | null>;
  embedded?: boolean;
}

export function McpCatalogForm({
  mode,
  initialValues,
  onSubmit,
  nameDisabled,
  footer,
  catalogButton,
  formValues,
  onDirtyChange,
  submitRef,
  embedded = false,
}: McpCatalogFormProps) {
  // Fetch local config secret if it exists
  const { data: localConfigSecret } = useGetSecret(
    initialValues?.localConfigSecretId ?? null,
  );

  // Get MCP server base image from backend features endpoint
  const mcpServerBaseImage = useFeature("mcpServerBaseImage") ?? "";

  const isLocalMcpEnabled = useFeature("orchestratorK8sRuntime");

  const form = useForm<McpCatalogFormValues>({
    // biome-ignore lint/suspicious/noExplicitAny: Version mismatch between @hookform/resolvers and Zod
    resolver: zodResolver(formSchema as any),
    defaultValues: initialValues
      ? transformCatalogItemToFormValues(initialValues, undefined)
      : (formValues ?? {
          name: "",
          description: "",
          icon: null,
          serverType: "remote",
          serverUrl: "",
          authMethod: "none",
          oauthConfig: {
            client_id: "",
            client_secret: "",
            redirect_uris:
              typeof window !== "undefined"
                ? `${window.location.origin}/oauth-callback`
                : "",
            scopes: "read, write",
            supports_resource_metadata: true,
          },
          localConfig: {
            command: "",
            arguments: "",
            environment: [],
            envFrom: [],
            dockerImage: "",
            transportType: "stdio",
            httpPort: "",
            httpPath: "/mcp",
            serviceAccount: "",
            imagePullSecrets: [],
          },
          scope: "personal",
          teams: [],
        }),
  });

  // Expose imperative submit to parent
  useEffect(() => {
    if (submitRef) {
      submitRef.current = form.handleSubmit(onSubmit) as () => Promise<void>;
    }
    return () => {
      if (submitRef) submitRef.current = null;
    };
  }, [submitRef, form, onSubmit]);

  const authMethod = form.watch("authMethod");
  const currentServerType = form.watch("serverType");

  // BYOS (Bring Your Own Secrets) state for OAuth
  const [oauthVaultTeamId, setOauthVaultTeamId] = useState<string | null>(null);
  const [oauthVaultSecretPath, setOauthVaultSecretPath] = useState<
    string | null
  >(null);
  const [oauthVaultSecretKey, setOauthVaultSecretKey] = useState<string | null>(
    null,
  );

  // Labels state (managed separately from react-hook-form)
  const initialLabels = useMemo(
    () =>
      initialValues?.labels?.map((l) => ({ key: l.key, value: l.value })) ?? [],
    [initialValues?.labels],
  );
  const [labels, setLabels] = useState<ProfileLabel[]>(initialLabels);
  const [labelsOpen, setLabelsOpen] = useState(false);
  const labelsRef = useRef<ProfileLabelsRef>(null);

  // Report dirty state to parent (includes label changes)
  const { isDirty: isFormDirty } = form.formState;
  const areLabelsChanged = useMemo(() => {
    if (labels.length !== initialLabels.length) return true;
    return labels.some(
      (l, i) =>
        l.key !== initialLabels[i].key || l.value !== initialLabels[i].value,
    );
  }, [labels, initialLabels]);
  const isDirty = isFormDirty || areLabelsChanged;
  useEffect(() => {
    onDirtyChange?.(isDirty);
  }, [isDirty, onDirtyChange]);

  // Check admin status for scope options
  const { data: isAdmin } = useHasPermissions({
    mcpServerInstallation: ["admin"],
  });
  const { data: teams } = useTeams();
  const currentScope = form.watch("scope");
  const visibilityOptions = useMemo<
    Array<VisibilityOption<"personal" | "team" | "org">>
  >(
    () => [
      {
        value: "personal",
        label: "Personal",
        description: "Only you can access this MCP server.",
        icon: Lock,
      },
      {
        value: "team",
        label: "Teams",
        description: "Share this MCP server with selected teams.",
        icon: Users,
        disabled: !isAdmin || !teams?.length,
        disabledReason: !isAdmin
          ? "Only admins can assign MCP servers to teams."
          : "Create a team first to share this MCP server.",
      },
      {
        value: "org",
        label: "Organization",
        description: "Anyone in your organization can access this MCP server.",
        icon: Globe,
        disabled: !isAdmin,
        disabledReason: "Only admins can make MCP servers organization-wide.",
      },
    ],
    [isAdmin, teams],
  );

  // Check if BYOS feature is available (enterprise license)
  const showByosOption = useFeature("byosEnabled");

  // Use field array for environment variables
  const { fields, append, remove } = useFieldArray({
    control: form.control,
    name: "localConfig.environment",
  });

  // Use field array for envFrom (existing K8s Secrets/ConfigMaps)
  const {
    fields: envFromFields,
    append: appendEnvFrom,
    remove: removeEnvFrom,
  } = useFieldArray({
    control: form.control,
    name: "localConfig.envFrom",
  });

  // Use field array for imagePullSecrets
  const {
    fields: imagePullSecretFields,
    append: appendImagePullSecret,
    remove: removeImagePullSecret,
    update: updateImagePullSecret,
  } = useFieldArray({
    control: form.control,
    name: "localConfig.imagePullSecrets",
  });

  // Fetch available k8s docker-registry secrets for the "existing" dropdown
  const { data: k8sSecrets = [] } = useK8sImagePullSecrets();

  // Update form values when BYOS paths/keys change
  useEffect(() => {
    form.setValue(
      "oauthClientSecretVaultPath",
      oauthVaultSecretPath || undefined,
    );
    form.setValue(
      "oauthClientSecretVaultKey",
      oauthVaultSecretKey || undefined,
    );
  }, [oauthVaultSecretPath, oauthVaultSecretKey, form]);

  // Reset form when formValues change (catalog pre-fill in create mode)
  useEffect(() => {
    if (formValues && !initialValues) {
      form.reset(formValues);
      setLabels(
        formValues.labels?.map((l) => ({ key: l.key, value: l.value })) ?? [],
      );
      setLabelsOpen((formValues.labels ?? []).length > 0);
    }
  }, [formValues, initialValues, form]);

  // Reset form when initial values change (for edit mode)
  // Also reset when localConfigSecret loads (if it exists)
  useEffect(() => {
    if (initialValues) {
      const transformedValues = transformCatalogItemToFormValues(
        initialValues,
        localConfigSecret ?? undefined,
      );
      form.reset(transformedValues);
      // Reset labels state
      setLabels(
        initialValues.labels?.map((l) => ({ key: l.key, value: l.value })) ??
          [],
      );
      // Auto-expand labels section if there are existing labels
      setLabelsOpen((initialValues.labels ?? []).length > 0);
      // Initialize OAuth BYOS state from transformed values (parsed vault references)
      // Note: teamId cannot be derived from path, so we leave it null (user can reselect if needed)
      setOauthVaultTeamId(null);
      setOauthVaultSecretPath(
        transformedValues.oauthClientSecretVaultPath || null,
      );
      setOauthVaultSecretKey(
        transformedValues.oauthClientSecretVaultKey || null,
      );
    }
  }, [initialValues, localConfigSecret, form]);

  const handleSubmit = (values: McpCatalogFormValues) => {
    // Save any unsaved label before submitting
    const updatedLabels = labelsRef.current?.saveUnsavedLabel() || labels;
    onSubmit({ ...values, labels: updatedLabels });
  };

  return (
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit(handleSubmit)}
        className="flex min-h-0 flex-1 flex-col"
      >
        <div
          className={`min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-4 ${embedded ? "space-y-4 pt-4 pb-0" : "space-y-4 py-4"}`}
        >
          {mode === "edit" && (
            <Alert variant="info">
              <Info className="h-4 w-4" />
              <AlertDescription>
                Changes to {nameDisabled ? "" : "Name, "}Server URL or
                Authentication will require reinstalling the server for the
                changes to take effect.
              </AlertDescription>
            </Alert>
          )}

          {catalogButton}

          <div className="border rounded-lg p-5 space-y-4">
            <AgentIconPicker
              value={form.watch("icon") ?? null}
              fallbackType="server"
              onChange={(icon) =>
                form.setValue("icon", icon, { shouldDirty: true })
              }
              showLogos
            />
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    Name <span className="text-destructive">*</span>
                  </FormLabel>
                  <FormControl>
                    <Input
                      placeholder="e.g., GitHub MCP Server"
                      {...field}
                      disabled={nameDisabled}
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
                  <FormLabel>Description</FormLabel>
                  <FormControl>
                    <Textarea
                      placeholder="Describe what this MCP server does..."
                      className="min-h-20"
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="scope"
              render={({ field }) => (
                <FormItem>
                  <FormControl>
                    <VisibilitySelector
                      value={
                        (field.value ?? "personal") as
                          | "personal"
                          | "team"
                          | "org"
                      }
                      options={visibilityOptions}
                      onValueChange={(value) => {
                        field.onChange(value);
                        if (value !== "team") {
                          form.setValue("teams", [], { shouldDirty: true });
                        }
                      }}
                    >
                      {currentScope === "team" && (
                        <div className="space-y-2">
                          <Label>Teams</Label>
                          <MultiSelectCombobox
                            options={
                              teams?.map((t) => ({
                                label: t.name,
                                value: t.id,
                              })) ?? []
                            }
                            value={form.watch("teams") ?? []}
                            onChange={(ids) =>
                              form.setValue("teams", ids, { shouldDirty: true })
                            }
                            placeholder="Select teams..."
                            emptyMessage="No teams found"
                          />
                        </div>
                      )}
                    </VisibilitySelector>
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {mode === "create" && (
              <div className="space-y-2">
                <Label>Server Type</Label>
                <div className="flex rounded-lg border border-border overflow-hidden">
                  <button
                    type="button"
                    onClick={() => form.setValue("serverType", "remote")}
                    className={`flex-1 flex flex-col items-center justify-center gap-0.5 px-4 py-2 text-sm font-medium transition-colors ${
                      currentServerType === "remote"
                        ? "bg-primary text-primary-foreground"
                        : "bg-background text-muted-foreground hover:text-foreground hover:bg-muted"
                    }`}
                  >
                    <span className="flex items-center gap-2">
                      <Globe className="h-4 w-4" />
                      Remote
                    </span>
                    <span
                      className={`text-xs font-normal ${currentServerType === "remote" ? "text-primary-foreground/70" : "text-muted-foreground"}`}
                    >
                      Orchestrated externally
                    </span>
                  </button>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        onClick={() =>
                          isLocalMcpEnabled &&
                          form.setValue("serverType", "local")
                        }
                        disabled={!isLocalMcpEnabled}
                        className={`flex-1 flex flex-col items-center justify-center gap-0.5 px-4 py-2 text-sm font-medium transition-colors border-l border-border ${
                          !isLocalMcpEnabled
                            ? "bg-background text-muted-foreground/50 cursor-not-allowed"
                            : currentServerType === "local"
                              ? "bg-primary text-primary-foreground"
                              : "bg-background text-muted-foreground hover:text-foreground hover:bg-muted"
                        }`}
                      >
                        <span className="flex items-center gap-2">
                          <Server className="h-4 w-4" />
                          Self-hosted
                        </span>
                        <span
                          className={`text-xs font-normal ${!isLocalMcpEnabled ? "text-muted-foreground/50" : currentServerType === "local" ? "text-primary-foreground/70" : "text-muted-foreground"}`}
                        >
                          Orchestrated by Archestra in k8s
                        </span>
                      </button>
                    </TooltipTrigger>
                    {!isLocalMcpEnabled && (
                      <TooltipContent>
                        <p className="max-w-xs">{LOCAL_MCP_DISABLED_MESSAGE}</p>
                      </TooltipContent>
                    )}
                  </Tooltip>
                </div>
              </div>
            )}
          </div>

          <div className="border rounded-lg p-5 space-y-4">
            <h3 className="font-semibold text-sm">Server Configuration</h3>

            {currentServerType === "remote" && (
              <FormField
                control={form.control}
                name="serverUrl"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      Server URL <span className="text-destructive">*</span>
                    </FormLabel>
                    <FormControl>
                      <Input
                        placeholder="https://api.example.com/mcp"
                        className="font-mono"
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}

            {currentServerType === "local" && (
              <>
                <FormField
                  control={form.control}
                  name="localConfig.command"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Command</FormLabel>
                      <FormControl>
                        <Input
                          placeholder="node"
                          className="font-mono"
                          {...field}
                        />
                      </FormControl>
                      <FormDescription>
                        The executable command to run. Optional if Docker Image
                        is set (will use image's default <code>CMD</code>).
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="localConfig.arguments"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Arguments (one per line)</FormLabel>
                      <FormControl>
                        <Textarea
                          placeholder={`/path/to/server.js\n--verbose`}
                          className="font-mono min-h-20"
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="localConfig.transportType"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Transport Type</FormLabel>
                      <FormControl>
                        <RadioGroup
                          onValueChange={field.onChange}
                          value={field.value || "stdio"}
                          className="space-y-2"
                        >
                          <div className="flex items-center space-x-2">
                            <RadioGroupItem
                              value="stdio"
                              id="transport-stdio"
                            />
                            <FormLabel
                              htmlFor="transport-stdio"
                              className="font-normal cursor-pointer"
                            >
                              stdio (default)
                            </FormLabel>
                          </div>
                          <div className="flex items-center space-x-2">
                            <RadioGroupItem
                              value="streamable-http"
                              id="transport-http"
                            />
                            <FormLabel
                              htmlFor="transport-http"
                              className="font-normal cursor-pointer"
                            >
                              Streamable HTTP
                            </FormLabel>
                          </div>
                        </RadioGroup>
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                {form.watch("localConfig.transportType") ===
                  "streamable-http" && (
                  <>
                    <FormField
                      control={form.control}
                      name="localConfig.httpPort"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>HTTP Port (optional)</FormLabel>
                          <FormControl>
                            <Input
                              type="number"
                              placeholder="8080"
                              className="font-mono"
                              {...field}
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name="localConfig.httpPath"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>HTTP Path (optional)</FormLabel>
                          <FormControl>
                            <Input
                              placeholder="/mcp"
                              className="font-mono"
                              {...field}
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </>
                )}
              </>
            )}
          </div>

          {currentServerType === "local" && (
            <div className="border rounded-lg p-5 space-y-4">
              <EnvironmentVariablesFormField
                control={form.control}
                fields={fields}
                append={append}
                remove={remove}
                fieldNamePrefix="localConfig.environment"
                form={form}
                useExternalSecretsManager={showByosOption}
                envFrom={{
                  fields: envFromFields,
                  append: appendEnvFrom,
                  remove: removeEnvFrom,
                  watch: form.watch,
                  setValue: form.setValue,
                  register: form.register,
                  fieldNamePrefix: "localConfig.envFrom",
                }}
              />
            </div>
          )}

          {currentServerType === "local" && (
            <div className="border rounded-lg p-5 space-y-4">
              <h3 className="font-semibold text-sm">Docker</h3>

              <FormField
                control={form.control}
                name="localConfig.dockerImage"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Image (optional)</FormLabel>
                    <FormControl>
                      <Input
                        placeholder={mcpServerBaseImage}
                        className="font-mono"
                        {...field}
                      />
                    </FormControl>
                    <FormDescription>
                      <a
                        href="https://github.com/archestra-ai/archestra/tree/main/platform/mcp_server_docker_image"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-primary underline hover:no-underline"
                      >
                        Default image
                      </a>{" "}
                      includes alpine, npx, mcp[cli]. Use custom for additional
                      packages.
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <div className="space-y-3">
                <Label>Image Pull Secrets</Label>
                <p className="text-sm text-muted-foreground">
                  Kubernetes secrets for pulling container images from private
                  registries.{" "}
                  <a
                    href="https://kubernetes.io/docs/tasks/configure-pod-container/pull-image-private-registry/"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary underline underline-offset-2 hover:text-primary/80"
                  >
                    Learn more
                  </a>
                </p>

                {imagePullSecretFields.map((field, index) => {
                  const watchField = (key: string) =>
                    form.watch(
                      // biome-ignore lint/suspicious/noExplicitAny: discriminated union paths need cast
                      `localConfig.imagePullSecrets.${index}.${key}` as any,
                    ) ?? "";
                  const setField = (key: string, value: string) =>
                    form.setValue(
                      // biome-ignore lint/suspicious/noExplicitAny: discriminated union paths need cast
                      `localConfig.imagePullSecrets.${index}.${key}` as any,
                      value,
                    );
                  const source = watchField("source");

                  return (
                    <div
                      key={field.id}
                      className="border rounded-lg p-3 space-y-3"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <Select
                          value={source}
                          onValueChange={(val) => {
                            if (val === "existing") {
                              updateImagePullSecret(index, {
                                source: "existing",
                                name: "",
                              });
                            } else {
                              updateImagePullSecret(index, {
                                source: "credentials",
                                server: "",
                                username: "",
                                email: "",
                              });
                            }
                          }}
                        >
                          <SelectTrigger className="w-[200px]">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="existing">
                              Existing Secret
                            </SelectItem>
                            <SelectItem value="credentials">
                              Registry Credentials
                            </SelectItem>
                          </SelectContent>
                        </Select>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          onClick={() => removeImagePullSecret(index)}
                        >
                          <Trash2 className="h-4 w-4 text-muted-foreground hover:text-destructive" />
                        </Button>
                      </div>

                      {source === "existing" ? (
                        <SearchableSelect
                          value={watchField("name")}
                          onValueChange={(val) => setField("name", val)}
                          items={k8sSecrets.map((s) => ({
                            value: s.name,
                            label: s.name,
                          }))}
                          placeholder="Select a secret..."
                          searchPlaceholder="Search secrets..."
                          allowCustom
                          className="w-full"
                        />
                      ) : (
                        <div className="grid grid-cols-2 gap-3">
                          <div className="space-y-1">
                            <Label className="text-xs">Server</Label>
                            <Input
                              placeholder="e.g. quay.io"
                              className="font-mono"
                              value={watchField("server")}
                              onChange={(e) =>
                                setField("server", e.target.value)
                              }
                            />
                          </div>
                          <div className="space-y-1">
                            <Label className="text-xs">Username</Label>
                            <Input
                              placeholder="username"
                              value={watchField("username")}
                              onChange={(e) =>
                                setField("username", e.target.value)
                              }
                            />
                          </div>
                          <div className="space-y-1">
                            <Label className="text-xs">Password</Label>
                            <Input
                              type="password"
                              placeholder={
                                mode === "edit" && !watchField("password")
                                  ? "Saved — leave blank to keep"
                                  : "password"
                              }
                              value={watchField("password") ?? ""}
                              onChange={(e) =>
                                setField("password", e.target.value)
                              }
                            />
                          </div>
                          <div className="space-y-1">
                            <Label className="text-xs">Email (optional)</Label>
                            <Input
                              placeholder="email@example.com"
                              value={watchField("email")}
                              onChange={(e) =>
                                setField("email", e.target.value)
                              }
                            />
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}

                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    appendImagePullSecret({ source: "existing", name: "" })
                  }
                >
                  <Plus className="h-4 w-4 mr-1" />
                  Add
                </Button>
              </div>
            </div>
          )}

          {(currentServerType === "remote" ||
            currentServerType === "local") && (
            <div className="border rounded-lg p-5 space-y-4">
              <h3 className="font-semibold text-sm">
                Multitenant Authorization
              </h3>
              <FormField
                control={form.control}
                name="authMethod"
                render={({ field }) => (
                  <FormItem>
                    <FormControl>
                      <RadioGroup
                        onValueChange={field.onChange}
                        value={field.value}
                        className="space-y-2"
                      >
                        <div className="flex items-center space-x-2">
                          <RadioGroupItem value="none" id="auth-none" />
                          <FormLabel
                            htmlFor="auth-none"
                            className="font-normal cursor-pointer"
                          >
                            None (e.g. static API key via environment variables)
                          </FormLabel>
                        </div>
                        {currentServerType === "remote" && (
                          <>
                            <div className="flex items-center space-x-2">
                              <RadioGroupItem value="bearer" id="auth-bearer" />
                              <FormLabel
                                htmlFor="auth-bearer"
                                className="font-normal cursor-pointer"
                              >
                                "Authorization: Bearer &lt;your token&gt;"
                                header
                              </FormLabel>
                            </div>
                            <div className="flex items-center space-x-2">
                              <RadioGroupItem
                                value="raw_token"
                                id="auth-raw-token"
                              />
                              <FormLabel
                                htmlFor="auth-raw-token"
                                className="font-normal cursor-pointer"
                              >
                                "Authorization: &lt;your token&gt;" header
                              </FormLabel>
                            </div>
                          </>
                        )}
                        <div className="flex items-center space-x-2">
                          <RadioGroupItem value="oauth" id="auth-oauth" />
                          <FormLabel
                            htmlFor="auth-oauth"
                            className="font-normal cursor-pointer"
                          >
                            OAuth 2.0 (recommended)
                          </FormLabel>
                        </div>
                      </RadioGroup>
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {(authMethod === "bearer" || authMethod === "raw_token") && (
                <div className="bg-muted p-4 rounded-lg">
                  <p className="text-sm text-muted-foreground">
                    Users will be prompted to provide their access token when
                    installing this server.
                  </p>
                </div>
              )}

              {authMethod === "oauth" && (
                <div className="space-y-4 pl-6 border-l-2">
                  {currentServerType === "local" && (
                    <FormField
                      control={form.control}
                      name="oauthConfig.oauthServerUrl"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>
                            OAuth Server URL{" "}
                            <span className="text-destructive">*</span>
                          </FormLabel>
                          <FormControl>
                            <Input
                              placeholder="https://auth.example.com"
                              className="font-mono"
                              {...field}
                            />
                          </FormControl>
                          <FormDescription>
                            The OAuth server endpoint used for authorization and
                            token exchange. This is separate from the
                            K8s-deployed server.
                          </FormDescription>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  )}

                  <FormField
                    control={form.control}
                    name="oauthConfig.client_id"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Client ID</FormLabel>
                        <FormControl>
                          <Input
                            placeholder="your-client-id (optional for dynamic registration)"
                            className="font-mono"
                            {...field}
                          />
                        </FormControl>
                        <FormDescription>
                          Leave empty if the server supports dynamic client
                          registration
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  {/* BYOS: External Secret Selector for OAuth Client Secret */}
                  {showByosOption ? (
                    <div className="space-y-2">
                      <Label>Client Secret</Label>
                      <ExternalSecretSelector
                        selectedTeamId={oauthVaultTeamId}
                        selectedSecretPath={oauthVaultSecretPath}
                        selectedSecretKey={oauthVaultSecretKey}
                        onTeamChange={setOauthVaultTeamId}
                        onSecretChange={setOauthVaultSecretPath}
                        onSecretKeyChange={setOauthVaultSecretKey}
                      />
                    </div>
                  ) : (
                    <FormField
                      control={form.control}
                      name="oauthConfig.client_secret"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Client Secret</FormLabel>
                          <FormControl>
                            <Input
                              type="password"
                              placeholder="your-client-secret (optional)"
                              className="font-mono"
                              {...field}
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  )}

                  <FormField
                    control={form.control}
                    name="oauthConfig.redirect_uris"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>
                          Redirect URIs{" "}
                          <span className="text-destructive">*</span>
                        </FormLabel>
                        <FormControl>
                          <Input
                            placeholder="https://localhost:3000/oauth-callback, https://app.example.com/oauth-callback"
                            className="font-mono"
                            {...field}
                          />
                        </FormControl>
                        <FormDescription>
                          Comma-separated list of redirect URIs
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="oauthConfig.scopes"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Scopes</FormLabel>
                        <FormControl>
                          <Input
                            placeholder="read, write"
                            className="font-mono"
                            {...field}
                          />
                        </FormControl>
                        <FormDescription>
                          Comma-separated list of OAuth scopes (defaults to
                          read, write)
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="oauthConfig.supports_resource_metadata"
                    render={({ field }) => (
                      <FormItem className="flex flex-row items-start space-x-2 space-y-0">
                        <FormControl>
                          <Checkbox
                            checked={field.value}
                            onCheckedChange={field.onChange}
                            className="mt-1"
                          />
                        </FormControl>
                        <div className="space-y-1 leading-none">
                          <FormLabel className="font-normal cursor-pointer">
                            Supports OAuth Resource Metadata
                          </FormLabel>
                          <FormDescription>
                            Enable if the server publishes OAuth metadata at
                            /.well-known/oauth-authorization-server for
                            automatic endpoint discovery
                          </FormDescription>
                        </div>
                      </FormItem>
                    )}
                  />
                </div>
              )}
            </div>
          )}

          <div className={`border rounded-lg p-5 ${embedded ? "mb-4" : ""}`}>
            <Collapsible open={labelsOpen} onOpenChange={setLabelsOpen}>
              <CollapsibleTrigger className="flex items-center gap-2 text-sm font-semibold hover:text-foreground text-foreground transition-colors w-full">
                <ChevronRight
                  className={`h-4 w-4 transition-transform ${labelsOpen ? "rotate-90" : ""}`}
                />
                Labels
                <span className="text-xs font-normal text-muted-foreground ml-1">
                  Organize, filter and search servers
                </span>
                {labels.length > 0 && (
                  <span className="text-xs bg-muted px-1.5 py-0.5 rounded-full">
                    {labels.length}
                  </span>
                )}
              </CollapsibleTrigger>
              <CollapsibleContent className="pt-4">
                <ProfileLabels
                  ref={labelsRef}
                  labels={labels}
                  onLabelsChange={setLabels}
                  showLabel={false}
                />
              </CollapsibleContent>
            </Collapsible>
          </div>
        </div>

        {typeof footer === "function"
          ? footer({
              isDirty,
              onReset: () => {
                form.reset();
                setLabels(initialLabels);
              },
            })
          : footer}
      </form>
    </Form>
  );
}
