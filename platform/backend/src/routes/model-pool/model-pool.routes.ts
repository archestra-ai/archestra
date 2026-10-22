import { RouteId } from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import config from "@/config";
import {
  LlmProviderApiKeyModel,
  ModelPoolModel,
  VirtualApiKeyModel,
} from "@/models";
import {
  ApiError,
  constructResponseSchema,
  type ModelPoolInput,
  ModelPoolInputSchema,
  ModelPoolWithHealthSchema,
  SelectModelPoolSchema,
} from "@/types";
import { withMemberHealth } from "../proxy/model-pool-failover";
import { isPoolableProvider } from "../proxy/model-pool-transport";

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
    async ({ organizationId }, reply) => {
      assertModelPoolsEnabled();
      return reply.send(
        await withMemberHealth(await ModelPoolModel.list(organizationId)),
      );
    },
  );

  fastify.post(
    "/api/model-pools",
    {
      schema: {
        operationId: RouteId.CreateModelPool,
        description:
          "Create a model pool: a model name served by provider keys on any provider, each with its own model id, tried by priority and split by weight",
        tags: ["Model Pools"],
        body: ModelPoolInputSchema,
        response: constructResponseSchema(SelectModelPoolSchema),
      },
    },
    async ({ organizationId, body }, reply) => {
      assertModelPoolsEnabled();
      await assertValidMembers({ organizationId, input: body });
      await assertValidVirtualApiKeys({ organizationId, input: body });
      await assertNameHasNoOtherPool({ organizationId, input: body });
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
      assertModelPoolsEnabled();
      await assertValidMembers({ organizationId, input: body });
      await assertValidVirtualApiKeys({ organizationId, input: body });
      await assertNameHasNoOtherPool({
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
      assertModelPoolsEnabled();
      const deleted = await ModelPoolModel.delete({
        organizationId,
        id: params.id,
      });
      if (!deleted) throw new ApiError(404, "Model pool not found");
      return reply.send({ success: true });
    },
  );
};

/** Model pools are a beta feature: while off, their API is not there. */
function assertModelPoolsEnabled(): void {
  if (!config.llmProxy.modelPoolsEnabled) {
    throw new ApiError(404, "Not found");
  }
}

/** One pool per name: a request has to know which pool it belongs to. */
async function assertNameHasNoOtherPool(params: {
  organizationId: string;
  input: ModelPoolInput;
  poolId?: string;
}): Promise<void> {
  const existing = await ModelPoolModel.findIdByName({
    organizationId: params.organizationId,
    name: params.input.name,
  });
  if (existing && existing !== params.poolId) {
    throw new ApiError(
      409,
      `A pool named ${params.input.name} already exists.`,
    );
  }
}

/**
 * Members must be distinct shared keys of this organization on a provider a
 * pool can reach. A personal key belongs to one user (and subscription
 * credentials are personal), so pooling it would let other callers spend it.
 */
async function assertValidMembers(params: {
  organizationId: string;
  input: ModelPoolInput;
}): Promise<void> {
  const seen = new Set<string>();
  for (const member of params.input.members) {
    const id = `${member.providerApiKeyId}:${member.modelId}`;
    if (seen.has(id)) {
      throw new ApiError(
        400,
        "A provider key can serve a model in a pool only once.",
      );
    }
    seen.add(id);
  }
  const ids = [...new Set(params.input.members.map((m) => m.providerApiKeyId))];
  const keys = await LlmProviderApiKeyModel.findByIds(ids);
  const byId = new Map(keys.map((key) => [key.id, key]));
  for (const id of ids) {
    const key = byId.get(id);
    if (!key || key.organizationId !== params.organizationId) {
      throw new ApiError(400, `Provider key ${id} not found.`);
    }
    if (key.userId !== null) {
      throw new ApiError(
        400,
        `Provider key "${key.name}" is a personal key; only shared keys can be pool members.`,
      );
    }
    if (!isPoolableProvider(key.provider)) {
      throw new ApiError(
        400,
        `Provider key "${key.name}" is on ${key.provider}, which a pool can't send requests to yet.`,
      );
    }
  }
}

/** Every virtual key is a standard key of the organization. */
async function assertValidVirtualApiKeys(params: {
  organizationId: string;
  input: ModelPoolInput;
}): Promise<void> {
  const keys = await VirtualApiKeyModel.findSummariesByIds({
    ids: params.input.virtualApiKeyIds,
    organizationId: params.organizationId,
  });
  for (const id of params.input.virtualApiKeyIds) {
    const key = keys.get(id);
    if (!key) throw new ApiError(400, `Virtual key ${id} not found.`);
    if (key.keyType !== "standard") {
      throw new ApiError(
        400,
        `Virtual key "${key.name}" passes the caller's own provider key through, so it can't use a pool.`,
      );
    }
  }
}

export default modelPoolRoutes;
