import {
  PROJECT_INSTRUCTIONS_FILENAME,
  TOOL_CREATE_PROJECT_FROM_CONVERSATION_SHORT_NAME,
  TOOL_GET_PROJECT_SHORT_NAME,
  TOOL_LIST_PROJECTS_SHORT_NAME,
} from "@archestra/shared";
import { z } from "zod";
import logger from "@/logging";
import { projectService } from "@/services/project";
import type { ProjectListItem } from "@/types";
import { ApiError, LabelWithDetailsSchema } from "@/types";
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

/**
 * How much of the instructions `get_project` inlines. Instructions may be up to
 * `PROJECT_INSTRUCTIONS_MAX_LENGTH` (100k chars) — far more than belongs in a
 * single tool result — so a long one is cut here and the caller is told to page
 * the rest through `read_file`, which reads the same underlying file.
 */
const MAX_INLINED_INSTRUCTIONS_CHARS = 20_000;

/** Cap on `list_projects` rows, so a large org cannot flood the caller. */
const MAX_LISTED_PROJECTS = 100;

const ProjectSummarySchema = z.object({
  id: z.string().describe("The project's id — pass it to get_project."),
  name: z.string().describe("The project's name."),
  description: z.string().nullable().describe("The project's description."),
  visibility: z
    .enum(["organization", "team", "user"])
    .nullable()
    .describe("Who the project is shared with; null = owner-only."),
  viewer_role: z
    .enum(["owner", "shared", "admin"])
    .describe("The caller's relationship to the project."),
  owner_name: z.string().nullable().describe("Display name of the owner."),
  labels: z
    .array(LabelWithDetailsSchema)
    .describe("Key/value labels assigned to the project."),
  conversation_count: z
    .number()
    .int()
    .nonnegative()
    .describe("How many chats live in the project."),
  created_at: z.string().describe("ISO 8601 creation timestamp."),
});

const ListProjectsOutputSchema = z.object({
  projects: z
    .array(ProjectSummarySchema)
    .describe("Projects the caller can reach."),
});

