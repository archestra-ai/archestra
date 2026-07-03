import { TOOL_CREATE_PROJECT_FROM_CONVERSATION_SHORT_NAME } from "@archestra/shared";
import { z } from "zod";
import logger from "@/logging";
import { projectService } from "@/services/project";
import { ApiError } from "@/types";
import {
  catchError,
  defineArchestraTool,
  defineArchestraTools,
  errorResult,
  structuredSuccessResult,
} from "./helpers";

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
]);

export const toolEntries = registry.toolEntries;
export const tools = registry.tools;
