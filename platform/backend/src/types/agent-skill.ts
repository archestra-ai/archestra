import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";
import { UuidIdSchema } from "./api";
import { ResourceVisibilityScopeSchema } from "./visibility";

/**
 * Ceiling on the assigned and excluded sets a single PUT may carry.
 *
 * Both bodies are full replaces of a hand-curated set, so no real gateway
 * comes near this. It is here because validating one costs work per id, and
 * an uncapped array turns a single authenticated request into as many
 * lookups as fit in the body.
 */
const MAX_SKILLS_PER_AGENT = 1000;

export const SelectAgentSkillSchema = createSelectSchema(
  schema.agentSkillsTable,
);

export const InsertAgentSkillSchema = createInsertSchema(
  schema.agentSkillsTable,
).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const UpdateAgentSkillSchema = createUpdateSchema(
  schema.agentSkillsTable,
).pick({ skillId: true });

export type AgentSkill = z.infer<typeof SelectAgentSkillSchema>;
export type InsertAgentSkill = z.infer<typeof InsertAgentSkillSchema>;
export type UpdateAgentSkill = z.infer<typeof UpdateAgentSkillSchema>;

export const SelectAgentExcludedSkillSchema = createSelectSchema(
  schema.agentExcludedSkillsTable,
);

export type AgentExcludedSkill = z.infer<typeof SelectAgentExcludedSkillSchema>;

/**
 * A skill as an assignment endpoint returns it: enough for a picker entry and
 * the publishability rules, nothing more.
 *
 * Returned alongside the id list because the ids alone are not resolvable by a
 * client — the skill catalog is paginated and capped at 100 per page, so an
 * assignment outside the first page could not be named, shown, or removed. The
 * agent's tool endpoint returns full rows for the same reason.
 */
export const AssignedSkillSchema = z.object({
  id: UuidIdSchema,
  name: z.string(),
  description: z.string(),
  scope: ResourceVisibilityScopeSchema,
  templated: z.boolean(),
  agentName: z.string().nullable(),
  authorId: z.string().nullable(),
});

export type AssignedSkill = z.infer<typeof AssignedSkillSchema>;

/**
 * API shape of an agent's Auto-skill-mode exclusions: individually excluded
 * skills. Used as the PUT body (full replace) of
 * /api/agents/:id/skill-exclusions.
 */
export const AgentSkillExclusionsSchema = z.object({
  excludedSkillIds: z
    .array(UuidIdSchema)
    .max(MAX_SKILLS_PER_AGENT)
    .describe("Individual skill IDs excluded from the agent's skill surface"),
});

export type AgentSkillExclusions = z.infer<typeof AgentSkillExclusionsSchema>;

/** GET response: the exclusion ids plus the rows needed to render them. */
export const AgentSkillExclusionsResponseSchema =
  AgentSkillExclusionsSchema.extend({
    skills: z
      .array(AssignedSkillSchema)
      .describe("The excluded skills themselves, in `excludedSkillIds` order"),
  });

export type AgentSkillExclusionsResponse = z.infer<
  typeof AgentSkillExclusionsResponseSchema
>;

/**
 * API shape of an agent's explicit skill assignments (Custom mode), plus the
 * Auto-mode toggle. The PUT body of /api/agents/:id/skills.
 */
export const AgentSkillAssignmentsSchema = z.object({
  accessAllSkills: z
    .boolean()
    .describe(
      "Auto mode: expose every org-scoped skill visible in the agent's environment",
    ),
  skillIds: z
    .array(UuidIdSchema)
    .max(MAX_SKILLS_PER_AGENT)
    .describe("Skills explicitly assigned to the agent (Custom mode)"),
});

export type AgentSkillAssignments = z.infer<typeof AgentSkillAssignmentsSchema>;

/** GET response: the assignment ids plus the rows needed to render them. */
export const AgentSkillAssignmentsResponseSchema =
  AgentSkillAssignmentsSchema.extend({
    skills: z
      .array(AssignedSkillSchema)
      .describe("The assigned skills themselves, in `skillIds` order"),
  });

export type AgentSkillAssignmentsResponse = z.infer<
  typeof AgentSkillAssignmentsResponseSchema
>;
