import { PopularAgentIdSchema, RouteId } from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { userHasPermission } from "@/auth/utils";
import AgentRuntimeTemplateModel from "@/models/agent-runtime-template";
import { assertAgentRuntimeTiersExist } from "@/services/agent-runtime/agent-config-validation";
import {
  applyLockedRuntimesToAgents,
  assertLockedRuntimesFitAgents,
} from "@/services/agent-runtime/agent-runtime-lock";
import { ApiError, constructResponseSchema } from "@/types";
import {
  AgentRuntimeTemplateSchema,
  AgentRuntimeTemplateSummarySchema,
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
    async ({ organizationId }, reply) => {
      const settings =
        await AgentRuntimeTemplateModel.getSettings(organizationId);
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
    async ({ organizationId }, reply) => {
      const { builtIns } =
        await AgentRuntimeTemplateModel.getSettings(organizationId);
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
      reply.send(await AgentRuntimeTemplateModel.getSettings(organizationId)),
  );

  fastify.put(
    "/api/agent-runtime-templates/settings",
    {
      schema: {
        operationId: RouteId.SaveRuntimeTemplateSettings,
        description:
          "Save custom templates, the maintained templates' settings, and the combined runtime order. Saving a locked runtime applies its settings to every agent of its type; an unlocked runtime's settings only start new agents. The revision prevents overwriting concurrent edits.",
        tags: ["Organization"],
        body: SaveRuntimeTemplateSettingsSchema,
        response: constructResponseSchema(RuntimeTemplateEditorSettingsSchema),
      },
    },
    async ({ organizationId, user, body }, reply) => {
      for (const runtime of [
        ...body.templates.map((template) => template.runtime),
        ...Object.values(body.builtIns).map((builtIn) => builtIn.settings),
      ]) {
        await assertAgentRuntimeTiersExist({ runtime, organizationId });
      }
      await assertLockedRuntimesFitAgents({
        organizationId,
        userId: user.id,
        settings: body,
      });
      return reply.send(
        await AgentRuntimeTemplateModel.saveSettings({
          organizationId,
          settings: body,
          popularAgentOverrides: body.popularAgentOverrides,
          afterWrite: ({ tx, settings }) =>
            applyLockedRuntimesToAgents({ organizationId, settings, tx }),
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
        response: constructResponseSchema(AgentRuntimeTemplateSchema),
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
      return reply.send(template);
    },
  );
};

export default agentRuntimeTemplateRoutes;
