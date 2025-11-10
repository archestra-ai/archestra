import { MEMBER_ROLE_NAME } from "@shared";
import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";

export const SelectTeamMemberSchema = createSelectSchema(
  schema.teamMembersTable,
);
export const SelectTeamSchema = createSelectSchema(schema.teamsTable).extend({
  members: z.array(SelectTeamMemberSchema).optional(),
});

export const InsertTeamSchema = createInsertSchema(schema.teamsTable);
export const UpdateTeamSchema = createUpdateSchema(schema.teamsTable);

export const CreateTeamBodySchema = z.object({
  name: z.string().min(1, "Team name is required"),
  description: z.string().optional(),
});

export const UpdateTeamBodySchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
});

export const AddTeamMemberBodySchema = z.object({
  userId: z.string(),
  role: z.string().default(MEMBER_ROLE_NAME),
});

export type Team = z.infer<typeof SelectTeamSchema>;
export type InsertTeam = z.infer<typeof InsertTeamSchema>;
export type UpdateTeam = z.infer<typeof UpdateTeamSchema>;
export type TeamMember = z.infer<typeof SelectTeamMemberSchema>;
export type CreateTeamBody = z.infer<typeof CreateTeamBodySchema>;
export type UpdateTeamBody = z.infer<typeof UpdateTeamBodySchema>;
export type AddTeamMemberBody = z.infer<typeof AddTeamMemberBodySchema>;
