import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import type { z } from "zod";
import { schema } from "@/database";

export const SelectSkillSandboxSchema = createSelectSchema(
  schema.skillSandboxesTable,
);
export const InsertSkillSandboxSchema = createInsertSchema(
  schema.skillSandboxesTable,
).omit({
  id: true,
  createdAt: true,
});

export const SelectSkillSandboxCommandSchema = createSelectSchema(
  schema.skillSandboxCommandsTable,
);
export const InsertSkillSandboxCommandSchema = createInsertSchema(
  schema.skillSandboxCommandsTable,
).omit({
  id: true,
  createdAt: true,
});

export const SelectSkillSandboxArtifactSchema = createSelectSchema(
  schema.skillSandboxArtifactsTable,
);
export const InsertSkillSandboxArtifactSchema = createInsertSchema(
  schema.skillSandboxArtifactsTable,
).omit({
  id: true,
  createdAt: true,
});

export type SkillSandbox = z.infer<typeof SelectSkillSandboxSchema>;
export type InsertSkillSandbox = z.infer<typeof InsertSkillSandboxSchema>;
export type SkillSandboxCommand = z.infer<
  typeof SelectSkillSandboxCommandSchema
>;
export type InsertSkillSandboxCommand = z.infer<
  typeof InsertSkillSandboxCommandSchema
>;
export type SkillSandboxArtifact = z.infer<
  typeof SelectSkillSandboxArtifactSchema
>;
export type InsertSkillSandboxArtifact = z.infer<
  typeof InsertSkillSandboxArtifactSchema
>;

/**
 * Branded sandbox id so callers cannot accidentally pass a raw uuid string
 * where the runtime expects a sandbox handle.
 */
export type SandboxId = string & { readonly __brand: "SandboxId" };

export function asSandboxId(id: string): SandboxId {
  return id as SandboxId;
}
