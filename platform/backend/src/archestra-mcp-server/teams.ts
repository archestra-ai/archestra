import {
  TOOL_ADD_TEAM_MEMBER_SHORT_NAME,
  TOOL_CREATE_TEAM_SHORT_NAME,
  TOOL_DELETE_TEAM_SHORT_NAME,
  TOOL_EDIT_TEAM_SHORT_NAME,
  TOOL_GET_TEAM_SHORT_NAME,
  TOOL_LIST_TEAM_MEMBERS_SHORT_NAME,
  TOOL_LIST_TEAMS_SHORT_NAME,
  TOOL_REMOVE_TEAM_MEMBER_SHORT_NAME,
  TOOL_UPDATE_TEAM_MEMBER_ROLE_SHORT_NAME,
} from "@archestra/shared";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { userHasPermission } from "@/auth/utils";
import logger from "@/logging";
import { MemberModel, TeamModel } from "@/models";
import {
  canManageTeamMembers,
  canReadTeam,
  checkLastAdminInvariant,
  cleanupCredentialSourcesAfterMemberRemoval,
  getTeamForOrg,
} from "@/services/team-authorization";
import type { Team, TeamMember, TeamMemberListItem } from "@/types";
import { TeamMemberRoleSchema, UuidIdSchema } from "@/types";
import {
  catchError,
  defineArchestraTool,
  defineArchestraTools,
  errorResult,
  structuredSuccessResult,
} from "./helpers";
import type { ArchestraContext } from "./types";

// === Constants ===

const TeamOutputItemSchema = z.object({
  id: z.string().describe("The team ID."),
  name: z.string().describe("The team name."),
  description: z.string().nullable().describe("The team description, if any."),
  organizationId: z.string().describe("The organization the team belongs to."),
  createdBy: z
    .string()
    .nullable()
    .describe("The ID of the user who created the team."),
  memberCount: z
    .number()
    .describe("The number of members currently in the team."),
  createdAt: z.string().describe("ISO timestamp when the team was created."),
  updatedAt: z
    .string()
    .describe("ISO timestamp when the team was last updated."),
});

const TeamMemberOutputItemSchema = z.object({
  id: z.string().describe("The team membership row ID."),
  teamId: z.string().describe("The team the membership belongs to."),
  userId: z.string().describe("The ID of the member user."),
  role: TeamMemberRoleSchema.describe(
    "The member's role within the team (admin or member).",
  ),
  syncedFromSso: z
    .boolean()
    .describe("Whether this membership is managed by SSO group sync."),
  name: z
    .string()
    .nullable()
    .optional()
    .describe("The member's display name, when available."),
  email: z.string().optional().describe("The member's email, when available."),
  createdAt: z
    .string()
    .describe("ISO timestamp when the membership was created."),
});

const CreateTeamToolArgsSchema = z
  .object({
    name: z
      .string()
      .min(1, "Team name is required")
      .max(256, "Team name must be at most 256 characters")
      .describe("The name of the team."),
    description: z
      .string()
      .optional()
      .describe("Optional human-readable description of the team."),
  })
  .strict();

const GetTeamToolArgsSchema = z
  .object({
    id: UuidIdSchema.optional().describe("The ID of the team to fetch."),
    name: z
      .string()
      .optional()
      .describe("The name of the team to fetch (within the organization)."),
  })
  .strict()
  .superRefine((args, ctx) => {
    if (!args.id && !args.name) {
      ctx.addIssue({
        code: "custom",
        path: ["id"],
        message: "Provide either an id or a name to look up the team.",
      });
    }
  });

const EditTeamToolArgsSchema = z
  .object({
    id: UuidIdSchema.describe("The ID of the team to update."),
    name: z
      .string()
      .min(1)
      .max(256, "Team name must be at most 256 characters")
      .optional()
      .describe("Optional new team name."),
    description: z
      .string()
      .nullable()
      .optional()
      .describe(
        "Optional new team description. Pass null to clear an existing description.",
      ),
  })
  .strict();

const DeleteTeamToolArgsSchema = z
  .object({
    id: UuidIdSchema.describe("The ID of the team to delete."),
  })
  .strict();

const ListTeamMembersToolArgsSchema = z
  .object({
    team_id: UuidIdSchema.describe("The ID of the team whose members to list."),
  })
  .strict();

