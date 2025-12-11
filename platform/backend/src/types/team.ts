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
  convertToolResultsToToon: z.boolean().optional(),
});

export const AddTeamMemberBodySchema = z.object({
  userId: z.string(),
  role: z.string().default(MEMBER_ROLE_NAME),
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
export type CreateTeamBody = z.infer<typeof CreateTeamBodySchema>;
export type UpdateTeamBody = z.infer<typeof UpdateTeamBodySchema>;
export type AddTeamMemberBody = z.infer<typeof AddTeamMemberBodySchema>;
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
