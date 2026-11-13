import { createInsertSchema } from "drizzle-zod";
import type { z } from "zod";
import { schema } from "@/database/schema";

export const InsertGithubAppAccountSchema = createInsertSchema(
  schema.githubAppAccountsTable,
).omit({ id: true, createdAt: true });

export type InsertGithubAppAccount = z.infer<
  typeof InsertGithubAppAccountSchema
>;