const AddTeamMemberToolArgsSchema = z
  .object({
    team_id: UuidIdSchema.describe("The ID of the team to add the member to."),
    user: z
      .string()
      .min(1)
      .describe(
        "The user to add, identified by their user ID or email address. The user must already belong to the organization.",
      ),
    role: TeamMemberRoleSchema.optional().describe(
      "The role to assign within the team. Defaults to 'member'.",
    ),
  })
  .strict();

const UpdateTeamMemberRoleToolArgsSchema = z
  .object({
    team_id: UuidIdSchema.describe("The ID of the team."),
    user_id: z.string().min(1).describe("The ID of the member user to update."),
    role: TeamMemberRoleSchema.describe(
      "The new role for the member (admin or member).",
    ),
  })
  .strict();

const RemoveTeamMemberToolArgsSchema = z
  .object({
    team_id: UuidIdSchema.describe("The ID of the team."),
    user_id: z
      .string()
      .min(1)
      .describe("The ID of the member user to remove from the team."),
  })
  .strict();

const registry = defineArchestraTools([
  defineArchestraTool({
    shortName: TOOL_CREATE_TEAM_SHORT_NAME,
    title: "Create Team",
    description:
      "Create a new team in the organization. Teams group users and control access to profiles and MCP servers.",
    schema: CreateTeamToolArgsSchema,
    outputSchema: z.object({ team: TeamOutputItemSchema }),
    async handler({ args, context }) {
      return handleCreateTeam({ args, context });
    },
  }),
  defineArchestraTool({
    shortName: TOOL_GET_TEAM_SHORT_NAME,
    title: "Get Team",
    description:
      "Retrieve a single team by its ID or name, including its current member count.",
    schema: GetTeamToolArgsSchema,
    outputSchema: z.object({ team: TeamOutputItemSchema }),
    async handler({ args, context }) {
      return handleGetTeam({ args, context });
    },
  }),
  defineArchestraTool({
    shortName: TOOL_LIST_TEAMS_SHORT_NAME,
    title: "List Teams",
    description:
      "List all teams in the organization, optionally filtered by a name substring.",
    schema: z
      .object({
        name: z
          .string()
          .optional()
          .describe("Optional case-insensitive name substring to filter by."),
      })
      .strict(),
    outputSchema: z.object({ teams: z.array(TeamOutputItemSchema) }),
    async handler({ args, context }) {
      return handleListTeams({ args, context });
    },
  }),
  defineArchestraTool({
    shortName: TOOL_EDIT_TEAM_SHORT_NAME,
    title: "Edit Team",
    description:
      "Update a team's name and/or description. At least one field must be provided.",
    schema: EditTeamToolArgsSchema,
    outputSchema: z.object({ team: TeamOutputItemSchema }),
    async handler({ args, context }) {
      return handleEditTeam({ args, context });
    },
  }),
  defineArchestraTool({
    shortName: TOOL_DELETE_TEAM_SHORT_NAME,
    title: "Delete Team",
    description:
      "Delete a team by ID. This also removes all of the team's memberships.",
    schema: DeleteTeamToolArgsSchema,
    outputSchema: z.object({ success: z.literal(true), id: z.string() }),
    async handler({ args, context }) {
      return handleDeleteTeam({ args, context });
    },
  }),
  defineArchestraTool({
    shortName: TOOL_LIST_TEAM_MEMBERS_SHORT_NAME,
    title: "List Team Members",
    description: "List all members of a team along with their roles.",
    schema: ListTeamMembersToolArgsSchema,
    outputSchema: z.object({
      members: z.array(TeamMemberOutputItemSchema),
    }),
    async handler({ args, context }) {
      return handleListTeamMembers({ args, context });
    },
  }),
  defineArchestraTool({
    shortName: TOOL_ADD_TEAM_MEMBER_SHORT_NAME,
    title: "Add Team Member",
    description:
      "Add an organization user to a team by user ID or email, optionally as an admin.",
    schema: AddTeamMemberToolArgsSchema,
    outputSchema: z.object({ member: TeamMemberOutputItemSchema }),
    async handler({ args, context }) {
      return handleAddTeamMember({ args, context });
    },
  }),
  defineArchestraTool({
    shortName: TOOL_UPDATE_TEAM_MEMBER_ROLE_SHORT_NAME,
    title: "Update Team Member Role",
    description:
      "Change a team member's role between admin and member. The last admin of a team cannot be demoted.",
    schema: UpdateTeamMemberRoleToolArgsSchema,
    outputSchema: z.object({ member: TeamMemberOutputItemSchema }),
    async handler({ args, context }) {
      return handleUpdateTeamMemberRole({ args, context });
    },
  }),
  defineArchestraTool({
    shortName: TOOL_REMOVE_TEAM_MEMBER_SHORT_NAME,
    title: "Remove Team Member",
    description:
      "Remove a member from a team. The last admin of a team cannot be removed.",
    schema: RemoveTeamMemberToolArgsSchema,
    outputSchema: z.object({
      success: z.literal(true),
      teamId: z.string(),
      userId: z.string(),
    }),
    async handler({ args, context }) {
      return handleRemoveTeamMember({ args, context });
    },
  }),
] as const);

