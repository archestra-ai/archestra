import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";

export const SelectGithubPatSchema = createSelectSchema(schema.githubPatsTable);
export const InsertGithubPatSchema = createInsertSchema(
  schema.githubPatsTable,
).omit({ id: true, createdAt: true, updatedAt: true });
export const UpdateGithubPatSchema = createUpdateSchema(
  schema.githubPatsTable,
).pick({ name: true, secretId: true });

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