const GetProjectOutputSchema = ProjectSummarySchema.extend({
  instructions: z
    .string()
    .describe(
      "The project's instructions markdown; empty when never saved. " +
        "Truncated when `instructions_truncated` is true.",
    ),
  instructions_truncated: z
    .boolean()
    .describe("Whether `instructions` was cut short at the inline limit."),
  files: z
    .array(
      z.object({
        id: z.string().describe("The file's id."),
        ref: z.string().describe("Stable reference to pass to read_file."),
        filename: z.string().describe("The file's name."),
        mime_type: z.string().describe("The file's MIME type."),
        size_bytes: z.number().int().nonnegative().describe("Size in bytes."),
      }),
    )
    .describe(
      "Files the project owns. Read one with read_file, passing the same " +
        "project_id and this `ref`.",
    ),
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
        labels: z
          .array(LabelWithDetailsSchema)
          .optional()
          .describe("Optional key/value labels for the project."),
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
            labels: args.labels,
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
    shortName: TOOL_LIST_PROJECTS_SHORT_NAME,
    title: "List Projects",
    description:
      "List the projects the caller can reach — the ones they own plus those " +
      "shared with them. Use this to find a project's id before calling " +
      "get_project. Optionally narrow by a case-insensitive substring of the " +
      "name or description. Works outside a chat, so an external MCP client " +
      "can discover projects on its own.",
    schema: z
      .object({
        query: z
          .string()
          .optional()
          .describe(
            "Case-insensitive substring matched against the project name and " +
              "description. Omit to list everything the caller can reach.",
          ),
      })
      .strict(),
    outputSchema: ListProjectsOutputSchema,
    async handler({ args, context }) {
      if (!context.userId || !context.organizationId) {
        return errorResult(
          "This tool requires an authenticated user context. Call it with a user token.",
        );
      }
      const { userId, organizationId } = context;

      try {
        // `isProjectAdmin` is deliberately not passed: without a scope filter
        // the service drops admin-oversight rows anyway, so a project admin
        // sees exactly what they can access — same as everyone else. Oversight
        // of other members' private projects stays a UI concern.
        const projects = await projectService.list({
          organizationId,
          userId,
          search: args.query,
        });
        const shown = projects.slice(0, MAX_LISTED_PROJECTS);
        const summary =
          shown.length === 0
            ? "No projects matched."
            : shown
                .map(
                  (p) =>
                    `${p.name} (id=${p.id}, ${p.conversationCount} chat(s))`,
                )
                .join("\n") +
              (projects.length > MAX_LISTED_PROJECTS
                ? `\n(showing the first ${MAX_LISTED_PROJECTS} of ${projects.length}; narrow with query.)`
                : "");
        return structuredSuccessResult(
          { projects: shown.map(toProjectSummary) },
          summary,
        );
      } catch (error) {
        return catchError(error, "listing projects");
      }
    },
  }),
  defineArchestraTool({
    shortName: TOOL_GET_PROJECT_SHORT_NAME,
    title: "Get Project",
    description:
      "Read one project's context in a single call: its metadata, its " +
      `instructions (the \`${PROJECT_INSTRUCTIONS_FILENAME}\` that steers every ` +
      "chat in the project), and the list of files it owns. Use list_projects " +
      "to find the id. To read a file's contents, call read_file with the same " +
      "project_id and the `ref` from the files list. Works outside a chat, so " +
      "an external MCP client can pull a project's context into its own session.",
    schema: z
      .object({
        project_id: z
          .string()
          .describe("Id of the project to read (from list_projects)."),
      })
      .strict(),
    outputSchema: GetProjectOutputSchema,
    async handler({ args, context }) {
      if (!context.userId || !context.organizationId) {
        return errorResult(
          "This tool requires an authenticated user context. Call it with a user token.",
        );
      }
      const { userId, organizationId } = context;

      try {
        // Admin oversight is deliberately NOT enabled here. It would let a
        // project admin list a foreign project's files that the file tools then
        // refuse to read (they authorize on owner/share alone), so the whole
        // headless project surface stays on one access rule.
        const project = await projectService.get({
          id: args.project_id,
          organizationId,
          userId,
        });
        const [{ content }, files] = await Promise.all([
          projectService.getInstructions({
            id: project.id,
            organizationId,
            userId,
          }),
          projectService.listFiles({ id: project.id, organizationId, userId }),
        ]);

        const truncated = content.length > MAX_INLINED_INSTRUCTIONS_CHARS;
        const instructions = truncated
          ? content.slice(0, MAX_INLINED_INSTRUCTIONS_CHARS)
          : content;

        const result = {
          ...toProjectSummary(project),
          instructions,
          instructions_truncated: truncated,
          files: files.map((f) => ({
            id: f.id,
            ref: f.downloadRef,
            filename: f.filename,
            mime_type: f.mimeType,
            size_bytes: f.sizeBytes,
          })),
        };
        const instructionsLine = content
          ? truncated
            ? `Instructions (first ${MAX_INLINED_INSTRUCTIONS_CHARS} of ${content.length} chars — page the rest with read_file on ${PROJECT_INSTRUCTIONS_FILENAME}):\n${instructions}`
            : `Instructions:\n${instructions}`
          : "Instructions: (none saved yet)";
        const filesLine =
          files.length === 0
            ? "Files: (none)"
            : `Files:\n${files
                .map(
                  (f) =>
                    `${f.filename} (${f.mimeType}, ${f.sizeBytes} bytes) ref=${f.downloadRef}`,
                )
                .join("\n")}`;
        return structuredSuccessResult(
          result,
          `Project "${project.name}" (id=${project.id})\n\n${instructionsLine}\n\n${filesLine}`,
        );
      } catch (error) {
        // "Project not found" (the 404 that also covers "no access") is the
        // actionable answer; surface it verbatim.
        if (error instanceof ApiError) {
          return errorResult(error.message);
        }
        return catchError(error, "reading the project");
      }
    },
  }),
]);

export const toolEntries = registry.toolEntries;
export const tools = registry.tools;

// === Internal helpers ===

/** Project row → the compact shape both project read tools return. */
function toProjectSummary(project: ProjectListItem) {
  return {
    id: project.id,
    name: project.name,
    description: project.description,
    visibility: project.visibility,
    viewer_role: project.viewerRole,
    owner_name: project.ownerName,
    labels: project.labels,
    conversation_count: project.conversationCount,
    created_at: project.createdAt.toISOString(),
  };
}