export const toolEntries = registry.toolEntries;

// === Exports ===

export const tools = registry.tools;

// === Internal helpers ===

/**
 * Fetch a team scoped to the caller's organization. Returns null when the team
 * does not exist or belongs to a different organization, so a caller can never
 * read or mutate teams outside their org.
 */
async function findTeamInOrg(
  teamId: string,
  organizationId: string | undefined,
): Promise<Team | null> {
  if (!organizationId) {
    return null;
  }
  return getTeamForOrg({ teamId, organizationId });
}

/**
 * Whether the caller can manage every team in the org. Mirrors the REST route:
 * the org-level `team:create` permission is the "team manager" signal (held by
 * admins and custom roles granted it). MCP sessions carry no request headers,
 * so this resolves from the user's role permissions.
 */
async function isOrgTeamManager(context: ArchestraContext): Promise<boolean> {
  if (!context.userId || !context.organizationId) {
    return false;
  }
  return userHasPermission(
    context.userId,
    context.organizationId,
    "team",
    "create",
  );
}

/**
 * Read access to a specific team, mapped to an MCP result: allowed → null;
 * denied → a not-found error (never disclosing the team's existence, matching
 * the REST route). Authorization itself lives in the shared service.
 */
async function assertCanReadTeam(
  context: ArchestraContext,
  teamId: string,
): Promise<CallToolResult | null> {
  if (!context.userId) {
    return errorResult(`Team with ID ${teamId} not found.`);
  }
  const allowed = await canReadTeam({
    isOrgTeamManager: await isOrgTeamManager(context),
    userId: context.userId,
    teamId,
  });
  return allowed ? null : errorResult(`Team with ID ${teamId} not found.`);
}

/**
 * Membership-management access, mapped to an MCP result: allowed → null;
 * denied → a permission error. Authorization itself lives in the shared
 * service (org-level team manager OR admin of that specific team).
 */
async function assertCanManageTeamMembers(
  context: ArchestraContext,
  teamId: string,
): Promise<CallToolResult | null> {
  const allowed =
    !!context.userId &&
    (await canManageTeamMembers({
      isOrgTeamManager: await isOrgTeamManager(context),
      userId: context.userId,
      teamId,
    }));
  return allowed
    ? null
    : errorResult(
        "You must be a team admin or have organization-level team management permission to manage this team's members.",
      );
}

function serializeTeam(team: Team, memberCount: number) {
  return {
    id: team.id,
    name: team.name,
    description: team.description ?? null,
    organizationId: team.organizationId,
    createdBy: team.createdBy ?? null,
    memberCount,
    createdAt: team.createdAt.toISOString(),
    updatedAt: team.updatedAt.toISOString(),
  };
}

function serializeMember(member: TeamMember | TeamMemberListItem) {
  return {
    id: member.id,
    teamId: member.teamId,
    userId: member.userId,
    role: member.role,
    syncedFromSso: member.syncedFromSso,
    name: "name" in member ? member.name : undefined,
    email: "email" in member ? member.email : undefined,
    createdAt: member.createdAt.toISOString(),
  };
}

