import { LocalConfigFormSchema } from "@shared";
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
    name: z.string().trim().min(1, "Name is required"),
    serverType: z.enum(["remote", "local"]),
    serverUrl: z
      .string()
      .url({ error: "Must be a valid URL" })
      .optional()
      .or(z.literal("")),
    authMethod: z.enum(["none", "bearer", "raw_token", "oauth"]),
    oauthConfig: oauthConfigSchema.optional(),
    localConfig: LocalConfigFormSchema.optional(),
    // BYOS: External Vault path for OAuth client secret
    oauthClientSecretVaultPath: z.string().optional(),
    // BYOS: External Vault key for OAuth client secret
    oauthClientSecretVaultKey: z.string().optional(),
    // BYOS: External Vault path for local config secret env vars
    localConfigVaultPath: z.string().optional(),
    // BYOS: External Vault key for local config secret env vars
    localConfigVaultKey: z.string().optional(),
  })
  .refine(
    (data) => {
      // For remote servers, serverUrl is required
      if (data.serverType === "remote") {
        return data.serverUrl && data.serverUrl.length > 0;
      }
      return true;
    },
    {
      message: "Server URL is required for remote servers.",
      path: ["serverUrl"],
    },
  )
  .refine(
    (data) => {
      // For local servers, at least command or dockerImage is required
      if (data.serverType === "local") {
        const hasCommand =
          data.localConfig?.command &&
          data.localConfig.command.trim().length > 0;
        const hasDockerImage =
          data.localConfig?.dockerImage &&
          data.localConfig.dockerImage.trim().length > 0;
        return hasCommand || hasDockerImage;
      }
      return true;
    },
    {
      message:
        "Either command or Docker image must be provided. If Docker image is set, command is optional.",
      path: ["localConfig", "command"],
    },
  );

export type McpCatalogFormValues = z.infer<typeof formSchema>;
