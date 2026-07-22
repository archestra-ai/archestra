import {
  TOOL_CREATE_PROJECT_FROM_CONVERSATION_SHORT_NAME,
  TOOL_SET_PROJECT_SHARE_SHORT_NAME,
} from "@archestra/shared";
import { z } from "zod";
import logger from "@/logging";
import { ConversationModel, ProjectModel, TeamModel } from "@/models";
import { projectService } from "@/services/project";
import { ApiError } from "@/types";
import {
  catchError,
  defineArchestraTool,
  defineArchestraTools,
  errorResult,
  structuredSuccessResult,
} from "./helpers";

const SetProjectShareOutputSchema = z.object({
  success: z.literal(true).describe("Whether the sharing was updated."),
  project_id: z.string().describe("The affected project's id."),
  project_name: z.string().describe("The affected project's name."),
  visibility: z
    .enum(["organization", "team", "none"])
    .describe("The project's sharing after the update."),
});

const CreateProjectFromConversationOutputSchema = z.object({
  success: z.literal(true).describe("Whether the project was created."),
  project_id: z.string().describe("The new project's id."),
  project_name: z.string().describe("The new project's name."),
  project_slug: z.string().describe("The new project's slug."),
  files_transferred: z
    .number()
    .int()
    .nonnegative()
    .describe("How many of the chat's files were moved into the project."),
});

const registry = defineArchestraTools([
  defineArchestraTool({
    shortName: TOOL_CREATE_PROJECT_FROM_CONVERSATION_SHORT_NAME,
    title: "Create Project From Chat",
    description:
      "Turn the current chat into a project. Creates a new project, moves this " +
      "chat into it, and transfers the chat's files to the project. Use this " +
      "when the user asks to create a project out of this chat. The project is " +
      "named after the chat unless a name is given. Only works in a user chat " +
      "that is not already part of a project.",
    schema: z
      .object({
        name: z
          .string()
          .optional()
          .describe("Project name. Defaults to the chat's title when omitted."),
        description: z
          .string()
          .optional()
          .describe("Optional project description."),
      })
      .strict(),
    outputSchema: CreateProjectFromConversationOutputSchema,
    async handler({ args, context }) {
      if (
        !context.conversationId ||
        !context.userId ||
        !context.organizationId
      ) {
        return errorResult(
          "This tool requires an active chat conversation. It can only be used within a user chat.",
        );
      }

      logger.info(
        {
          agentId: context.agent.id,
          conversationId: context.conversationId,
        },
        "create_project_from_conversation tool called",
      );

      try {
        const { project, filesMoved } =
          await projectService.createProjectFromConversation({
            organizationId: context.organizationId,
            userId: context.userId,
            conversationId: context.conversationId,
            name: args.name ?? null,
            description: args.description ?? null,
          });
        return structuredSuccessResult(
          {
            success: true,
            project_id: project.id,
            project_name: project.name,
            project_slug: project.slug,
            files_transferred: filesMoved,
          },
          `Created project "${project.name}" from this chat and moved ${filesMoved} file(s) into it.`,
        );
      } catch (error) {
        // Surface the actionable service errors (already in a project, name
        // taken, etc.) to the model verbatim; fall back for the unexpected.
        if (error instanceof ApiError) {
          return errorResult(error.message);
        }
        return catchError(error, "creating a project from this chat");
      }
    },
  }),
  defineArchestraTool({
    shortName: TOOL_SET_PROJECT_SHARE_SHORT_NAME,
    title: "Set Project Sharing",
    description:
      "Change who can see a project: the whole organization " +
      '("organization"), specific teams ("team"), or only the owner ' +
      '("none"). Without a project_id it targets the project the current ' +
      "chat belongs to. Use this when the user asks to share or unshare a " +
      "project, e.g. with the organization or with teams. Team sharing " +
      "takes team ids — use list_teams to find them.",
    schema: z
      .object({
        visibility: z
          .enum(["organization", "team", "none"])
          .describe(
            'Who can see the project: "organization" for everyone in the ' +
              'organization, "team" for the given teams, "none" to make it ' +
              "owner-only.",
          ),
        team_ids: z
          .array(z.string())
          .optional()
          .describe(
            'Ids of the teams to share with. Required when visibility is "team"; ignored otherwise.',
          ),
        project_id: z
          .string()
          .optional()
          .describe(
            "Project to change. Defaults to the current chat's project.",
          ),
      })
      .strict(),
    outputSchema: SetProjectShareOutputSchema,
    async handler({ args, context }) {
      if (!context.userId || !context.organizationId) {
        return errorResult(
          "This tool requires an authenticated user context. It can only be used within a user chat.",
        );
      }
      const { userId, organizationId } = context;

      let projectId = args.project_id ?? null;
      if (!projectId) {
        if (!context.conversationId) {
          return errorResult(
            "No project_id given and there is no active chat to take it from. Pass project_id explicitly.",
          );
        }
        const meta = await ConversationModel.getOwnedMeta({
          id: context.conversationId,
          userId,
          organizationId,
        });
        if (!meta?.projectId) {
          return errorResult(
            "This chat does not belong to a project. Pass project_id to change another project's sharing.",
          );
        }
        projectId = meta.projectId;
      }

      const teamIds = args.visibility === "team" ? (args.team_ids ?? []) : [];
      if (args.visibility === "team") {
        if (teamIds.length === 0) {
          return errorResult(
            'Sharing with visibility "team" requires at least one entry in team_ids. Use list_teams to find team ids.',
          );
        }
        const orgTeamIds = new Set(
          (await TeamModel.findByOrganization(organizationId)).map(
            (team) => team.id,
          ),
        );
        const unknown = teamIds.filter((id) => !orgTeamIds.has(id));
        if (unknown.length > 0) {
          return errorResult(
            `Unknown team id(s): ${unknown.join(", ")}. Use list_teams to find valid team ids.`,
          );
        }
      }

      logger.info(
        {
          agentId: context.agent.id,
          projectId,
          visibility: args.visibility,
        },
        "set_project_share tool called",
      );

      try {
        await projectService.setShare({
          id: projectId,
          organizationId,
          userId,
          visibility: args.visibility === "none" ? null : args.visibility,
          teamIds,
        });
      } catch (error) {
        // Surface the actionable service errors (not found, missing the
        // org-share permission) to the model verbatim; fall back otherwise.
        if (error instanceof ApiError) {
          return errorResult(error.message);
        }
        return catchError(error, "updating the project's sharing");
      }

      // setShare succeeded, so the caller manages this project — the name
      // fetch cannot leak a foreign project.
      const project = await ProjectModel.findById(projectId);
      const summary =
        args.visibility === "organization"
          ? "shared with the whole organization"
          : args.visibility === "team"
            ? `shared with ${teamIds.length} team(s)`
            : "no longer shared (owner-only)";
      return structuredSuccessResult(
        {
          success: true,
          project_id: projectId,
          project_name: project?.name ?? "",
          visibility: args.visibility,
        },
        `Project "${project?.name ?? projectId}" is now ${summary}.`,
      );
    },
  }),
]);

export const toolEntries = registry.toolEntries;
export const tools = registry.tools;
