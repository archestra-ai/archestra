import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";
import { AgentLabelWithDetailsSchema } from "./label";
import { SelectToolSchema } from "./tool";

// Team info schema for agent responses (just id and name)
export const AgentTeamInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
});

// Schema for incoming email security mode validation
export const IncomingEmailSecurityModeSchema = z.enum([
  "private",
  "internal",
  "public",
]);

export const SelectAgentSchema = createSelectSchema(schema.agentsTable).extend({
  tools: z.array(SelectToolSchema),
  teams: z.array(AgentTeamInfoSchema),
  labels: z.array(AgentLabelWithDetailsSchema),
  // Ensure incomingEmailSecurityMode is validated as an enum
  incomingEmailSecurityMode: IncomingEmailSecurityModeSchema,
});

export const InsertAgentSchema = createInsertSchema(schema.agentsTable)
  .extend({
    teams: z.array(z.string()),
    labels: z.array(AgentLabelWithDetailsSchema).optional(),
    // Validate security mode on insert
    incomingEmailSecurityMode: IncomingEmailSecurityModeSchema.optional(),
  })
  .omit({
    id: true,
    createdAt: true,
    updatedAt: true,
  });

export const UpdateAgentSchema = createUpdateSchema(schema.agentsTable)
  .extend({
    teams: z.array(z.string()),
    labels: z.array(AgentLabelWithDetailsSchema).optional(),
    // Validate security mode on update
    incomingEmailSecurityMode: IncomingEmailSecurityModeSchema.optional(),
  })
  .omit({
    id: true,
    createdAt: true,
    updatedAt: true,
  });

export type Agent = z.infer<typeof SelectAgentSchema>;
export type InsertAgent = z.infer<typeof InsertAgentSchema>;
export type UpdateAgent = z.infer<typeof UpdateAgentSchema>;

/**
 * Validate incoming email settings.
 * Throws an error if security mode is 'internal' but no allowed domain is set.
 */
export function validateIncomingEmailSettings(
  data: Partial<UpdateAgent>,
): void {
  if (data.incomingEmailSecurityMode === "internal") {
    if (
      data.incomingEmailAllowedDomain === undefined ||
      data.incomingEmailAllowedDomain === null ||
      data.incomingEmailAllowedDomain.trim() === ""
    ) {
      throw new Error(
        "incomingEmailAllowedDomain is required when security mode is 'internal'",
      );
    }
  }
}
