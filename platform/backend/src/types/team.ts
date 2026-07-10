import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";
import { AgentLabelWithDetailsSchema } from "./label";
import { TeamMemberRoleSchema } from "./team-role";

export const SelectTeamMemberSchema = createSelectSchema(
  schema.teamMembersTable,
);
export const SelectTeamMemberListItemSchema = SelectTeamMemberSchema.extend({
  name: z.string().nullable(),
  email: z.string(),
  image: z.string().nullable(),
});
export const SelectTeamSchema = createSelectSchema(schema.teamsTable).extend({
  members: z.array(SelectTeamMemberSchema).optional(),
  labels: z.array(AgentLabelWithDetailsSchema).optional(),
  // The requesting user's role in this team. Populated only when the listing is
  // restricted to the caller's own teams; absent when a team manager lists teams
  // they may not belong to.
  myRole: TeamMemberRoleSchema.optional(),
});

export const InsertTeamSchema = createInsertSchema(schema.teamsTable);
export const UpdateTeamSchema = createUpdateSchema(schema.teamsTable);

const MAX_TEAM_NAME_LENGTH = 256;

export const CreateTeamBodySchema = z.object({
  name: z
    .string()
    .min(1, "Team name is required")
    .max(MAX_TEAM_NAME_LENGTH, "Team name must be at most 256 characters"),
  description: z.string().optional(),
  labels: z.array(AgentLabelWithDetailsSchema).optional(),
});

export const UpdateTeamBodySchema = z.object({
  name: z
    .string()
    .min(1)
    .max(MAX_TEAM_NAME_LENGTH, "Team name must be at most 256 characters")
    .optional(),
  description: z.string().optional(),
  convertToolResultsToToon: z.boolean().optional(),
  labels: z.array(AgentLabelWithDetailsSchema).optional(),
});

export const AddTeamMemberBodySchema = z.object({
  userId: z.string(),
  role: TeamMemberRoleSchema.default("member"),
});

export const UpdateTeamMemberBodySchema = z.object({
  role: TeamMemberRoleSchema,
});

// Team External Group schemas for SSO team sync
export const SelectTeamExternalGroupSchema = createSelectSchema(
  schema.teamExternalGroupsTable,
);
export const InsertTeamExternalGroupSchema = createInsertSchema(
  schema.teamExternalGroupsTable,
);

export const AddTeamExternalGroupBodySchema = z.object({
  groupIdentifier: z.string().min(1, "Group identifier is required"),
});

export type Team = z.infer<typeof SelectTeamSchema>;
export type InsertTeam = z.infer<typeof InsertTeamSchema>;
export type UpdateTeam = z.infer<typeof UpdateTeamSchema>;
export type TeamMember = z.infer<typeof SelectTeamMemberSchema>;
export type TeamMemberListItem = z.infer<typeof SelectTeamMemberListItemSchema>;
export type CreateTeamBody = z.infer<typeof CreateTeamBodySchema>;
export type UpdateTeamBody = z.infer<typeof UpdateTeamBodySchema>;
export type AddTeamMemberBody = z.infer<typeof AddTeamMemberBodySchema>;
export type UpdateTeamMemberBody = z.infer<typeof UpdateTeamMemberBodySchema>;
export type TeamExternalGroup = z.infer<typeof SelectTeamExternalGroupSchema>;
export type InsertTeamExternalGroup = z.infer<
  typeof InsertTeamExternalGroupSchema
>;
export type AddTeamExternalGroupBody = z.infer<
  typeof AddTeamExternalGroupBodySchema
>;

// Team Vault Folder schemas for BYOS (Bring Your Own Secrets) feature
export const SelectTeamVaultFolderSchema = createSelectSchema(
  schema.teamVaultFoldersTable,
);
export const InsertTeamVaultFolderSchema = createInsertSchema(
  schema.teamVaultFoldersTable,
);
export const UpdateTeamVaultFolderSchema = createUpdateSchema(
  schema.teamVaultFoldersTable,
);

export const SetTeamVaultFolderBodySchema = z.object({
  vaultPath: z.string().min(1, "Vault path is required"),
});

export type TeamVaultFolder = z.infer<typeof SelectTeamVaultFolderSchema>;
export type InsertTeamVaultFolder = z.infer<typeof InsertTeamVaultFolderSchema>;
export type UpdateTeamVaultFolder = z.infer<typeof UpdateTeamVaultFolderSchema>;
export type SetTeamVaultFolderBody = z.infer<
  typeof SetTeamVaultFolderBodySchema
>;
