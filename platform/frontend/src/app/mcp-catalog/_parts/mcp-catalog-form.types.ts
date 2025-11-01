import { LocalConfigFormSchema, type LocalConfigSchema } from "@shared";
import { z } from "zod";

// Simplified OAuth config schema
export const oauthConfigSchema = z.object({
  client_id: z.string().optional().or(z.literal("")),
  client_secret: z.string().optional().or(z.literal("")),
  redirect_uris: z.string().min(1, "At least one redirect URI is required"),
  scopes: z.string().optional().or(z.literal("")),
  supports_resource_metadata: z.boolean(),
});

export const formSchema = z
  .object({
    name: z.string().min(1, "Name is required"),
    label: z.string().min(1, "Label is required"),
    serverType: z.enum(["remote", "local"]),
    serverUrl: z
      .string()
      .url("Must be a valid URL")
      .optional()
      .or(z.literal("")),
    authMethod: z.enum(["none", "pat", "oauth"]),
    oauthConfig: oauthConfigSchema.optional(),
    localConfig: LocalConfigFormSchema.optional(),
  })
  .refine(
    (data) => {
      // For remote servers, serverUrl is required
      if (data.serverType === "remote") {
        return data.serverUrl && data.serverUrl.length > 0;
      }
      // For local servers, localConfig is required
      if (data.serverType === "local") {
        return data.localConfig?.command && data.localConfig.command.length > 0;
      }
      return true;
    },
    {
      message:
        "Server URL is required for remote servers, and command is required for local servers",
      path: ["serverUrl"],
    },
  );

export type McpCatalogFormValues = z.infer<typeof formSchema>;

// API data type - matches backend expectations
export type McpCatalogApiData = {
  name: string;
  serverType: "remote" | "local";
  label?: string;
  serverUrl?: string;
  localConfig?: z.infer<typeof LocalConfigSchema>;
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