async function handleCreateTeam(params: {
  args: z.infer<typeof CreateTeamToolArgsSchema>;
  context: ArchestraContext;
}): Promise<CallToolResult> {
  const { args, context } = params;
  logger.info(
    { agentId: context.agent.id, createTeamArgs: args },
    "create_team tool called",
  );

  if (!context.organizationId || !context.userId) {
    return errorResult("User context not available.");
  }

  try {
    const team = await TeamModel.create({
      name: args.name,
      description: args.description,
      organizationId: context.organizationId,
      createdBy: context.userId,
    });

    // A freshly created team has no members yet.
    const serialized = serializeTeam(team, 0);
    return structuredSuccessResult(
      { team: serialized },
      `Successfully created team.\n\nTeam ID: ${serialized.id}\nName: ${serialized.name}${
        serialized.description ? `\nDescription: ${serialized.description}` : ""
      }`,
    );
  } catch (error) {
    return catchError(error, "creating team");
  }
}

async function handleGetTeam(params: {
  args: z.infer<typeof GetTeamToolArgsSchema>;
  context: ArchestraContext;
}): Promise<CallToolResult> {
  const { args, context } = params;
  logger.info(
    { agentId: context.agent.id, getTeamArgs: args },
    "get_team tool called",
  );

  if (!context.organizationId) {
    return errorResult("Organization context not available.");
  }

  try {
    const team = args.id
      ? await findTeamInOrg(args.id, context.organizationId)
      : args.name
        ? await TeamModel.findByName(args.name, context.organizationId)
        : null;

    if (!team) {
      return errorResult(
        args.id
          ? `Team with ID ${args.id} not found.`
          : `Team named "${args.name}" not found.`,
      );
    }

    const readDenied = await assertCanReadTeam(context, team.id);
    if (readDenied) {
      return readDenied;
    }

    // findByName does not hydrate members; count them explicitly.
    const members = await TeamModel.getTeamMembers(team.id);
    const serialized = serializeTeam(team, members.length);
    return structuredSuccessResult(
      { team: serialized },
      `Team ID: ${serialized.id}\nName: ${serialized.name}${
        serialized.description ? `\nDescription: ${serialized.description}` : ""
      }\nMembers: ${serialized.memberCount}`,
    );
  } catch (error) {
    return catchError(error, "getting team");
  }
}

async function handleListTeams(params: {
  args: { name?: string };
  context: ArchestraContext;
}): Promise<CallToolResult> {
  const { args, context } = params;
  logger.info(
    { agentId: context.agent.id, listTeamsArgs: args },
    "list_teams tool called",
  );

  if (!context.organizationId) {
    return errorResult("Organization context not available.");
  }

  try {
    // Non-manager visibility filtering below relies on `findByOrganization`
    // hydrating each team's `members` relation.
    const teams = await TeamModel.findByOrganization(context.organizationId);
    // Org-level team managers see every team; everyone else only the teams
    // they belong to (mirrors the REST GET /api/teams behavior).
    const isManager = await isOrgTeamManager(context);
    const visible = isManager
      ? teams
      : teams.filter((team) =>
          team.members?.some((member) => member.userId === context.userId),
        );

    const nameFilter = args.name?.toLowerCase();
    const filtered = nameFilter
      ? visible.filter((team) => team.name.toLowerCase().includes(nameFilter))
      : visible;

    const serialized = filtered.map((team) =>
      serializeTeam(team, team.members?.length ?? 0),
    );

    if (serialized.length === 0) {
      return structuredSuccessResult(
        { teams: [] },
        args.name
          ? `No teams found matching "${args.name}".`
          : "No teams found.",
      );
    }

    const formatted = serialized
      .map(
        (team) =>
          `**${team.name}** (ID: ${team.id}) — ${team.memberCount} member(s)`,
      )
      .join("\n");

    return structuredSuccessResult(
      { teams: serialized },
      `Found ${serialized.length} team(s):\n\n${formatted}`,
    );
  } catch (error) {
    return catchError(error, "listing teams");
  }
}

