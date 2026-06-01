import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  createEnvironment,
  deleteEnvironment,
  listEnvironments,
  updateEnvironment,
} from "@/services/environments/environment";
import {
  CreateEnvironmentSchema,
  constructResponseSchema,
  DeleteObjectResponseSchema,
  EnvironmentWithAssignedCountSchema,
  SelectEnvironmentSchema,
  UpdateEnvironmentSchema,
  UuidIdSchema,
} from "@/types";

// Routes are thin: parse/validate (Zod), delegate to the service, serialize.
// All business logic (dup-name 409, not-found 404) lives in the service.
const environmentRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/organization/environments",
    {
      schema: {
        operationId: RouteId.ListEnvironments,
        description:
          "List org-level deployment environments. Includes assignedCatalogCount for delete-confirmation UI.",
        tags: ["Organization"],
        response: constructResponseSchema(
          z.array(EnvironmentWithAssignedCountSchema),
        ),
      },
    },
    async ({ organizationId }, reply) => {
      return reply.send(await listEnvironments(organizationId));
    },
  );

  fastify.post(
    "/api/organization/environments",
    {
      schema: {
        operationId: RouteId.CreateEnvironment,
        description: "Create an org-level deployment environment.",
        tags: ["Organization"],
        body: CreateEnvironmentSchema,
        response: constructResponseSchema(SelectEnvironmentSchema),
      },
    },
    async ({ organizationId, body }, reply) => {
      return reply.send(
        await createEnvironment({ organizationId, data: body }),
      );
    },
  );

  fastify.patch(
    "/api/organization/environments/:id",
    {
      schema: {
        operationId: RouteId.UpdateEnvironment,
        description:
          "Update an environment's name, description, namespace, and restricted flag.",
        tags: ["Organization"],
        params: z.object({ id: UuidIdSchema }),
        body: UpdateEnvironmentSchema,
        response: constructResponseSchema(SelectEnvironmentSchema),
      },
    },
    async ({ organizationId, params, body }, reply) => {
      return reply.send(
        await updateEnvironment({ id: params.id, organizationId, data: body }),
      );
    },
  );

  fastify.delete(
    "/api/organization/environments/:id",
    {
      schema: {
        operationId: RouteId.DeleteEnvironment,
        description:
          "Delete an org-level environment. Fails with 409 if any catalog items are still assigned to it.",
        tags: ["Organization"],
        params: z.object({ id: UuidIdSchema }),
        response: constructResponseSchema(DeleteObjectResponseSchema),
      },
    },
    async ({ organizationId, params }, reply) => {
      await deleteEnvironment({ id: params.id, organizationId });
      return reply.send({ success: true });
    },
  );
};

export default environmentRoutes;
