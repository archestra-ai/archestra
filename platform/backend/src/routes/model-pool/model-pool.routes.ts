import { RouteId } from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { LlmProviderApiKeyModel, ModelPoolModel } from "@/models";
import {
  ApiError,
  constructResponseSchema,
  type ModelPoolInput,
  ModelPoolInputSchema,
  ModelPoolWithHealthSchema,
  SelectModelPoolSchema,
} from "@/types";
import { withMemberHealth } from "../proxy/model-pool-failover";

const ModelPoolParamsSchema = z.object({ id: z.string().uuid() });

const modelPoolRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/model-pools",
    {
      schema: {
        operationId: RouteId.GetModelPools,
        description:
          "List the organization's model pools with their members, and which members are benched after a failure",
        tags: ["Model Pools"],
        response: constructResponseSchema(z.array(ModelPoolWithHealthSchema)),
      },
    },
    async ({ organizationId }, reply) =>
      reply.send(
        await withMemberHealth(await ModelPoolModel.list(organizationId)),
      ),
  );

  fastify.post(
    "/api/model-pools",
    {
      schema: {
        operationId: RouteId.CreateModelPool,
        description:
          "Create a model pool: provider keys that serve one model, tried by priority and split by weight",
        tags: ["Model Pools"],
        body: ModelPoolInputSchema,
        response: constructResponseSchema(SelectModelPoolSchema),
      },
    },
    async ({ organizationId, body }, reply) => {
      await assertValidMembers({ organizationId, input: body });
      await assertModelHasNoOtherPool({ organizationId, input: body });
      return reply.send(
        await ModelPoolModel.create({ organizationId, input: body }),
      );
    },
  );

  fastify.put(
    "/api/model-pools/:id",
    {
      schema: {
        operationId: RouteId.UpdateModelPool,
        description: "Replace a model pool's settings and members",
        tags: ["Model Pools"],
        params: ModelPoolParamsSchema,
        body: ModelPoolInputSchema,
        response: constructResponseSchema(SelectModelPoolSchema),
      },
    },
    async ({ organizationId, params, body }, reply) => {
      await assertValidMembers({ organizationId, input: body });
      await assertModelHasNoOtherPool({
        organizationId,
        input: body,
        poolId: params.id,
      });
      const pool = await ModelPoolModel.update({
        organizationId,
        id: params.id,
        input: body,
      });
      if (!pool) throw new ApiError(404, "Model pool not found");
      return reply.send(pool);
    },
  );

  fastify.delete(
    "/api/model-pools/:id",
    {
      schema: {
        operationId: RouteId.DeleteModelPool,
        description: "Delete a model pool",
        tags: ["Model Pools"],
        params: ModelPoolParamsSchema,
        response: constructResponseSchema(z.object({ success: z.boolean() })),
      },
    },
    async ({ organizationId, params }, reply) => {
      const deleted = await ModelPoolModel.delete({
        organizationId,
        id: params.id,
      });
      if (!deleted) throw new ApiError(404, "Model pool not found");
      return reply.send({ success: true });
    },
  );
};

/** One pool per model: a request has to know which pool it belongs to. */
async function assertModelHasNoOtherPool(params: {
  organizationId: string;
  input: ModelPoolInput;
  poolId?: string;
}): Promise<void> {
  const existing = await ModelPoolModel.findIdByModel({
    organizationId: params.organizationId,
    provider: params.input.provider,
    modelId: params.input.modelId,
  });
  if (existing && existing !== params.poolId) {
    throw new ApiError(
      409,
      `A pool for ${params.input.modelId} on ${params.input.provider} already exists.`,
    );
  }
}

/**
 * Members must be distinct shared keys of this organization for the pool's
 * provider. A personal key belongs to one user (and subscription credentials
 * are personal), so pooling it would let other callers spend it.
 */
async function assertValidMembers(params: {
  organizationId: string;
  input: ModelPoolInput;
}): Promise<void> {
  const ids = params.input.members.map((member) => member.providerApiKeyId);
  if (new Set(ids).size !== ids.length) {
    throw new ApiError(400, "A provider key can be a pool member only once.");
  }
  const keys = await LlmProviderApiKeyModel.findByIds(ids);
  const byId = new Map(keys.map((key) => [key.id, key]));
  for (const id of ids) {
    const key = byId.get(id);
    if (!key || key.organizationId !== params.organizationId) {
      throw new ApiError(400, `Provider key ${id} not found.`);
    }
    if (key.provider !== params.input.provider) {
      throw new ApiError(
        400,
        `Provider key "${key.name}" is for ${key.provider}, not ${params.input.provider}.`,
      );
    }
    if (key.userId !== null) {
      throw new ApiError(
        400,
        `Provider key "${key.name}" is a personal key; only shared keys can be pool members.`,
      );
    }
  }
}

export default modelPoolRoutes;