async function handleEditTeam(params: {
  args: z.infer<typeof EditTeamToolArgsSchema>;
  context: ArchestraContext;
}): Promise<CallToolResult> {
  const { args, context } = params;
  logger.info(
    { agentId: context.agent.id, editTeamArgs: args },
    "edit_team tool called",
  );

  if (!context.organizationId) {
    return errorResult("Organization context not available.");
  }

  try {
    if (args.name === undefined && args.description === undefined) {
      return errorResult("No fields provided to update.");
    }

    const existing = await findTeamInOrg(args.id, context.organizationId);
    if (!existing) {
      return errorResult(`Team with ID ${args.id} not found.`);
    }

    const updated = await TeamModel.update(args.id, {
      ...(args.name !== undefined ? { name: args.name } : {}),
      ...(args.description !== undefined
        ? { description: args.description }
        : {}),
    });

    if (!updated) {
      return errorResult(`Team with ID ${args.id} not found.`);
    }

    const serialized = serializeTeam(updated, updated.members?.length ?? 0);
    return structuredSuccessResult(
      { team: serialized },
      `Successfully updated team.\n\nTeam ID: ${serialized.id}\nName: ${serialized.name}${
        serialized.description ? `\nDescription: ${serialized.description}` : ""
      }`,
    );
  } catch (error) {
    return catchError(error, "updating team");
  }
}

async function handleDeleteTeam(params: {
  args: z.infer<typeof DeleteTeamToolArgsSchema>;
  context: ArchestraContext;
}): Promise<CallToolResult> {
  const { args, context } = params;
  logger.info(
    { agentId: context.agent.id, deleteTeamArgs: args },
    "delete_team tool called",
  );

  if (!context.organizationId) {
    return errorResult("Organization context not available.");
  }

  try {
    const existing = await findTeamInOrg(args.id, context.organizationId);
    if (!existing) {
      return errorResult(`Team with ID ${args.id} not found.`);
    }

    const deleted = await TeamModel.delete(args.id);
    if (!deleted) {
      return errorResult(`Team with ID ${args.id} not found.`);
    }

    return structuredSuccessResult(
      { success: true, id: args.id },
      `Successfully deleted team with ID: ${args.id}`,
    );
  } catch (error) {
    return catchError(error, "deleting team");
  }
}

async function handleListTeamMembers(params: {
  args: z.infer<typeof ListTeamMembersToolArgsSchema>;
  context: ArchestraContext;
}): Promise<CallToolResult> {
  const { args, context } = params;
  logger.info(
    { agentId: context.agent.id, listTeamMembersArgs: args },
    "list_team_members tool called",
  );

  if (!context.organizationId) {
    return errorResult("Organization context not available.");
  }

  try {
    const team = await findTeamInOrg(args.team_id, context.organizationId);
    if (!team) {
      return errorResult(`Team with ID ${args.team_id} not found.`);
    }

    const readDenied = await assertCanReadTeam(context, team.id);
    if (readDenied) {
      return readDenied;
    }

    const members = await TeamModel.getTeamMembersWithUsers(args.team_id);
    const serialized = members.map(serializeMember);

    if (serialized.length === 0) {
      return structuredSuccessResult(
        { members: [] },
        `Team "${team.name}" has no members.`,
      );
    }

    const formatted = serialized
      .map(
        (member) =>
          `- ${member.name ?? member.email ?? member.userId} (${member.userId}) — ${member.role}`,
      )
      .join("\n");

    return structuredSuccessResult(
      { members: serialized },
      `Team "${team.name}" has ${serialized.length} member(s):\n\n${formatted}`,
    );
  } catch (error) {
    return catchError(error, "listing team members");
  }
}

async function handleAddTeamMember(params: {
  args: z.infer<typeof AddTeamMemberToolArgsSchema>;
  context: ArchestraContext;
}): Promise<CallToolResult> {
  const { args, context } = params;
  logger.info(
    { agentId: context.agent.id, addTeamMemberArgs: args },
    "add_team_member tool called",
  );

  if (!context.organizationId) {
    return errorResult("Organization context not available.");
  }

  try {
    const team = await findTeamInOrg(args.team_id, context.organizationId);
    if (!team) {
      return errorResult(`Team with ID ${args.team_id} not found.`);
    }

    const manageDenied = await assertCanManageTeamMembers(context, team.id);
    if (manageDenied) {
      return manageDenied;
    }

    // Resolve the user by ID or email, scoped to the caller's org. This both
    // maps an email to a user ID and ensures the user belongs to the org.
    const orgUser = await MemberModel.findByIdOrEmail(
      args.user,
      context.organizationId,
    );
    if (!orgUser) {
      return errorResult(
        `No user matching "${args.user}" found in this organization.`,
      );
    }

    const alreadyMember = await TeamModel.isUserInTeam(
      args.team_id,
      orgUser.id,
    );
    if (alreadyMember) {
      return errorResult("User is already a member of this team.");
    }

    const member = await TeamModel.addMember(
      args.team_id,
      orgUser.id,
      args.role,
    );

    const serialized = serializeMember(member);
    return structuredSuccessResult(
      { member: serialized },
      `Successfully added ${orgUser.name ?? orgUser.email} to team "${team.name}" as ${serialized.role}.`,
    );
  } catch (error) {
    return catchError(error, "adding team member");
  }
}

