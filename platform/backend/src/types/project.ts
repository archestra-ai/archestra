import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";
import { AgentTeamInfoSchema } from "./agent";
import { SelectConversationSchema } from "./conversation";
import { SelectScheduleTriggerSchema } from "./schedule-trigger";
import { ResourceVisibilityScopeSchema } from "./visibility";

export const ProjectScopeSchema = ResourceVisibilityScopeSchema;
export type ProjectScope = z.infer<typeof ProjectScopeSchema>;

export const ProjectKnowledgeBaseSummarySchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  description: z.string().nullable(),
});

const selectExtendedFields = {
  scope: ProjectScopeSchema,
};

export const SelectProjectSchema = createSelectSchema(
  schema.projectsTable,
  selectExtendedFields,
).extend({
  teams: z.array(AgentTeamInfoSchema),
  knowledgeBases: z.array(ProjectKnowledgeBaseSummarySchema),
  knowledgeBaseIds: z.array(z.string().uuid()),
  recentConversations: z.array(SelectConversationSchema).optional(),
  scheduledTriggers: z.array(SelectScheduleTriggerSchema).optional(),
  authorName: z.string().nullable().optional(),
  authorEmail: z.string().nullable().optional(),
});

export const InsertProjectSchema = createInsertSchema(
  schema.projectsTable,
  selectExtendedFields,
)
  .extend({
    name: z.string().trim().min(1).max(200),
    description: z.string().trim().max(2000).nullable().optional(),
    instructions: z.string().trim().max(20000).nullable().optional(),
    icon: z.string().max(100_000).nullable().optional(),
    scope: ProjectScopeSchema.default("personal"),
    teamIds: z.array(z.string()).default([]),
    knowledgeBaseIds: z.array(z.string().uuid()).default([]),
  })
  .omit({
    id: true,
    organizationId: true,
    authorId: true,
    archivedAt: true,
    createdAt: true,
    updatedAt: true,
  });

export const UpdateProjectSchema = createUpdateSchema(
  schema.projectsTable,
  selectExtendedFields,
)
  .extend({
    name: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(2000).nullable().optional(),
    instructions: z.string().trim().max(20000).nullable().optional(),
    icon: z.string().max(100_000).nullable().optional(),
    scope: ProjectScopeSchema.optional(),
    teamIds: z.array(z.string()).optional(),
    knowledgeBaseIds: z.array(z.string().uuid()).optional(),
  })
  .pick({
    name: true,
    description: true,
    instructions: true,
    icon: true,
    scope: true,
    teamIds: true,
    knowledgeBaseIds: true,
    archivedAt: true,
  });

export type Project = z.infer<typeof SelectProjectSchema>;
export type InsertProject = z.infer<typeof InsertProjectSchema>;
export type UpdateProject = z.infer<typeof UpdateProjectSchema>;
