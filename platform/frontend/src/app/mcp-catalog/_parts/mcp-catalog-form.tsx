"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { type archestraApiTypes, MCP_ORCHESTRATOR_DEFAULTS } from "@shared";
import {
  AlertCircle,
  ChevronDown,
  ChevronRight,
  Settings2,
} from "lucide-react";
import { lazy, useCallback, useEffect, useState } from "react";
import { useFieldArray, useForm } from "react-hook-form";
import { Editor } from "@/components/editor";
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

/**
 * JSON editor for key-value pairs (labels, annotations).
 * Provides a Monaco editor with JSON syntax highlighting.
 */
function JsonKeyValueEditor({
  value,
  onChange,
  placeholder,
}: {
  value: string | undefined;
  onChange: (value: string) => void;
  placeholder: string;
}) {
  const handleEditorChange = useCallback(
    (newValue: string | undefined) => {
      onChange(newValue ?? "");
    },
    [onChange],
  );

  return (
    <div className="border rounded-md overflow-hidden">
      <Editor
        height="100px"
        defaultLanguage="json"
        value={value || ""}
        onChange={handleEditorChange}
        options={{
          minimap: { enabled: false },
          lineNumbers: "off",
          folding: false,
          scrollBeyondLastLine: false,
          wordWrap: "on",
          fontSize: 13,
          fontFamily: "monospace",
          padding: { top: 8, bottom: 8 },
          renderLineHighlight: "none",
          overviewRulerLanes: 0,
          hideCursorInOverviewRuler: true,
          scrollbar: {
            vertical: "auto",
            horizontal: "hidden",
            verticalScrollbarSize: 8,
          },
          placeholder,
        }}
      />
    </div>
  );
}

interface McpCatalogFormProps {
  mode: "create" | "edit";
  initialValues?: archestraApiTypes.GetInternalMcpCatalogResponses["200"][number];
  onSubmit: (values: McpCatalogFormValues) => void;
  serverType?: "remote" | "local";
  footer?: React.ReactNode;
}

