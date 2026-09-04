import { RouteId } from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { isAnyAgentRuntimeBackendDriverEnabled } from "@/services/agent-runtime/backends";
import {
  createRuntimeCredentialDefinition,
  deleteRuntimeCredentialConnection,
  deleteRuntimeCredentialDefinition,
  getRuntimeCredentialConnectionAuditSnapshot,
  getRuntimeCredentialUsage,
  listRuntimeCredentialDefinitions,
  setRuntimeCredentialConnection,
  updateRuntimeCredentialDefinition,
} from "@/services/agent-runtime/runtime-credentials";
import {
  ApiError,
  constructResponseSchema,
  InsertRuntimeCredentialDefinitionSchema,
  RuntimeCredentialDefinitionViewSchema,
  RuntimeCredentialUsageSchema,
  SelectRuntimeCredentialDefinitionSchema,
  UpdateRuntimeCredentialDefinitionSchema,
} from "@/types";

const runtimeCredentialRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.addHook("preHandler", async () => {
    if (!isAnyAgentRuntimeBackendDriverEnabled())
      throw new ApiError(404, "Not found");
  });

  fastify.get(
    "/api/runtime-credentials",
    {
      schema: {
        operationId: RouteId.ListRuntimeCredentials,
        description: "List runtime credentials available to Agents",
        tags: ["Agents"],
        response: constructResponseSchema(
          z.array(RuntimeCredentialDefinitionViewSchema),
        ),
      },
    },
    async (request, reply) =>
      reply.send(
        await listRuntimeCredentialDefinitions({
          organizationId: request.organizationId,
          userId: request.user.id,
        }),
      ),
  );

  fastify.post(
    "/api/runtime-credentials",
    {
      schema: {
        operationId: RouteId.CreateRuntimeCredential,
        description: "Create an runtime credential definition",
        tags: ["Agents"],
        body: InsertRuntimeCredentialDefinitionSchema,
        response: constructResponseSchema(
          SelectRuntimeCredentialDefinitionSchema,
        ),
      },
    },
    async (request, reply) => {
      const definition = await createRuntimeCredentialDefinition({
        organizationId: request.organizationId,
        userId: request.user.id,
        definition: request.body,
      });
      return reply.send(definition);
    },
  );

  fastify.get(
    "/api/runtime-credentials/:key/usage",
    {
      schema: {
        operationId: RouteId.GetRuntimeCredentialUsage,
        description: "List Agents using an runtime credential",
        tags: ["Agents"],
        params: CredentialKeyParamsSchema,
        response: constructResponseSchema(RuntimeCredentialUsageSchema),
      },
    },
    async (request, reply) =>
      reply.send(
        await getRuntimeCredentialUsage({
          organizationId: request.organizationId,
          key: request.params.key,
        }),
      ),
  );

  fastify.patch(
    "/api/runtime-credentials/:key",
    {
      schema: {
        operationId: RouteId.UpdateRuntimeCredential,
        description: "Update an runtime credential definition",
        tags: ["Agents"],
        params: CredentialKeyParamsSchema,
        body: UpdateRuntimeCredentialDefinitionSchema,
        response: constructResponseSchema(
          SelectRuntimeCredentialDefinitionSchema,
        ),
      },
    },
    async (request, reply) =>
      reply.send(
        await updateRuntimeCredentialDefinition({
          organizationId: request.organizationId,
          key: request.params.key,
          definition: request.body,
        }),
      ),
  );

  fastify.delete(
    "/api/runtime-credentials/:key",
    {
      schema: {
        operationId: RouteId.DeleteRuntimeCredential,
        description: "Delete an runtime credential definition",
        tags: ["Agents"],
        params: CredentialKeyParamsSchema,
        response: constructResponseSchema(
          z.object({ deleted: z.literal(true) }),
        ),
      },
    },
    async (request, reply) => {
      await deleteRuntimeCredentialDefinition({
        organizationId: request.organizationId,
        key: request.params.key,
      });
      return reply.send({ deleted: true as const });
    },
  );

  fastify.put(
    "/api/runtime-credentials/:key/personal",
    {
      schema: {
        operationId: RouteId.SetPersonalRuntimeCredentialConnection,
        description: "Connect a personal runtime credential",
        tags: ["Agents"],
        params: CredentialKeyParamsSchema,
        body: ConnectionValueSchema,
        response: constructResponseSchema(
          z.object({ configured: z.literal(true) }),
        ),
      },
    },
    async (request, reply) => {
      request.auditSkip = true;
      await setRuntimeCredentialConnection({
        organizationId: request.organizationId,
        userId: request.user.id,
        credentialId: request.params.key,
        scope: "personal",
        value: request.body.value,
      });
      return reply.send({ configured: true as const });
    },
  );

  fastify.delete(
    "/api/runtime-credentials/:key/personal",
    {
      schema: {
        operationId: RouteId.DeletePersonalRuntimeCredentialConnection,
        description: "Disconnect a personal runtime credential",
        tags: ["Agents"],
        params: CredentialKeyParamsSchema,
        response: constructResponseSchema(z.object({ deleted: z.boolean() })),
      },
    },
    async (request, reply) => {
      request.auditSkip = true;
      const deleted = await deleteRuntimeCredentialConnection({
        organizationId: request.organizationId,
        userId: request.user.id,
        credentialId: request.params.key,
        scope: "personal",
      });
      return reply.send({ deleted });
    },
  );

  fastify.put(
    "/api/runtime-credentials/:key/organization",
    {
      schema: {
        operationId: RouteId.SetOrganizationRuntimeCredentialConnection,
        description: "Connect an organization runtime credential",
        tags: ["Agents"],
        params: CredentialKeyParamsSchema,
        body: ConnectionValueSchema,
        response: constructResponseSchema(
          z.object({ configured: z.literal(true) }),
        ),
      },
    },
    async (request, reply) => {
      const before = await getRuntimeCredentialConnectionAuditSnapshot({
        organizationId: request.organizationId,
        credentialId: request.params.key,
        scope: "organization",
      });
      await setRuntimeCredentialConnection({
        organizationId: request.organizationId,
        userId: request.user.id,
        credentialId: request.params.key,
        scope: "organization",
        value: request.body.value,
      });
      request.auditBefore = before;
      request.auditAfter = await getRuntimeCredentialConnectionAuditSnapshot({
        organizationId: request.organizationId,
        credentialId: request.params.key,
        scope: "organization",
      });
      return reply.send({ configured: true as const });
    },
  );

  fastify.delete(
    "/api/runtime-credentials/:key/organization",
    {
      schema: {
        operationId: RouteId.DeleteOrganizationRuntimeCredentialConnection,
        description: "Disconnect an organization runtime credential",
        tags: ["Agents"],
        params: CredentialKeyParamsSchema,
        response: constructResponseSchema(z.object({ deleted: z.boolean() })),
      },
    },
    async (request, reply) => {
      request.auditBefore = await getRuntimeCredentialConnectionAuditSnapshot({
        organizationId: request.organizationId,
        credentialId: request.params.key,
        scope: "organization",
      });
      const deleted = await deleteRuntimeCredentialConnection({
        organizationId: request.organizationId,
        userId: request.user.id,
        credentialId: request.params.key,
        scope: "organization",
      });
      if (!deleted) request.auditSkip = true;
      request.auditAfter = null;
      return reply.send({ deleted });
    },
  );
};

export default runtimeCredentialRoutes;

// ===================== Internals =====================

const CredentialKeyParamsSchema = z.object({
  key: z.string().min(1).max(128),
});

const ConnectionValueSchema = z.object({
  value: z.string().min(1).max(20_000),
});
