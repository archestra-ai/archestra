import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  createNetworkPolicy,
  deleteNetworkPolicy,
  listNetworkPolicies,
  updateNetworkPolicy,
} from "@/services/environments/network-policy";
import {
  CreateNetworkPolicySchema,
  constructResponseSchema,
  DeleteObjectResponseSchema,
  NetworkPolicyWithReferencesSchema,
  SelectNetworkPolicySchema,
  UpdateNetworkPolicySchema,
  UuidIdSchema,
} from "@/types";

const networkPolicyRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/network-policies",
    {
      schema: {
        operationId: RouteId.ListNetworkPolicies,
        description: "List reusable organization network policies.",
        tags: ["Organization"],
        response: constructResponseSchema(
          z.array(NetworkPolicyWithReferencesSchema),
        ),
      },
    },
    async ({ organizationId }, reply) => {
      return reply.send(await listNetworkPolicies(organizationId));
    },
  );

  fastify.post(
    "/api/network-policies",
    {
      schema: {
        operationId: RouteId.CreateNetworkPolicy,
        description: "Create a reusable organization network policy.",
        tags: ["Organization"],
        body: CreateNetworkPolicySchema,
        response: constructResponseSchema(SelectNetworkPolicySchema),
      },
    },
    async ({ organizationId, body }, reply) => {
      return reply.send(
        await createNetworkPolicy({ organizationId, data: body }),
      );
    },
  );

  fastify.patch(
    "/api/network-policies/:id",
    {
      schema: {
        operationId: RouteId.UpdateNetworkPolicy,
        description: "Update a reusable organization network policy.",
        tags: ["Organization"],
        params: z.object({ id: UuidIdSchema }),
        body: UpdateNetworkPolicySchema,
        response: constructResponseSchema(SelectNetworkPolicySchema),
      },
    },
    async ({ organizationId, params, body }, reply) => {
      return reply.send(
        await updateNetworkPolicy({
          id: params.id,
          organizationId,
          data: body,
        }),
      );
    },
  );

  fastify.delete(
    "/api/network-policies/:id",
    {
      schema: {
        operationId: RouteId.DeleteNetworkPolicy,
        description:
          "Delete a reusable organization network policy. Fails with 409 while it is still assigned.",
        tags: ["Organization"],
        params: z.object({ id: UuidIdSchema }),
        response: constructResponseSchema(DeleteObjectResponseSchema),
      },
    },
    async ({ organizationId, params }, reply) => {
      await deleteNetworkPolicy({ id: params.id, organizationId });
      return reply.send({ success: true });
    },
  );
};

export default networkPolicyRoutes;
