import {
  createPaginatedResponseSchema,
  PaginationQuerySchema,
  RouteId,
} from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  createProject,
  deleteProject,
  getProject,
  listProjects,
  updateProject,
} from "@/services/project";
import {
  constructResponseSchema,
  DeleteObjectResponseSchema,
  UuidIdSchema,
} from "@/types";
import {
  InsertProjectSchema,
  ProjectScopeSchema,
  SelectProjectSchema,
  UpdateProjectSchema,
} from "@/types/project";

const routes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/projects",
    {
      schema: {
        operationId: RouteId.GetProjects,
        description:
          "List projects visible to the current user, with optional search and scope filters.",
        tags: ["Projects"],
        querystring: PaginationQuerySchema.extend({
          search: z.string().optional(),
          scope: ProjectScopeSchema.optional(),
        }),
        response: constructResponseSchema(
          createPaginatedResponseSchema(SelectProjectSchema),
        ),
      },
    },
    async ({ query, user, organizationId }, reply) => {
      return reply.send(
        await listProjects({
          organizationId,
          userId: user.id,
          limit: query.limit,
          offset: query.offset,
          search: query.search,
          scope: query.scope,
        }),
      );
    },
  );

  fastify.post(
    "/api/projects",
    {
      schema: {
        operationId: RouteId.CreateProject,
        description: "Create a project.",
        tags: ["Projects"],
        body: InsertProjectSchema,
        response: constructResponseSchema(SelectProjectSchema),
      },
    },
    async ({ body, user, organizationId }, reply) => {
      return reply.send(
        await createProject({
          organizationId,
          userId: user.id,
          data: body,
        }),
      );
    },
  );

  fastify.get(
    "/api/projects/:id",
    {
      schema: {
        operationId: RouteId.GetProject,
        description:
          "Get a project with recent conversations, scheduled triggers, and context.",
        tags: ["Projects"],
        params: z.object({ id: UuidIdSchema }),
        response: constructResponseSchema(SelectProjectSchema),
      },
    },
    async ({ params: { id }, user, organizationId }, reply) => {
      return reply.send(
        await getProject({
          id,
          organizationId,
          userId: user.id,
        }),
      );
    },
  );

  fastify.patch(
    "/api/projects/:id",
    {
      schema: {
        operationId: RouteId.UpdateProject,
        description: "Update a project.",
        tags: ["Projects"],
        params: z.object({ id: UuidIdSchema }),
        body: UpdateProjectSchema,
        response: constructResponseSchema(SelectProjectSchema),
      },
    },
    async ({ params: { id }, body, user, organizationId }, reply) => {
      return reply.send(
        await updateProject({
          id,
          organizationId,
          userId: user.id,
          data: body,
        }),
      );
    },
  );

  fastify.delete(
    "/api/projects/:id",
    {
      schema: {
        operationId: RouteId.DeleteProject,
        description: "Delete a project.",
        tags: ["Projects"],
        params: z.object({ id: UuidIdSchema }),
        response: constructResponseSchema(DeleteObjectResponseSchema),
      },
    },
    async ({ params: { id }, user, organizationId }, reply) => {
      await deleteProject({
        id,
        organizationId,
        userId: user.id,
      });
      return reply.send({ success: true });
    },
  );
};

export default routes;
