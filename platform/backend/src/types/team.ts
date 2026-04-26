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
export const SelectTeamMemberListItemSchema = SelectTeamMemberSchema.extend({
  name: z.string().nullable(),
  email: z.string(),
  image: z.string().nullable(),
});
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

/**
 * Schema for updating team-level Kubernetes deployment settings.
 * Allows admins to configure a per-team namespace or separate cluster
 * for MCP servers belonging to this team.
 */
export const UpdateTeamK8sSettingsBodySchema = z.object({
  /**
   * Target Kubernetes namespace for MCP servers deployed by this team.
   * Set to null to remove the override and fall back to the org/global default.
   */
  k8sNamespace: z.string().min(1).nullable().optional(),
  /**
   * Base64-encoded KUBECONFIG content for a separate Kubernetes cluster.
   * Set to null to remove the override and use the org/global cluster.
   */
  k8sKubeconfigBase64: z.string().min(1).nullable().optional(),
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
export type TeamMemberListItem = z.infer<typeof SelectTeamMemberListItemSchema>;
export type CreateTeamBody = z.infer<typeof CreateTeamBodySchema>;
export type UpdateTeamBody = z.infer<typeof UpdateTeamBodySchema>;
export type AddTeamMemberBody = z.infer<typeof AddTeamMemberBodySchema>;
export type UpdateTeamK8sSettingsBody = z.infer<
  typeof UpdateTeamK8sSettingsBodySchema
>;
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
