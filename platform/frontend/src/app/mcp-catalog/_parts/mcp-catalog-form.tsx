"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import type { archestraApiTypes } from "@shared";
import { AlertCircle, ChevronRight, Plus, X } from "lucide-react";
import { lazy, useEffect, useRef, useState } from "react";
import { useFieldArray, useForm } from "react-hook-form";
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
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";
import { useFeatureFlag, useFeatureValue } from "@/lib/features.hook";
import { useGetSecret } from "@/lib/secrets.query";
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
  serverType?: "remote" | "local";
  footer?: React.ReactNode;
  nameDisabled?: boolean;
}

export function McpCatalogForm({
  mode,
  initialValues,
  onSubmit,
  nameDisabled,
  serverType = "remote",
  footer,
}: McpCatalogFormProps) {
  // Fetch local config secret if it exists
  const { data: localConfigSecret } = useGetSecret(
    initialValues?.localConfigSecretId ?? null,
  );

  // Get MCP server base image from backend features endpoint
  const mcpServerBaseImage = useFeatureValue("mcpServerBaseImage") ?? "";

  const form = useForm<McpCatalogFormValues>({
    // biome-ignore lint/suspicious/noExplicitAny: Version mismatch between @hookform/resolvers and Zod
    resolver: zodResolver(formSchema as any),
    defaultValues: initialValues
      ? transformCatalogItemToFormValues(initialValues, undefined)
      : {
          name: "",
          serverType: serverType,
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
            dockerImage: "",
            transportType: "stdio",
            httpPort: "",
            httpPath: "/mcp",
            serviceAccount: "",
            imagePullSecrets: [],
          },
        },
  });

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
  const [labels, setLabels] = useState<ProfileLabel[]>(
    initialValues?.labels?.map((l) => ({ key: l.key, value: l.value })) ?? [],
  );
  const [labelsOpen, setLabelsOpen] = useState(false);
  const labelsRef = useRef<ProfileLabelsRef>(null);

  // Check if BYOS feature is available (enterprise license)
  const showByosOption = useFeatureFlag("byosEnabled");

  // Use field array for environment variables
  const { fields, append, remove } = useFieldArray({
    control: form.control,
    name: "localConfig.environment",
  });

  // Use field array for imagePullSecrets
  const {
    fields: imagePullSecretFields,
    append: appendImagePullSecret,
    remove: removeImagePullSecret,
  } = useFieldArray({
    control: form.control,
    name: "localConfig.imagePullSecrets",
  });
  const imagePullSecretInputRef = useRef<HTMLInputElement>(null);

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
      <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-6">
        {mode === "edit" && (
          <Alert>
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>
              Changes to {nameDisabled ? "" : "Name, "}Server URL or
              Authentication will require reinstalling the server for the
              changes to take effect.
            </AlertDescription>
          </Alert>
        )}

        <div className="space-y-4">
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
                <FormDescription>Display name for this server</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

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
                  <FormDescription>
                    The remote MCP server endpoint
                  </FormDescription>
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
                    <FormLabel>
                      Command{" "}
                      {!form.watch("localConfig.dockerImage") && (
                        <span className="text-destructive">*</span>
                      )}
                    </FormLabel>
                    <FormControl>
                      <Input
                        placeholder="node"
                        className="font-mono"
                        {...field}
                      />
                    </FormControl>
                    <FormDescription>
                      The executable command to run. Optional if Docker Image is
                      set (will use image's default <code>CMD</code>).
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="localConfig.dockerImage"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Docker Image (optional)</FormLabel>
                    <FormControl>
                      <Input
                        placeholder={mcpServerBaseImage}
                        className="font-mono"
                        {...field}
                      />
                    </FormControl>
                    <FormDescription>
                      Use your own image if you need additional packages, or
                      just want to deploy your own MCP server. See the{" "}
                      <a
                        href="https://github.com/archestra-ai/archestra/tree/main/platform/mcp_server_docker_image"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-primary underline hover:no-underline"
                      >
                        Dockerfile
                      </a>{" "}
                      for what's included in the default image (alpine, npx,
                      mcp[cli]).
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
                    <FormDescription>
                      Command line arguments, one per line
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <EnvironmentVariablesFormField
                control={form.control}
                fields={fields}
                append={append}
                remove={remove}
                fieldNamePrefix="localConfig.environment"
                form={form}
                useExternalSecretsManager={showByosOption}
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
                          <RadioGroupItem value="stdio" id="transport-stdio" />
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
                    <FormDescription>
                      stdio uses JSON-RPC over stdin/stdout (serialized
                      requests). Streamable HTTP uses native HTTP/SSE transport
                      (better performance, concurrent requests).
                    </FormDescription>
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
                        <FormDescription>
                          Port for HTTP server (defaults to 8080 if not
                          specified)
                        </FormDescription>
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
                        <FormDescription>
                          Endpoint path for MCP requests (defaults to /mcp)
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </>
              )}

              <div className="space-y-2">
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
                {imagePullSecretFields.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {imagePullSecretFields.map((field, index) => (
                      <div
                        key={field.id}
                        className="flex items-center gap-1 bg-muted rounded-md px-2 py-1 text-sm"
                      >
                        <span className="font-mono">{field.name}</span>
                        <button
                          type="button"
                          onClick={() => removeImagePullSecret(index)}
                          className="text-muted-foreground hover:text-destructive"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <div className="flex gap-2">
                  <Input
                    ref={imagePullSecretInputRef}
                    placeholder="secret-name"
                    className="font-mono"
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        const input = e.currentTarget;
                        const value = input.value.trim();
                        if (
                          value &&
                          !imagePullSecretFields.some((f) => f.name === value)
                        ) {
                          appendImagePullSecret({ name: value });
                          input.value = "";
                        }
                      }
                    }}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      const input = imagePullSecretInputRef.current;
                      const value = input?.value.trim();
                      if (
                        value &&
                        !imagePullSecretFields.some((f) => f.name === value)
                      ) {
                        appendImagePullSecret({ name: value });
                        if (input) input.value = "";
                      }
                    }}
                  >
                    <Plus className="h-4 w-4 mr-1" />
                    Add
                  </Button>
                </div>
              </div>
            </>
          )}
        </div>

        {currentServerType === "remote" && (
          <div className="space-y-4 pt-4 border-t">
            <FormLabel>Authentication</FormLabel>

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
                          No authorization
                        </FormLabel>
                      </div>
                      <div className="flex items-center space-x-2">
                        <RadioGroupItem value="bearer" id="auth-bearer" />
                        <FormLabel
                          htmlFor="auth-bearer"
                          className="font-normal cursor-pointer"
                        >
                          "Authorization: Bearer &lt;your token&gt;" header
                        </FormLabel>
                      </div>
                      <div className="flex items-center space-x-2">
                        <RadioGroupItem value="raw_token" id="auth-raw-token" />
                        <FormLabel
                          htmlFor="auth-raw-token"
                          className="font-normal cursor-pointer"
                        >
                          "Authorization: &lt;your token&gt;" header
                        </FormLabel>
                      </div>
                      <div className="flex items-center space-x-2">
                        <RadioGroupItem value="oauth" id="auth-oauth" />
                        <FormLabel
                          htmlFor="auth-oauth"
                          className="font-normal cursor-pointer"
                        >
                          OAuth 2.0
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
                        Comma-separated list of OAuth scopes (defaults to read,
                        write)
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
                          /.well-known/oauth-authorization-server for automatic
                          endpoint discovery
                        </FormDescription>
                      </div>
                    </FormItem>
                  )}
                />
              </div>
            )}
          </div>
        )}

        <Collapsible open={labelsOpen} onOpenChange={setLabelsOpen}>
          <CollapsibleTrigger className="flex items-center gap-2 text-sm font-medium hover:text-foreground text-muted-foreground transition-colors pt-4 border-t w-full">
            <ChevronRight
              className={`h-4 w-4 transition-transform ${labelsOpen ? "rotate-90" : ""}`}
            />
            Labels
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

        {footer}
      </form>
    </Form>
  );
}
