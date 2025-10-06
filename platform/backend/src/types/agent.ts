import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import type { z } from "zod";
import { schema } from "@/database";

export const SelectAgentSchema = createSelectSchema(schema.agentsTable);
export const InsertAgentSchema = createInsertSchema(schema.agentsTable);

export type Agent = z.infer<typeof SelectAgentSchema>;
export type InsertAgent = z.infer<typeof InsertAgentSchema>;
