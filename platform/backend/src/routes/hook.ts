import { RouteId } from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { AgentModel, HookFileModel } from "@/models";
import {
  ApiError,
  constructResponseSchema,
  DeleteObjectResponseSchema,
  InsertHookFileSchema,
  SelectHookFileSchema,
  UpdateHookFileSchema,
  UuidIdSchema,
} from "@/types";
import { isUniqueConstraintError } from "@/utils/db";

// ===  Public Plugin ===

const hookRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/hooks",
    {
      schema: {
        operationId: RouteId.GetHooks,
        description: "List hook files for an agent",
        tags: ["Hooks"],
        querystring: z.object({
          agentId: UuidIdSchema,
        }),
        response: constructResponseSchema(z.array(SelectHookFileSchema)),
      },
    },
    async ({ query: { agentId }, organizationId }, reply) => {
      await requireAgentInOrg(agentId, organizationId);

      const hooks = await HookFileModel.listByAgent(agentId, organizationId);
      return reply.status(200).send(hooks);
    },
  );

  fastify.post(
    "/api/hooks",
    {
      schema: {
        operationId: RouteId.CreateHook,
        description: "Create a new hook file for an agent",
        tags: ["Hooks"],
        body: InsertHookFileSchema.omit({ organizationId: true }),
        response: constructResponseSchema(SelectHookFileSchema),
      },
    },
    async ({ body, organizationId }, reply) => {
      await requireAgentInOrg(body.agentId, organizationId);

      const hook = await withUniqueHookConflict(() =>
        HookFileModel.create({ ...body, organizationId }),
      );
      return reply.send(hook);
    },
  );

  fastify.put(
    "/api/hooks/:id",
    {
      schema: {
        operationId: RouteId.UpdateHook,
        description: "Update an existing hook file",
        tags: ["Hooks"],
        params: z.object({
          id: UuidIdSchema,
        }),
        body: UpdateHookFileSchema.superRefine((data, ctx) => {
          if (Object.keys(data).length === 0) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: "At least one field must be provided",
            });
          }
        }),
        response: constructResponseSchema(SelectHookFileSchema),
      },
    },
    async ({ params: { id }, body, organizationId }, reply) => {
      const hook = await withUniqueHookConflict(() =>
        HookFileModel.update({ id, organizationId, data: body }),
      );

      if (!hook) {
        throw new ApiError(404, "Hook not found");
      }

      return reply.send(hook);
    },
  );

  fastify.delete(
    "/api/hooks/:id",
    {
      schema: {
        operationId: RouteId.DeleteHook,
        description: "Delete a hook file",
        tags: ["Hooks"],
        params: z.object({
          id: UuidIdSchema,
        }),
        response: constructResponseSchema(DeleteObjectResponseSchema),
      },
    },
    async ({ params: { id }, organizationId }, reply) => {
      const deleted = await HookFileModel.delete(id, organizationId);

      if (!deleted) {
        throw new ApiError(404, "Hook not found");
      }

      return reply.send({ success: true });
    },
  );
};

export default hookRoutes;

// === Internal Helpers ===

/**
 * Translate the `(agent_id, event, file_name)` unique-constraint violation into
 * a 409 for create/update; rethrow anything else.
 */
async function withUniqueHookConflict<T>(op: () => Promise<T>): Promise<T> {
  try {
    return await op();
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      throw new ApiError(
        409,
        "A hook for this agent, event, and file name already exists",
      );
    }
    throw err;
  }
}

async function requireAgentInOrg(
  agentId: string,
  organizationId: string,
): Promise<void> {
  const agentOrgId = await AgentModel.findOrganizationId(agentId);
  if (agentOrgId !== organizationId) {
    throw new ApiError(404, "Agent not found");
  }
}
