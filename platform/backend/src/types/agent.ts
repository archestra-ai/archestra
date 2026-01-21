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
 * Regex pattern for validating domain format.
 * Matches domains like: company.com, sub.company.com, my-company.co.uk
 * Does not match: spaces, special characters (except hyphen), domains starting/ending with hyphen
 */
const DOMAIN_REGEX =
  /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*\.[a-zA-Z]{2,}$/;

/**
 * Validate incoming email settings.
 * Throws an error if:
 * - Security mode is 'internal' but no allowed domain is set
 * - Security mode is 'internal' and the allowed domain format is invalid
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

    const domain = data.incomingEmailAllowedDomain.trim();
    if (!DOMAIN_REGEX.test(domain)) {
      throw new Error(
        "incomingEmailAllowedDomain must be a valid domain format (e.g., company.com)",
      );
    }
  }
}
