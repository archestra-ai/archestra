import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";
import { SelectToolSchema } from "./tool";

export const SelectAgentSchema = createSelectSchema(schema.agentsTable).extend({
  tools: z.array(SelectToolSchema),
  teams: z.array(z.string()),
});
export const InsertAgentSchema = createInsertSchema(schema.agentsTable).extend({
  teams: z.array(z.string()),
});

export const UpdateAgentSchema = createUpdateSchema(schema.agentsTable).extend({
  teams: z.array(z.string()),
});

export type Agent = z.infer<typeof SelectAgentSchema>;
export type InsertAgent = z.infer<typeof InsertAgentSchema>;
export type UpdateAgent = z.infer<typeof UpdateAgentSchema>;