async function handleUpdateTeamMemberRole(params: {
  args: z.infer<typeof UpdateTeamMemberRoleToolArgsSchema>;
  context: ArchestraContext;
}): Promise<CallToolResult> {
  const { args, context } = params;
  logger.info(
    { agentId: context.agent.id, updateTeamMemberRoleArgs: args },
    "update_team_member_role tool called",
  );

  if (!context.organizationId) {
    return errorResult("Organization context not available.");
  }

  try {
    const team = await findTeamInOrg(args.team_id, context.organizationId);
    if (!team) {
      return errorResult(`Team with ID ${args.team_id} not found.`);
    }

    const manageDenied = await assertCanManageTeamMembers(context, team.id);
    if (manageDenied) {
      return manageDenied;
    }

    const lastAdminError = await checkNotRemovingLastAdmin({
      teamId: args.team_id,
      userId: args.user_id,
      nextRole: args.role,
    });
    if (lastAdminError) {
      return lastAdminError;
    }

    const member = await TeamModel.updateMemberRole({
      teamId: args.team_id,
      userId: args.user_id,
      role: args.role,
    });

    if (!member) {
      return errorResult("Team member not found.");
    }

    const serialized = serializeMember(member);
    return structuredSuccessResult(
      { member: serialized },
      `Successfully updated member ${args.user_id} in team "${team.name}" to ${serialized.role}.`,
    );
  } catch (error) {
    return catchError(error, "updating team member role");
  }
}

async function handleRemoveTeamMember(params: {
  args: z.infer<typeof RemoveTeamMemberToolArgsSchema>;
  context: ArchestraContext;
}): Promise<CallToolResult> {
  const { args, context } = params;
  logger.info(
    { agentId: context.agent.id, removeTeamMemberArgs: args },
    "remove_team_member tool called",
  );

  if (!context.organizationId) {
    return errorResult("Organization context not available.");
  }

  try {
    const team = await findTeamInOrg(args.team_id, context.organizationId);
    if (!team) {
      return errorResult(`Team with ID ${args.team_id} not found.`);
    }

    const manageDenied = await assertCanManageTeamMembers(context, team.id);
    if (manageDenied) {
      return manageDenied;
    }

    const lastAdminError = await checkNotRemovingLastAdmin({
      teamId: args.team_id,
      userId: args.user_id,
      nextRole: null,
    });
    if (lastAdminError) {
      return lastAdminError;
    }

    const removed = await TeamModel.removeMember(args.team_id, args.user_id);
    if (!removed) {
      return errorResult("Team member not found.");
    }

    // Drop personal-credential assignments the removed user can no longer reach
    // through any team. Best-effort — a cleanup failure must not fail the
    // removal (same contract as the REST route).
    if (context.userId) {
      try {
        await cleanupCredentialSourcesAfterMemberRemoval({
          actingUserId: context.userId,
          removedUserId: args.user_id,
          teamId: args.team_id,
          organizationId: context.organizationId,
        });
      } catch (cleanupError) {
        logger.error(
          { err: cleanupError, teamId: args.team_id, userId: args.user_id },
          "Error cleaning up credential sources after team member removal",
        );
      }
    }

    return structuredSuccessResult(
      { success: true, teamId: args.team_id, userId: args.user_id },
      `Successfully removed member ${args.user_id} from team "${team.name}".`,
    );
  } catch (error) {
    return catchError(error, "removing team member");
  }
}

/**
 * Map the shared last-admin invariant onto an MCP result: allowed → null;
 * denied → the corresponding error.
 */
async function checkNotRemovingLastAdmin(params: {
  teamId: string;
  userId: string;
  nextRole: z.infer<typeof TeamMemberRoleSchema> | null;
}): Promise<CallToolResult | null> {
  const check = await checkLastAdminInvariant(params);
  if (check.ok) {
    return null;
  }
  return errorResult(
    check.reason === "last_admin"
      ? "Cannot remove the last admin from a team."
      : "Team member not found.",
  );
}
