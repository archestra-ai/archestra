"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { AlertCircle, Info } from "lucide-react";
import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Checkbox } from "@/components/ui/checkbox";
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
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { GetInternalMcpCatalogResponses } from "@/lib/clients/api";

// Simplified OAuth config schema
const oauthConfigSchema = z.object({
  client_id: z.string().optional().or(z.literal("")),
  client_secret: z.string().optional().or(z.literal("")),
  redirect_uris: z.string().min(1, "At least one redirect URI is required"),
  scopes: z.string().optional().or(z.literal("")),
  supports_resource_metadata: z.boolean(),
});

const formSchema = z.object({
  name: z.string().min(1, "Name is required"),
  label: z.string().min(1, "Label is required"),
  serverType: z.enum(["remote", "local"]),
  serverUrl: z
    .string()
    .url("Must be a valid URL")
    .min(1, "Server URL is required"),
  authMethod: z.enum(["none", "pat", "oauth"]),
  oauthConfig: oauthConfigSchema.optional(),
});

export type McpCatalogFormValues = z.infer<typeof formSchema>;

// API data type - matches backend expectations
export type McpCatalogApiData = {
  name: string;
  serverType: "remote" | "local";
  label?: string;
  serverUrl?: string;
  oauthConfig?: {
    name: string;
    server_url: string;
    client_id: string;
    client_secret?: string;
    redirect_uris: string[];
    scopes: string[];
    default_scopes: string[];
    supports_resource_metadata: boolean;
  };
  userConfig?: Record<
    string,
    {
      type: "string" | "number" | "boolean" | "directory" | "file";
      title: string;
      description: string;
      required?: boolean;
      sensitive?: boolean;
      default?: string | number | boolean | string[];
      multiple?: boolean;
      min?: number;
      max?: number;
    }
  >;
};

// Transform function to convert form values to API format
export function transformFormToApiData(
  values: McpCatalogFormValues,
): McpCatalogApiData {
  const data: McpCatalogApiData = {
    name: values.name,
    serverType: values.serverType,
  };

  if (values.label) {
    data.label = values.label;
  }

  if (values.serverUrl) {
    data.serverUrl = values.serverUrl;
  }

  // Handle OAuth configuration
  if (values.authMethod === "oauth" && values.oauthConfig) {
    const redirectUrisList = values.oauthConfig.redirect_uris
      .split(",")
      .map((uri) => uri.trim())
      .filter((uri) => uri.length > 0);

    // Default to ["read", "write"] if scopes not provided or empty
    const scopesList = values.oauthConfig.scopes?.trim()
      ? values.oauthConfig.scopes
          .split(",")
          .map((scope) => scope.trim())
          .filter((scope) => scope.length > 0)
      : ["read", "write"];

    data.oauthConfig = {
      name: values.label, // Use label as OAuth provider name
      server_url: values.serverUrl, // Use serverUrl as OAuth server URL
      client_id: values.oauthConfig.client_id || "",
      client_secret: values.oauthConfig.client_secret || undefined,
      redirect_uris: redirectUrisList,
      scopes: scopesList,
      default_scopes: ["read", "write"],
      supports_resource_metadata: values.oauthConfig.supports_resource_metadata,
    };
    // Clear userConfig when using OAuth
    data.userConfig = {};
  } else if (values.authMethod === "pat") {
    // Handle PAT configuration
    data.userConfig = {
      access_token: {
        type: "string" as const,
        title: "Access Token",
        description: "Personal access token for authentication",
        required: true,
        sensitive: true,
      },
    };
    // Clear oauthConfig when using PAT
    data.oauthConfig = undefined;
  } else {
    // No authentication - clear both configs
    data.userConfig = {};
    data.oauthConfig = undefined;
  }

  return data;
}

