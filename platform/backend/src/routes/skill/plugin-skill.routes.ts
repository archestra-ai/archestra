import { RouteId } from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import config from "@/config";
import { getPluginSkill, listPluginSkills } from "@/plugins/plugin-skills";
import {
  ApiError,
  constructResponseSchema,
  PluginSkillDetailSchema,
  PluginSkillListItemSchema,
  UuidIdSchema,
} from "@/types";

const pluginSkillRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/skills/plugins",
    {
      schema: {
        operationId: RouteId.GetPluginSkills,
        description:
          "List the portable Skills embedded in the plugins visible to the caller.",
        tags: ["Skills"],
        response: constructResponseSchema(z.array(PluginSkillListItemSchema)),
      },
    },
    async ({ user, organizationId }, reply) => {
      assertPluginsEnabled();
      return reply.send(
        await listPluginSkills({
          organizationId,
          userId: user.id,
        }),
      );
    },
  );

  fastify.get(
    "/api/skills/plugins/:pluginId",
    {
      schema: {
        operationId: RouteId.GetPluginSkill,
        description:
          "Read one Skill embedded in a plugin, with its bundled resource files.",
        tags: ["Skills"],
        params: z.object({ pluginId: UuidIdSchema }),
        querystring: z.object({
          skillPath: z
            .string()
            .max(500)
            .optional()
            .describe(
              "Parent directory of the SKILL.md inside the plugin; omit for a root-level skill.",
            ),
        }),
        response: constructResponseSchema(PluginSkillDetailSchema),
      },
    },
    async ({ params, query, user, organizationId }, reply) => {
      assertPluginsEnabled();
      const skill = await getPluginSkill({
        pluginId: params.pluginId,
        skillPath: query.skillPath ?? "",
        organizationId,
        userId: user.id,
      });
      if (!skill) throw new ApiError(404, "Plugin skill not found");
      return reply.send(skill);
    },
  );
};

export default pluginSkillRoutes;

// === Internal helpers ===

function assertPluginsEnabled(): void {
  if (!config.plugins.enabled) {
    throw new ApiError(404, "Plugins are not enabled");
  }
}
