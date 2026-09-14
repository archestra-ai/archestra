import { createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";

export const SelectGithubAppConfigSchema = createSelectSchema(
  schema.runtimeCredentialDefinitionsTable,
)
  .pick({
    id: true,
    organizationId: true,
    name: true,
    createdAt: true,
    updatedAt: true,
  })
  .extend({
    secretId: z.string().uuid().nullable(),
    githubUrl: z.string(),
    appId: z.string(),
    installationId: z.string(),
  });
export const InsertGithubAppConfigSchema = SelectGithubAppConfigSchema.omit({
  id: true,
  createdAt: true,
  updatedAt: true,
}).extend({
  secretId: z.string().uuid().nullable().optional(),
  githubUrl: z.string().optional(),
});
export const UpdateGithubAppConfigSchema = SelectGithubAppConfigSchema.pick({
  name: true,
  secretId: true,
  githubUrl: true,
  appId: true,
  installationId: true,
}).partial();

// API-facing shape: never exposes the secret reference
export const PublicGithubAppConfigSchema = SelectGithubAppConfigSchema.omit({
  secretId: true,
});

// the private key PEM is write-only; clients send it, the API never returns it
const PrivateKeySchema = z
  .string()
  .min(1)
  .describe("GitHub App private key PEM");

// the stored value becomes the API base URL for token exchange and syncs, so it
// must be HTTP(S) — z.string().url() alone would let ftp:// etc. through
const GithubApiUrlSchema = z
  .string()
  .url()
  .refine((value) => /^https?:\/\//.test(value), {
    message: "githubUrl must be an HTTP(S) URL",
  });

export const CreateGithubAppConfigRequestSchema = z.object({
  name: z.string().min(1),
  githubUrl: GithubApiUrlSchema.optional(),
  appId: z.string().min(1),
  installationId: z.string().min(1),
  privateKey: PrivateKeySchema,
});

export const UpdateGithubAppConfigRequestSchema = z.object({
  name: z.string().min(1).optional(),
  githubUrl: GithubApiUrlSchema.optional(),
  appId: z.string().min(1).optional(),
  installationId: z.string().min(1).optional(),
  privateKey: PrivateKeySchema.optional(),
});

export type GithubAppConfig = z.infer<typeof SelectGithubAppConfigSchema>;
export type InsertGithubAppConfig = z.infer<typeof InsertGithubAppConfigSchema>;
export type UpdateGithubAppConfig = z.infer<typeof UpdateGithubAppConfigSchema>;
export type PublicGithubAppConfig = z.infer<typeof PublicGithubAppConfigSchema>;
export type CreateGithubAppConfigRequest = z.infer<
  typeof CreateGithubAppConfigRequestSchema
>;
export type UpdateGithubAppConfigRequest = z.infer<
  typeof UpdateGithubAppConfigRequestSchema
>;
