import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import { z } from "zod";

import { schema } from "@/database";
import { ToolResultTreatmentSchema } from "./agent-tool";
import { PaginationQuerySchema, UuidIdSchema } from "./api";

export const SelectToolPolicySchema = createSelectSchema(
  schema.toolPoliciesTable,
  {
    toolResultTreatment: ToolResultTreatmentSchema,
  },
);

export const InsertToolPolicySchema = createInsertSchema(
  schema.toolPoliciesTable,
  {
    toolResultTreatment: ToolResultTreatmentSchema,
  },
).extend({
  name: z.string().min(1).max(255),
});

export const UpdateToolPolicySchema = createUpdateSchema(
  schema.toolPoliciesTable,
  {
    toolResultTreatment: ToolResultTreatmentSchema,
  },
).extend({
  name: z.string().min(1).max(255).optional(),
});

export const ToolPolicyFilterSchema = PaginationQuerySchema.extend({
  toolId: UuidIdSchema.optional(),
  organizationId: z.string().optional(),
});

export type ToolPolicy = z.infer<typeof SelectToolPolicySchema>;
export type InsertToolPolicy = z.infer<typeof InsertToolPolicySchema>;
export type UpdateToolPolicy = z.infer<typeof UpdateToolPolicySchema>;
export type ToolPolicyFilters = z.infer<typeof ToolPolicyFilterSchema>;
