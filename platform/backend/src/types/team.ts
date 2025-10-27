import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";

export const SelectTeamMemberSchema = createSelectSchema(schema.teamMember);
export const SelectTeamSchema = createSelectSchema(schema.team).extend({
  members: z.array(SelectTeamMemberSchema).optional(),
});

export const InsertTeamSchema = createInsertSchema(schema.team);
export const UpdateTeamSchema = createUpdateSchema(schema.team);

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
  role: z.string().default("member"),
});

export type Team = z.infer<typeof SelectTeamSchema>;
export type InsertTeam = z.infer<typeof InsertTeamSchema>;
export type UpdateTeam = z.infer<typeof UpdateTeamSchema>;
export type TeamMember = z.infer<typeof SelectTeamMemberSchema>;
export type CreateTeamBody = z.infer<typeof CreateTeamBodySchema>;
export type UpdateTeamBody = z.infer<typeof UpdateTeamBodySchema>;
export type AddTeamMemberBody = z.infer<typeof AddTeamMemberBodySchema>;
