import { RouteId } from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { userHasPermission } from "@/auth/utils";
import AgentRuntimeTemplateModel from "@/models/agent-runtime-template";
import { ApiError, constructResponseSchema } from "@/types";
import {
  AgentRuntimeTemplateSchema,
  AgentRuntimeTemplateSummarySchema,
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
          "Save custom templates and the combined runtime order. Existing agents retain their runtime configuration. The revision prevents overwriting concurrent edits.",
        tags: ["Organization"],
        body: SaveRuntimeTemplateSettingsSchema,
        response: constructResponseSchema(RuntimeTemplateEditorSettingsSchema),
      },
    },
    async ({ organizationId, body }, reply) => {
      return reply.send(
        await AgentRuntimeTemplateModel.saveSettings({
          organizationId,
          settings: body,
          popularAgentOverrides: body.popularAgentOverrides,
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
