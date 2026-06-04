import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";

export const SelectGithubAppConfigSchema = createSelectSchema(
  schema.githubAppConfigsTable,
);
export const InsertGithubAppConfigSchema = createInsertSchema(
  schema.githubAppConfigsTable,
).omit({ id: true, createdAt: true, updatedAt: true });
export const UpdateGithubAppConfigSchema = createUpdateSchema(
  schema.githubAppConfigsTable,
).pick({
  name: true,
  githubUrl: true,
  appId: true,
  installationId: true,
  secretId: true,
});

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
