import { createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";

export const SelectGithubPatSchema = createSelectSchema(
  schema.runtimeCredentialDefinitionsTable,
)
  .pick({
    id: true,
    organizationId: true,
    name: true,
    createdAt: true,
    updatedAt: true,
  })
  .extend({ secretId: z.string().uuid().nullable() });
export const InsertGithubPatSchema = SelectGithubPatSchema.omit({
  id: true,
  createdAt: true,
  updatedAt: true,
}).extend({ secretId: z.string().uuid().nullable().optional() });
export const UpdateGithubPatSchema = SelectGithubPatSchema.pick({
  name: true,
  secretId: true,
}).partial();

// API-facing shape: never exposes the secret reference
export const PublicGithubPatSchema = SelectGithubPatSchema.omit({
  secretId: true,
});

// the token is write-only; clients send it, the API never returns it
const PatTokenSchema = z
  .string()
  .min(1)
  .describe("GitHub personal access token");

export const CreateGithubPatRequestSchema = z.object({
  name: z.string().min(1),
  token: PatTokenSchema,
});

export const UpdateGithubPatRequestSchema = z.object({
  name: z.string().min(1).optional(),
  token: PatTokenSchema.optional().describe(
    "Provide only to rotate the stored token.",
  ),
});

export type GithubPat = z.infer<typeof SelectGithubPatSchema>;
export type InsertGithubPat = z.infer<typeof InsertGithubPatSchema>;
export type UpdateGithubPat = z.infer<typeof UpdateGithubPatSchema>;
export type PublicGithubPat = z.infer<typeof PublicGithubPatSchema>;
export type CreateGithubPatRequest = z.infer<
  typeof CreateGithubPatRequestSchema
>;
export type UpdateGithubPatRequest = z.infer<
  typeof UpdateGithubPatRequestSchema
>;
