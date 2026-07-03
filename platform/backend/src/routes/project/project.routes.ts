import {
  MAX_PROJECT_UPLOAD_BYTES,
  PROJECT_DESCRIPTION_MAX_LENGTH,
  PROJECT_INSTRUCTIONS_MAX_LENGTH,
  PROJECT_NAME_MAX_LENGTH,
  RouteId,
} from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { userHasPermission } from "@/auth";
import { projectService } from "@/services/project";
import {
  constructResponseSchema,
  ProjectConversationItemSchema,
  ProjectDetailSchema,
  ProjectListItemSchema,
  ProjectListScopeSchema,
  ProjectShareVisibilitySchema,
  SandboxFileListItemSchema,
} from "@/types";

/** A comma-separated query param parsed into a string[] (mirrors the agents list). */
const CommaSeparatedIds = z.preprocess(
  (val) => (typeof val === "string" ? val.split(",").filter(Boolean) : val),
  z.array(z.string()),
);

/**
 * Body limit for a single-file upload: the 25 MB cap as base64 (~4/3) plus the
 * small JSON envelope (name + mimeType + keys). Tighter than the global body
 * limit so an oversized body is rejected at parse time, before a ~190 MB
 * decode, instead of relying only on the handler's decoded-size 413.
 */
const PROJECT_UPLOAD_BODY_LIMIT =
  Math.ceil(MAX_PROJECT_UPLOAD_BYTES / 3) * 4 + 64 * 1024;

/**
 * Projects: named collections of chats that own a set of files. Read access
 * follows the project share (org / teams / owner-only); mutations are
 * owner-only and "not yours" is indistinguishable from 404.
 */
const projectRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.post(
    "/api/projects",
    {
      schema: {
        operationId: RouteId.CreateProject,
        description:
          "Create a project. Files produced in its chats are owned by the " +
          "project rather than the individual author.",
        tags: ["Projects"],
        body: z.object({
          name: z.string().min(1).max(PROJECT_NAME_MAX_LENGTH),
          description: z
            .string()
            .max(PROJECT_DESCRIPTION_MAX_LENGTH)
            .nullable()
            .optional(),
          icon: z.string().max(1_000_000).nullable().optional(),
        }),
        response: constructResponseSchema(ProjectListItemSchema),
      },
    },
    async ({ body, organizationId, user }) => {
      const project = await projectService.create({
        organizationId,
        userId: user.id,
        name: body.name,
        description: body.description ?? null,
        icon: body.icon ?? null,
      });
      return {
        id: project.id,
        name: project.name,
        description: project.description,
        icon: project.icon,
        viewerRole: "owner" as const,
        ownerName: user.name ?? null,
        conversationCount: 0,
        visibility: null,
        shareTeamNames: null,
        pinnedAt: null,
        createdAt: project.createdAt,
      };
    },
  );

  fastify.post(
    "/api/projects/from-conversation",
    {
      schema: {
        operationId: RouteId.CreateProjectFromConversation,
        description:
          "Turn an existing chat into a project: create the project, move the " +
          "chat into it, and re-point the chat's files to the project. Only the " +
          "chat's owner may do this, and only for a user chat not already in a " +
          "project. `name` defaults to the chat title.",
        tags: ["Projects"],
        body: z.object({
          conversationId: z.string().uuid(),
          name: z.string().min(1).max(PROJECT_NAME_MAX_LENGTH).optional(),
          description: z
            .string()
            .max(PROJECT_DESCRIPTION_MAX_LENGTH)
            .nullable()
            .optional(),
          icon: z.string().max(1_000_000).nullable().optional(),
        }),
        response: constructResponseSchema(ProjectListItemSchema),
      },
    },
    async ({ body, organizationId, user }) => {
      const { project } = await projectService.createProjectFromConversation({
        organizationId,
        userId: user.id,
        conversationId: body.conversationId,
        name: body.name ?? null,
        description: body.description ?? null,
        icon: body.icon ?? null,
      });
      return {
        id: project.id,
        name: project.name,
        description: project.description,
        icon: project.icon,
        viewerRole: "owner" as const,
        ownerName: user.name ?? null,
        conversationCount: 1,
        visibility: null,
        shareTeamNames: null,
        pinnedAt: null,
        createdAt: project.createdAt,
      };
    },
  );

  fastify.get(
    "/api/projects",
    {
      schema: {
        operationId: RouteId.GetProjects,
        description:
          "List projects the caller can see. `scope` is the project's share " +
          "visibility: `personal` (private), `team` (shared with teams — narrow " +
          "with `teamIds`), or `org` (org-wide); omitted = all visible. Admins " +
          "additionally filter `personal` by owner via `authorIds` / " +
          "`excludeAuthorIds` (ignored for non-admins). `search` matches name + " +
          "description.",
        tags: ["Projects"],
        querystring: z.object({
          scope: ProjectListScopeSchema.optional(),
          search: z.string().optional(),
          teamIds: CommaSeparatedIds.optional().describe(
            "Team IDs (comma-separated); only used when scope=team.",
          ),
          authorIds: CommaSeparatedIds.optional().describe(
            "Owner user IDs (comma-separated). Admin-only; used with scope=personal.",
          ),
          excludeAuthorIds: CommaSeparatedIds.optional().describe(
            "Exclude owner user IDs (comma-separated). Admin-only; used with scope=personal.",
          ),
        }),
        response: constructResponseSchema(z.array(ProjectListItemSchema)),
      },
    },
    async ({ query, organizationId, user }) => {
      const isProjectAdmin = await userHasPermission(
        user.id,
        organizationId,
        "project",
        "admin",
      );
      return projectService.list({
        organizationId,
        userId: user.id,
        isProjectAdmin,
        scope: query.scope,
        teamIds: query.teamIds,
        // The owner sub-filter is admin-only; ignore it for everyone else.
        authorIds: isProjectAdmin ? query.authorIds : undefined,
        excludeAuthorIds: isProjectAdmin ? query.excludeAuthorIds : undefined,
        search: query.search,
      });
    },
  );

  fastify.get(
    "/api/projects/:id",
    {
      schema: {
        operationId: RouteId.GetProject,
        description:
          "Project detail. Share team ids are included for the owner only.",
        tags: ["Projects"],
        params: z.object({ id: z.string().uuid() }),
        response: constructResponseSchema(ProjectDetailSchema),
      },
    },
    async ({ params: { id }, organizationId, user }) =>
      projectService.get({
        id,
        organizationId,
        userId: user.id,
        allowAdminOversight: true,
      }),
  );

  fastify.patch(
    "/api/projects/:id",
    {
      schema: {
        operationId: RouteId.UpdateProject,
        description:
          "Update a project's name, description, and/or icon (owner or a " +
          "project admin). Only the provided fields change.",
        tags: ["Projects"],
        params: z.object({ id: z.string().uuid() }),
        body: z.object({
          name: z.string().min(1).max(PROJECT_NAME_MAX_LENGTH).optional(),
          description: z
            .string()
            .max(PROJECT_DESCRIPTION_MAX_LENGTH)
            .nullable()
            .optional(),
          icon: z.string().max(1_000_000).nullable().optional(),
        }),
        response: constructResponseSchema(z.object({ ok: z.literal(true) })),
      },
    },
    async ({ params: { id }, body, organizationId, user }) => {
      await projectService.update({
        id,
        organizationId,
        userId: user.id,
        name: body.name,
        description: body.description,
        icon: body.icon,
      });
      return { ok: true as const };
    },
  );

  fastify.put(
    "/api/projects/:id/share",
    {
      schema: {
        operationId: RouteId.SetProjectShare,
        description:
          "Set who can see the project (owner or a project admin): the whole " +
          'organization, specific teams, or nobody (visibility "none" unshares).',
        tags: ["Projects"],
        params: z.object({ id: z.string().uuid() }),
        body: z.object({
          // "none" unshares — expressed as a value (not null) because the
          // generated client cannot represent a nullable enum.
          visibility: ProjectShareVisibilitySchema.or(z.literal("none")),
          teamIds: z.array(z.string()).default([]),
        }),
        response: constructResponseSchema(z.object({ ok: z.literal(true) })),
      },
    },
    async ({ params: { id }, body, organizationId, user }) => {
      await projectService.setShare({
        id,
        organizationId,
        userId: user.id,
        visibility: body.visibility === "none" ? null : body.visibility,
        teamIds: body.teamIds,
      });
      return { ok: true as const };
    },
  );

  fastify.delete(
    "/api/projects/:id",
    {
      schema: {
        operationId: RouteId.DeleteProject,
        description:
          "Delete a project (owner or a project admin). Its chats survive as " +
          "ordinary conversations; its files and scheduled tasks are deleted " +
          "with it.",
        tags: ["Projects"],
        params: z.object({ id: z.string().uuid() }),
        response: constructResponseSchema(z.object({ ok: z.literal(true) })),
      },
    },
    async ({ params: { id }, organizationId, user }) => {
      await projectService.delete({ id, organizationId, userId: user.id });
      return { ok: true as const };
    },
  );

  fastify.get(
    "/api/projects/:id/files",
    {
      schema: {
        operationId: RouteId.GetProjectFiles,
        description:
          "Files owned by the project, readable by anyone with project access.",
        tags: ["Projects"],
        params: z.object({ id: z.string().uuid() }),
        response: constructResponseSchema(z.array(SandboxFileListItemSchema)),
      },
    },
    async ({ params: { id }, organizationId, user }) =>
      projectService.listFiles({
        id,
        organizationId,
        userId: user.id,
        allowAdminOversight: true,
      }),
  );

  fastify.post(
    "/api/projects/:id/files",
    {
      bodyLimit: PROJECT_UPLOAD_BODY_LIMIT,
      schema: {
        operationId: RouteId.UploadProjectFiles,
        description:
          "Upload one file into the project (drag-and-drop on the Files " +
          "panel). The bytes are base64-encoded in the body; a colliding name " +
          "is auto-renamed.",
        tags: ["Projects"],
        params: z.object({ id: z.string().uuid() }),
        body: z.object({
          name: z.string().min(1),
          /** MIME type from the browser; may be empty for some OS drops. */
          mimeType: z.string(),
          /** Raw base64 (a `data:` URL prefix is tolerated). */
          dataBase64: z.string().min(1),
        }),
        response: constructResponseSchema(
          z.object({
            id: z.string().uuid(),
            filename: z.string(),
            mimeType: z.string(),
          }),
        ),
      },
    },
    async ({ params: { id }, body, organizationId, user }) =>
      projectService.uploadFile({
        id,
        organizationId,
        userId: user.id,
        name: body.name,
        mimeType: body.mimeType,
        dataBase64: body.dataBase64,
      }),
  );

  fastify.get(
    "/api/projects/:id/instructions",
    {
      schema: {
        operationId: RouteId.GetProjectInstructions,
        description:
          "The project's instructions (markdown). Readable by anyone with " +
          "project access; empty until the owner first saves it. The content " +
          "is injected into the system prompt of every chat in the project.",
        tags: ["Projects"],
        params: z.object({ id: z.string().uuid() }),
        response: constructResponseSchema(z.object({ content: z.string() })),
      },
    },
    async ({ params: { id }, organizationId, user }) =>
      projectService.getInstructions({ id, organizationId, userId: user.id }),
  );

  fastify.put(
    "/api/projects/:id/instructions",
    {
      schema: {
        operationId: RouteId.SetProjectInstructions,
        description:
          "Set the project's instructions (owner only). The first save creates " +
          "the instructions file; saving empty content keeps it but injects " +
          "nothing.",
        tags: ["Projects"],
        params: z.object({ id: z.string().uuid() }),
        body: z.object({
          content: z.string().max(PROJECT_INSTRUCTIONS_MAX_LENGTH),
        }),
        response: constructResponseSchema(z.object({ ok: z.literal(true) })),
      },
    },
    async ({ params: { id }, body, organizationId, user }) => {
      await projectService.setInstructions({
        id,
        organizationId,
        userId: user.id,
        content: body.content,
      });
      return { ok: true as const };
    },
  );

  fastify.get(
    "/api/projects/:id/conversations",
    {
      schema: {
        operationId: RouteId.GetProjectConversations,
        description:
          "All chats in a project the caller can read. `readOnly` marks " +
          "chats authored by someone else (viewable, never writable).",
        tags: ["Projects"],
        params: z.object({ id: z.string().uuid() }),
        response: constructResponseSchema(
          z.array(ProjectConversationItemSchema),
        ),
      },
    },
    async ({ params: { id }, organizationId, user }) =>
      projectService.listConversations({
        id,
        organizationId,
        userId: user.id,
      }),
  );

  fastify.put(
    "/api/projects/:id/pin",
    {
      schema: {
        operationId: RouteId.PinProject,
        description:
          "Pin a project to the current user's sidebar. Personal — does not " +
          "affect other members. Any user who can read the project may pin it.",
        tags: ["Projects"],
        params: z.object({ id: z.string().uuid() }),
        response: constructResponseSchema(z.object({ ok: z.literal(true) })),
      },
    },
    async ({ params: { id }, organizationId, user }) => {
      await projectService.pin({ id, organizationId, userId: user.id });
      return { ok: true as const };
    },
  );

  fastify.delete(
    "/api/projects/:id/pin",
    {
      schema: {
        operationId: RouteId.UnpinProject,
        description:
          "Remove the current user's pin on a project. Idempotent; allowed " +
          "even if the project was since unshared from the user.",
        tags: ["Projects"],
        params: z.object({ id: z.string().uuid() }),
        response: constructResponseSchema(z.object({ ok: z.literal(true) })),
      },
    },
    async ({ params: { id }, organizationId, user }) => {
      await projectService.unpin({ id, organizationId, userId: user.id });
      return { ok: true as const };
    },
  );
};

export default projectRoutes;
