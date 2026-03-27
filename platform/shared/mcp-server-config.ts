import { z } from "zod";

export const OAuthConfigSchema = z.object({
  name: z.string(),
  server_url: z.string(),
  auth_server_url: z.string().optional(),
  resource_metadata_url: z.string().optional(),
  client_id: z.string(),
  client_secret: z.string().optional(),
  redirect_uris: z.array(z.string()),
  scopes: z.array(z.string()),
  description: z.string().optional(),
  well_known_url: z.string().optional(),
  default_scopes: z.array(z.string()),
  supports_resource_metadata: z.boolean(),
  generic_oauth: z.boolean().optional(),
  token_endpoint: z.string().optional(),
  access_token_env_var: z
    .string()
    .regex(
      /^[A-Za-z_][A-Za-z0-9_]*$/,
      "Must be a valid environment variable name (letters, digits, underscores)",
    )
    .optional(),
  requires_proxy: z.boolean().optional(),
  provider_name: z.string().optional(),
  browser_auth: z.boolean().optional(),
  streamable_http_url: z.string().optional(),
  streamable_http_port: z.number().optional(),
});

export const EnvironmentVariableSchema = z.object({
  key: z.string().min(1, "Key is required"),
  type: z.enum(["plain_text", "secret", "boolean", "number"]),
  value: z.string().optional(),
  promptOnInstallation: z.boolean(),
  required: z.boolean().optional(),
  description: z.string().optional(),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  mounted: z.boolean().optional(),
});

export const ImagePullSecretExistingSchema = z.object({
  source: z.literal("existing"),
  name: z.string().min(1),
});

export const ImagePullSecretCredentialsSchema = z.object({
  source: z.literal("credentials"),
  server: z.string().min(1),
  username: z.string().min(1),
  password: z.string().optional(),
  email: z.string().optional(),
});

export const ImagePullSecretConfigSchema = z.discriminatedUnion("source", [
  ImagePullSecretExistingSchema,
  ImagePullSecretCredentialsSchema,
]);

export type ImagePullSecretConfig = z.infer<typeof ImagePullSecretConfigSchema>;

export const EnvFromSchema = z.object({
  type: z.enum(["secret", "configMap"]),
  name: z.string().min(1, "Name is required"),
  prefix: z.string().optional(),
});

export const LocalConfigSchema = z
  .object({
    command: z.string().optional(),
    arguments: z.array(z.string()).optional(),
    environment: z.array(EnvironmentVariableSchema).optional(),
    envFrom: z.array(EnvFromSchema).optional(),
    dockerImage: z.string().optional(),
    transportType: z.enum(["stdio", "streamable-http"]).optional(),
    httpPort: z.number().optional(),
    httpPath: z.string().optional(),
    nodePort: z.number().optional(),
    serviceAccount: z.string().optional(),
    imagePullSecrets: z.array(ImagePullSecretConfigSchema).optional(),
  })
  .refine(
    (data) => data.command || data.dockerImage,
    {
      message:
        "Either command or dockerImage must be provided. If dockerImage is set, command is optional (Docker image's default CMD will be used).",
      path: ["command"],
    },
  );

export const LocalConfigFormSchema = z.object({
  command: z.string().optional(),
  arguments: z.string(),
  environment: z.array(EnvironmentVariableSchema),
  envFrom: z.array(EnvFromSchema).optional(),
  dockerImage: z.string().optional(),
  transportType: z.enum(["stdio", "streamable-http"]).optional(),
  httpPort: z.string().optional(),
  httpPath: z.string().optional(),
  serviceAccount: z.string().optional(),
  imagePullSecrets: z.array(ImagePullSecretConfigSchema).optional(),
});