// Transform catalog item to form values
export function transformCatalogItemToFormValues(
  item: GetInternalMcpCatalogResponses["200"][number],
): McpCatalogFormValues {
  // Determine auth method
  let authMethod: "none" | "pat" | "oauth" = "none";
  if (item.oauthConfig) {
    authMethod = "oauth";
  } else if (item.userConfig?.access_token) {
    authMethod = "pat";
  } else if (
    // Special case: GitHub server uses PAT but external catalog doesn't define userConfig
    item.name.includes("githubcopilot") ||
    item.name.includes("github")
  ) {
    authMethod = "pat";
  }

  // Extract OAuth config if present
  let oauthConfig:
    | {
        client_id: string;
        client_secret: string;
        redirect_uris: string;
        scopes: string;
        supports_resource_metadata: boolean;
      }
    | undefined;
  if (item.oauthConfig) {
    oauthConfig = {
      client_id: item.oauthConfig.client_id || "",
      client_secret: item.oauthConfig.client_secret || "",
      redirect_uris: item.oauthConfig.redirect_uris?.join(", ") || "",
      scopes: item.oauthConfig.scopes?.join(", ") || "",
      supports_resource_metadata:
        item.oauthConfig.supports_resource_metadata ?? true,
    };
  }

  return {
    name: item.name,
    label: item.label || item.name,
    serverType: item.serverType as "remote" | "local",
    serverUrl: item.serverUrl || "",
    authMethod,
    oauthConfig,
  };
}

interface McpCatalogFormProps {
  mode: "create" | "edit";
  initialValues?: GetInternalMcpCatalogResponses["200"][number];
  onSubmit: (values: McpCatalogFormValues) => void;
  submitButtonRef?: React.RefObject<HTMLButtonElement | null>;
}

export function McpCatalogForm({
  mode,
  initialValues,
  onSubmit,
  submitButtonRef,
}: McpCatalogFormProps) {
  const form = useForm<McpCatalogFormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: initialValues
      ? transformCatalogItemToFormValues(initialValues)
      : {
          name: "",
          label: "",
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
        },
  });

  const authMethod = form.watch("authMethod");

  // Reset form when initial values change (for edit mode)
  useEffect(() => {
    if (initialValues) {
      form.reset(transformCatalogItemToFormValues(initialValues));
    }
  }, [initialValues, form]);

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
                  <Input
                    placeholder="e.g., github"
                    className="font-mono"
                    {...field}
                  />
                </FormControl>
                <FormDescription>
                  Unique identifier for this server
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="label"
            render={({ field }) => (
              <FormItem>
                <FormLabel>
                  Label <span className="text-destructive">*</span>
                </FormLabel>
                <FormControl>
                  <Input placeholder="e.g., GitHub MCP Server" {...field} />
                </FormControl>
                <FormDescription>Display name shown in the UI</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

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
        </div>

        {/* Authentication Section */}
        <div className="space-y-4 pt-4 border-t">
          <div className="flex items-center gap-2">
            <FormLabel>Authentication</FormLabel>
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger>
                  <Info className="h-4 w-4 text-muted-foreground" />
                </TooltipTrigger>
                <TooltipContent>
                  <p className="max-w-xs">
                    Choose how users will authenticate when installing this
                    server
                  </p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>

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
                        No authentication required
                      </FormLabel>
                    </div>
                    <div className="flex items-center space-x-2">
                      <RadioGroupItem value="pat" id="auth-pat" />
                      <FormLabel
                        htmlFor="auth-pat"
                        className="font-normal cursor-pointer"
                      >
                        Personal Access Token (PAT)
                      </FormLabel>
                    </div>
                    <div className="flex items-center space-x-2">
                      <RadioGroupItem value="oauth" id="auth-oauth" />
                      <FormLabel
                        htmlFor="auth-oauth"
                        className="font-normal cursor-pointer"
                      >
                        OAuth
                      </FormLabel>
                    </div>
                  </RadioGroup>
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          {authMethod === "pat" && (
            <div className="bg-muted p-4 rounded-lg">
              <p className="text-sm text-muted-foreground">
                Users will be prompted to provide their personal access token
                when installing this server.
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

              <FormField
                control={form.control}
                name="oauthConfig.redirect_uris"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      Redirect URIs <span className="text-destructive">*</span>
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

        {/* Hidden submit button that can be triggered externally */}
        <button
          ref={submitButtonRef}
          type="submit"
          className="hidden"
          tabIndex={-1}
        />
      </form>
    </Form>
  );
}
