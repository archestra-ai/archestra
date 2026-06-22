import { RouteId } from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import config from "@/config";
import { projectService } from "@/services/project";
import {
  constructResponseSchema,
  ProjectConversationItemSchema,
  ProjectDetailSchema,
  ProjectListItemSchema,
  ProjectShareVisibilitySchema,
  SandboxFileListItemSchema,
} from "@/types";

/**
 * Projects: named collections of chats that own a set of files. Read access
 * follows the project share (org / teams / owner-only); mutations are
 * owner-only and "not yours" is indistinguishable from 404.
 */
const projectRoutes: FastifyPluginAsyncZod = async (fastify) => {
  if (!config.projects.enabled) return;

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
          name: z.string().min(1).max(256),
          description: z.string().max(4096).nullable().optional(),
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
        isOwner: true,
        conversationCount: 0,
        visibility: null,
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
          "List projects the caller can see: their own plus ones shared " +
          "with their teams or the whole organization.",
        tags: ["Projects"],
        response: constructResponseSchema(z.array(ProjectListItemSchema)),
      },
    },
    async ({ organizationId, user }) =>
      projectService.list({ organizationId, userId: user.id }),
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
      projectService.get({ id, organizationId, userId: user.id }),
  );

  fastify.patch(
    "/api/projects/:id",
    {
      schema: {
        operationId: RouteId.UpdateProject,
        description:
          "Update a project's name, description, and/or icon (owner only). " +
          "Only the provided fields change.",
        tags: ["Projects"],
        params: z.object({ id: z.string().uuid() }),
        body: z.object({
          name: z.string().min(1).max(256).optional(),
          description: z.string().max(4096).nullable().optional(),
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
          "Set who can see the project (owner only): the whole organization, " +
          'specific teams, or nobody (visibility "none" unshares).',
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
          "Delete a project (owner only). Its chats survive as ordinary " +
          "conversations; its files are deleted with it.",
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
      projectService.listFiles({ id, organizationId, userId: user.id }),
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
};

export default projectRoutes;
