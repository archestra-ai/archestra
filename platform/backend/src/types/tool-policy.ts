import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";

export const ToolResultTreatmentSchema = z.enum([
  "trusted",
  "sanitize_with_dual_llm",
  "untrusted",
]);

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
);

export const UpdateToolPolicySchema = createUpdateSchema(
  schema.toolPoliciesTable,
  {
    toolResultTreatment: ToolResultTreatmentSchema,
  },
);

export type ToolPolicy = z.infer<typeof SelectToolPolicySchema>;
export type InsertToolPolicy = z.infer<typeof InsertToolPolicySchema>;
export type UpdateToolPolicy = z.infer<typeof UpdateToolPolicySchema>;
export type ToolResultTreatment = z.infer<typeof ToolResultTreatmentSchema>;
