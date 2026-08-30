import { RouteId } from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { userHasPermission } from "@/auth";
import config from "@/config";
import { AgentModel, BundleModel, PluginModel, SkillModel } from "@/models";
import {
  ApiError,
  BundleSchema,
  CreateBundleSchema,
  constructResponseSchema,
  UpdateBundleSchema,
  type User,
} from "@/types";

const BundleParamsSchema = z.object({ id: z.string().uuid() });

const bundleRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.addHook("onRequest", async () => {
    if (!config.bundles.enabled) {
      throw new ApiError(404, "Bundles are not enabled");
    }
  });

  fastify.get(
    "/api/bundles",
    {
      schema: {
        operationId: RouteId.GetBundles,
        description: "List bundles in the active organization",
        tags: ["Bundles"],
        response: constructResponseSchema(z.array(BundleSchema)),
      },
    },
    async ({ organizationId }, reply) => {
      return reply.send(
        await BundleModel.findAllByOrganization(organizationId),
      );
    },
  );

  fastify.get(
    "/api/bundles/:id",
    {
      schema: {
        operationId: RouteId.GetBundle,
        description: "Get one bundle",
        tags: ["Bundles"],
        params: BundleParamsSchema,
        response: constructResponseSchema(BundleSchema),
      },
    },
    async ({ params, organizationId }, reply) => {
      const bundle = await BundleModel.findById({
        id: params.id,
        organizationId,
      });
      if (!bundle) throw new ApiError(404, "Bundle not found");
      return reply.send(bundle);
    },
  );

  fastify.post(
    "/api/bundles",
    {
      schema: {
        operationId: RouteId.CreateBundle,
        description: "Create a bundle",
        tags: ["Bundles"],
        body: CreateBundleSchema,
        response: constructResponseSchema(BundleSchema),
      },
    },
    async ({ body, organizationId, user }, reply) => {
      await validateBundleResources({ body, organizationId, user });
      const bundle = await BundleModel.create({
        ...body,
        organizationId,
      });
      return reply.send(bundle);
    },
  );

  fastify.patch(
    "/api/bundles/:id",
    {
      schema: {
        operationId: RouteId.UpdateBundle,
        description: "Update a bundle",
        tags: ["Bundles"],
        params: BundleParamsSchema,
        body: UpdateBundleSchema,
        response: constructResponseSchema(BundleSchema),
      },
    },
    async ({ params, body, organizationId, user }, reply) => {
      await validateBundleResources({ body, organizationId, user });
      const bundle = await BundleModel.update({
        id: params.id,
        organizationId,
        ...body,
      });
      if (!bundle) throw new ApiError(404, "Bundle not found");
      return reply.send(bundle);
    },
  );

  fastify.delete(
    "/api/bundles/:id",
    {
      schema: {
        operationId: RouteId.DeleteBundle,
        description: "Delete a bundle",
        tags: ["Bundles"],
        params: BundleParamsSchema,
        response: constructResponseSchema(z.object({ success: z.boolean() })),
      },
    },
    async ({ params, organizationId }, reply) => {
      const deleted = await BundleModel.delete({
        id: params.id,
        organizationId,
      });
      if (!deleted) throw new ApiError(404, "Bundle not found");
      return reply.send({ success: true });
    },
  );
};

export default bundleRoutes;

async function validateBundleResources(params: {
  body: {
    skillIds?: string[];
    pluginIds?: string[];
    mcpGatewayId?: string | null;
  };
  organizationId: string;
  user: User;
}): Promise<void> {
  const { body, organizationId, user } = params;
  if (body.skillIds !== undefined) {
    await requirePermission({
      userId: user.id,
      organizationId,
      resource: "skill",
      message: "Skill read permission required to add skills to a bundle",
    });
    const skillIds = [...new Set(body.skillIds)];
    const skills = await SkillModel.findByIds(skillIds);
    if (
      skills.length !== skillIds.length ||
      skills.some((skill) => skill.organizationId !== organizationId)
    ) {
      throw new ApiError(404, "Skill not found");
    }
  }

  if (body.pluginIds !== undefined) {
    const pluginIds = [...new Set(body.pluginIds)];
    if (pluginIds.length > 0) {
      const [canRead, canAdmin] = await Promise.all([
        userHasPermission(user.id, organizationId, "plugin", "read"),
        userHasPermission(user.id, organizationId, "plugin", "admin"),
      ]);
      // Treat an inaccessible executable payload as absent, matching the
      // lookup below and avoiding a membership-discovery oracle.
      if (!canRead || !canAdmin) throw new ApiError(404, "Plugin not found");
      const plugins = await PluginModel.findApprovedByIds({
        ids: pluginIds,
        organizationId,
      });
      if (plugins.length !== pluginIds.length) {
        throw new ApiError(404, "Plugin not found");
      }
    }
  }

  if (body.mcpGatewayId) {
    const [canRead, isAdmin] = await Promise.all([
      userHasPermission(user.id, organizationId, "mcpGateway", "read"),
      userHasPermission(user.id, organizationId, "mcpGateway", "admin"),
    ]);
    if (!canRead && !isAdmin) {
      throw new ApiError(404, "MCP gateway not found");
    }
    const gateway = await AgentModel.findById(
      body.mcpGatewayId,
      user.id,
      isAdmin,
    );
    if (
      !gateway ||
      gateway.organizationId !== organizationId ||
      !["mcp_gateway", "profile"].includes(gateway.agentType)
    ) {
      throw new ApiError(404, "MCP gateway not found");
    }
  }
}

async function requirePermission(params: {
  userId: string;
  organizationId: string;
  resource: "skill" | "plugin";
  message: string;
}): Promise<void> {
  const allowed = await userHasPermission(
    params.userId,
    params.organizationId,
    params.resource,
    "read",
  );
  if (!allowed) throw new ApiError(403, params.message);
}
