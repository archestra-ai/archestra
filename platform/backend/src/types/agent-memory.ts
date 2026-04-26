import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";

export const SelectAgentMemorySchema = createSelectSchema(
  schema.agentMemoriesTable,
);
export type AgentMemory = z.infer<typeof SelectAgentMemorySchema>;

export const InsertAgentMemorySchema = createInsertSchema(
  schema.agentMemoriesTable,
  {
    key: z
      .string()
      .min(1)
      .max(200)
      .regex(
        /^[a-zA-Z0-9_.-]+$/,
        "Key must be alphanumeric with underscores, dots, or hyphens",
      ),
    value: z.string().min(1).max(10000),
  },
).omit({ id: true, createdAt: true, updatedAt: true });

export type InsertAgentMemory = z.infer<typeof InsertAgentMemorySchema>;

export const MemoryScopeTypeSchema = z.enum(["user", "team", "org"]);
export type MemoryScopeType = z.infer<typeof MemoryScopeTypeSchema>;

export const UpsertAgentMemoryBodySchema = z.object({
  scopeType: MemoryScopeTypeSchema,
  scopeId: z.string().min(1),
  key: z
    .string()
    .min(1)
    .max(200)
    .regex(
      /^[a-zA-Z0-9_.-]+$/,
      "Key must be alphanumeric with underscores, dots, or hyphens",
    ),
  value: z.string().min(1).max(10000),
});

export const DeleteAgentMemoryParamsSchema = z.object({
  id: z.string().uuid(),
});
