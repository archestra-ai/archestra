import { createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";

export const PromptSnapshotV1Schema = z.object({
  version: z.literal("1"),
  systemPrompt: z.string().nullable(),
});
export type PromptSnapshotV1 = z.infer<typeof PromptSnapshotV1Schema>;

export const AgentVersionSourceSchema = z.enum(["create", "update", "restore"]);
export type AgentVersionSource = z.infer<typeof AgentVersionSourceSchema>;

export const SelectAgentVersionSchema = createSelectSchema(
  schema.agentVersionsTable,
  {
    snapshot: PromptSnapshotV1Schema,
    source: AgentVersionSourceSchema,
  },
);
export type AgentVersion = z.infer<typeof SelectAgentVersionSchema>;
