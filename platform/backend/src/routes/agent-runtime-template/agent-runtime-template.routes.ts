import {
  agentCatalogIdForImage,
  PopularAgentIdSchema,
  RouteId,
} from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { userHasPermission } from "@/auth/utils";
import config from "@/config";
import AgentRuntimeTemplateModel from "@/models/agent-runtime-template";
import {
  applyLockedRuntimesToAgents,
  assertLockedRuntimesFitAgents,
} from "@/services/agent-runtime/agent-runtime-lock";
import {
  assertRuntimeAccountSettings,
  withRuntimeAccountNames,
} from "@/services/agent-runtime/agent-runtime-access";
import { ApiError, constructResponseSchema } from "@/types";
import {
  AgentRuntimeTemplateSummarySchema,
  AgentRuntimeTemplateViewSchema,
  BuiltInRuntimeSummarySchema,
  RuntimeTemplateEditorSettingsSchema,
  SaveRuntimeTemplateSettingsSchema,
} from "@/types/agent-runtime-template";

const agentRuntimeTemplateRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/agent-runtime-templates",
    {
      schema: {
        operationId: RouteId.ListAgentRuntimeTemplates,
        description:
          "List custom runtime choices without environment values or runtime configuration.",
        tags: ["Agents"],
        response: constructResponseSchema(
          z.array(AgentRuntimeTemplateSummarySchema),
        ),
      },
    },
    async ({ organizationId, user }, reply) => {
      // Anyone may list the runtimes; a runtime's account rule goes only to
      // someone who may use or configure it.
      const settings = await readSettings(organizationId, user.id);
      return reply.send(
        settings.templates.map(({ runtime, ...template }) => ({
          ...template,
          image: runtime.image,
        })),
      );
    },
  );

  fastify.get(
    "/api/agent-runtime-templates/built-ins",
    {
      schema: {
        operationId: RouteId.ListBuiltInAgentRuntimeSettings,
        description:
          "List the settings administrators chose for the maintained runtimes, and which of them are locked.",
        tags: ["Agents"],
        response: constructResponseSchema(z.array(BuiltInRuntimeSummarySchema)),
      },
    },
    async ({ organizationId, user }, reply) => {
      const { builtIns } = await readSettings(organizationId, user.id);
      return reply.send(
        PopularAgentIdSchema.options.flatMap((id) => {
          const builtIn = builtIns[id];
          return builtIn ? [{ id, ...builtIn }] : [];
        }),
      );
    },
  );

  fastify.get(
    "/api/agent-runtime-templates/settings",
    {
      schema: {
        operationId: RouteId.GetRuntimeTemplateSettings,
        description: "Read editable runtime template settings.",
        tags: ["Organization"],
        response: constructResponseSchema(RuntimeTemplateEditorSettingsSchema),
      },
    },
    async ({ organizationId }, reply) =>
      reply.send(await readSettings(organizationId)),
  );

  fastify.put(
    "/api/agent-runtime-templates/settings",
    {
      schema: {
        operationId: RouteId.SaveRuntimeTemplateSettings,
        description:
          "Save custom templates, the maintained templates' settings, and the combined runtime order. Saving a locked runtime applies its settings to every agent of its type; an unlocked runtime's settings only start new agents. A runtime's account rule (accounts) holds for every agent of the runtime from the moment it is saved, and is never written onto them. The revision prevents overwriting concurrent edits.",
        tags: ["Organization"],
        body: SaveRuntimeTemplateSettingsSchema,
        response: constructResponseSchema(RuntimeTemplateEditorSettingsSchema),
      },
    },
    async ({ organizationId, user, body }, reply) => {
      const previous =
        await AgentRuntimeTemplateModel.getSettings(organizationId);
      await assertRuntimeAccountSettings({
        organizationId,
        userId: user.id,
        settings: body,
        previous,
      });
      for (const template of body.templates) {
        if (
          template.locked &&
          agentCatalogIdForImage({
            image: template.runtime.image,
            catalogImages: config.agentRuntime.catalogImages,
          })
        )
          throw new ApiError(
            400,
            `${template.name} uses a maintained image, so it runs as that built-in runtime. Lock the built-in runtime instead.`,
          );
      }
      await assertLockedRuntimesFitAgents({
        organizationId,
        userId: user.id,
        settings: body,
        previous,
      });
      return reply.send(
        await withRuntimeAccountNames({
          organizationId,
          settings: await AgentRuntimeTemplateModel.saveSettings({
            organizationId,
            settings: body,
            popularAgentOverrides: body.popularAgentOverrides,
            afterWrite: ({ tx, settings, previous }) =>
              applyLockedRuntimesToAgents({
                organizationId,
                settings,
                previous,
                tx,
              }),
          }),
        }),
      );
    },
  );

  fastify.get(
    "/api/agent-runtime-templates/:id",
    {
      schema: {
        operationId: RouteId.GetAgentRuntimeTemplate,
        description:
          "Read a template's starting configuration when creating or editing an agent.",
        tags: ["Agents"],
        params: z.object({ id: z.string().uuid() }),
        response: constructResponseSchema(AgentRuntimeTemplateViewSchema),
      },
    },
    async ({ organizationId, user, params }, reply) => {
      const allowed = await Promise.all([
        userHasPermission(user.id, organizationId, "agent", "create"),
        userHasPermission(user.id, organizationId, "agent", "update"),
        userHasPermission(
          user.id,
          organizationId,
          "organizationSettings",
          "update",
        ),
      ]);
      if (
        !allowed.some(Boolean) ||
        !(await userHasPermission(
          user.id,
          organizationId,
          "agent",
          "configure-runtime",
        ))
      )
        throw new ApiError(
          403,
          "Permission to configure runtime and create or update agents is required",
        );
      const settings =
        await AgentRuntimeTemplateModel.getSettings(organizationId);
      const template = settings.templates.find((item) => item.id === params.id);
      if (!template || template.hidden)
        throw new ApiError(404, "Runtime template not found");
      // The names of this runtime's account rule alone, not every runtime's.
      const [named] = (
        await withRuntimeAccountNames({
          organizationId,
          settings: { templates: [template], builtIns: {} },
        })
      ).templates;
      return reply.send(named);
    },
  );
};

export default agentRuntimeTemplateRoutes;

/**
 * The stored settings as a response carries them. With `viewerId`, without
 * the account rule of a runtime that person may neither use nor configure.
 */
async function readSettings(organizationId: string, viewerId?: string) {
  return withRuntimeAccountNames({
    organizationId,
    settings: await AgentRuntimeTemplateModel.getSettings(organizationId),
    ...(viewerId && { viewer: { userId: viewerId } }),
  });
}