export function McpCatalogForm({
  mode,
  initialValues,
  onSubmit,
  serverType = "remote",
  footer,
}: McpCatalogFormProps) {
  // Fetch local config secret if it exists
  const { data: localConfigSecret } = useGetSecret(
    initialValues?.localConfigSecretId ?? null,
  );

  // Get MCP server base image and K8s namespace from backend features endpoint
  const mcpServerBaseImage = useFeatureValue("mcpServerBaseImage") ?? "";
  const orchestratorK8sNamespace =
    useFeatureValue("orchestratorK8sNamespace") ?? "default";

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
            advancedK8sConfig: {
              replicas: "",
              namespace: "",
              annotations: "",
              labels: "",
              resourceRequestsMemory: "",
              resourceRequestsCpu: "",
              resourceLimitsMemory: "",
              resourceLimitsCpu: "",
            },
            serviceAccount: "",
          },
        },
  });

  // State for advanced configuration collapsed section
  const [advancedConfigOpen, setAdvancedConfigOpen] = useState(false);

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

  // Check if BYOS feature is available (enterprise license)
  const showByosOption = useFeatureFlag("byosEnabled");

  // Use field array for environment variables
  const { fields, append, remove } = useFieldArray({
    control: form.control,
    name: "localConfig.environment",
  });

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

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
        {mode === "edit" && (
          <Alert>
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>
              Changes to Name, Server URL, or Authentication will require
              reinstalling the server for the changes to take effect.
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
                  <Input placeholder="e.g., GitHub MCP Server" {...field} />
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

              {/* Advanced Kubernetes Configuration */}
              <Collapsible
                open={advancedConfigOpen}
                onOpenChange={setAdvancedConfigOpen}
                className="border rounded-lg"
              >
                <CollapsibleTrigger asChild>
                  <Button
                    variant="ghost"
                    className="w-full flex items-center justify-between p-4 h-auto"
                    type="button"
                  >
                    <div className="flex items-center gap-2">
                      <Settings2 className="h-4 w-4" />
                      <span className="font-medium">
                        Advanced Configuration
                      </span>
                    </div>
                    {advancedConfigOpen ? (
                      <ChevronDown className="h-4 w-4" />
                    ) : (
                      <ChevronRight className="h-4 w-4" />
                    )}
                  </Button>
                </CollapsibleTrigger>
                <CollapsibleContent className="px-4 pt-2 pb-4 space-y-4">
                  <p className="text-sm text-muted-foreground">
                    Customize Kubernetes deployment settings. These options are
                    optional and have sensible defaults.
                  </p>

                  <div className="grid grid-cols-2 gap-4">
                    <FormField
                      control={form.control}
                      name="localConfig.advancedK8sConfig.replicas"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Replicas</FormLabel>
                          <FormControl>
                            <Input
                              type="number"
                              placeholder={String(
                                MCP_ORCHESTRATOR_DEFAULTS.replicas,
                              )}
                              min={1}
                              className="font-mono"
                              {...field}
                            />
                          </FormControl>
                          <FormDescription>
                            Number of pod replicas
                          </FormDescription>
                          <FormMessage />
                        </FormItem>
                      )}
                    />

                    <FormField
                      control={form.control}
                      name="localConfig.advancedK8sConfig.namespace"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Namespace</FormLabel>
                          <FormControl>
                            <Input
                              placeholder={orchestratorK8sNamespace}
                              className="font-mono"
                              {...field}
                            />
                          </FormControl>
                          <FormDescription>
                            Override K8s namespace
                          </FormDescription>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </div>

                  <FormField
                    control={form.control}
                    name="localConfig.serviceAccount"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Service Account</FormLabel>
                        <FormControl>
                          <Input
                            placeholder="default"
                            className="font-mono"
                            {...field}
                          />
                        </FormControl>
                        <FormDescription>
                          K8s service account for the deployment pods
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <div className="space-y-2">
                    <FormLabel>Resource Requests</FormLabel>
                    <div className="grid grid-cols-2 gap-4">
                      <FormField
                        control={form.control}
                        name="localConfig.advancedK8sConfig.resourceRequestsMemory"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="text-xs text-muted-foreground">
                              Memory
                            </FormLabel>
                            <FormControl>
                              <Input
                                placeholder={
                                  MCP_ORCHESTRATOR_DEFAULTS.resourceRequestMemory
                                }
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
                        name="localConfig.advancedK8sConfig.resourceRequestsCpu"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="text-xs text-muted-foreground">
                              CPU
                            </FormLabel>
                            <FormControl>
                              <Input
                                placeholder={
                                  MCP_ORCHESTRATOR_DEFAULTS.resourceRequestCpu
                                }
                                className="font-mono"
                                {...field}
                              />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                    </div>
                  </div>

                  <div className="space-y-2">
                    <FormLabel>Resource Limits</FormLabel>
                    <div className="grid grid-cols-2 gap-4">
                      <FormField
                        control={form.control}
                        name="localConfig.advancedK8sConfig.resourceLimitsMemory"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="text-xs text-muted-foreground">
                              Memory
                            </FormLabel>
                            <FormControl>
                              <Input
                                placeholder="256Mi"
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
                        name="localConfig.advancedK8sConfig.resourceLimitsCpu"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="text-xs text-muted-foreground">
                              CPU
                            </FormLabel>
                            <FormControl>
                              <Input
                                placeholder="500m"
                                className="font-mono"
                                {...field}
                              />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                    </div>
                  </div>

                  <FormField
                    control={form.control}
                    name="localConfig.advancedK8sConfig.labels"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Custom Labels (JSON)</FormLabel>
                        <FormControl>
                          <JsonKeyValueEditor
                            value={field.value}
                            onChange={field.onChange}
                            placeholder='{ "team": "backend" }'
                          />
                        </FormControl>
                        <FormDescription>
                          Custom labels to add to pods (JSON key-value format)
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="localConfig.advancedK8sConfig.annotations"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Custom Annotations (JSON)</FormLabel>
                        <FormControl>
                          <JsonKeyValueEditor
                            value={field.value}
                            onChange={field.onChange}
                            placeholder='{ "prometheus.io/scrape": "true" }'
                          />
                        </FormControl>
                        <FormDescription>
                          Custom annotations to add to pods (JSON key-value
                          format)
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </CollapsibleContent>
              </Collapsible>
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

        {footer}
      </form>
    </Form>
  );
}
