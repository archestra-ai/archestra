import {
  agentCatalogIdForImage,
  PopularAgentIdSchema,
  RouteId,
} from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import config from "@/config";
import AgentRuntimeTemplateModel from "@/models/agent-runtime-template";
import { assertAgentRuntimeTiersExist } from "@/services/agent-runtime/agent-config-validation";
import {
  applyAgentRuntimeToAgents,
  assertCanUseAgentRuntime,
  countAgentsBehindRuntime,
  listAgentRuntimeAccess,
} from "@/services/agent-runtime/agent-runtime-access";
import { ApiError, constructResponseSchema } from "@/types";
import {
  AgentRuntimeAccessSchema,
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
          "List the settings administrators chose for the maintained runtimes.",
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
    "/api/agent-runtime-templates/access",
    {
      schema: {
        operationId: RouteId.ListAgentRuntimeAccess,
        description:
          "List which Agent Runtimes the caller may put agents on and configure, and whether they may run an image that is none of them.",
        tags: ["Agents"],
        response: constructResponseSchema(AgentRuntimeAccessSchema),
      },
    },
    async ({ organizationId, user }, reply) =>
      reply.send(
        await listAgentRuntimeAccess({ organizationId, userId: user.id }),
      ),
  );

  fastify.get(
    "/api/agent-runtime-templates/:id/apply-to-agents",
    {
      schema: {
        operationId: RouteId.CountAgentsBehindRuntime,
        description:
          "Count the existing agents of an Agent Runtime whose settings differ from the runtime's saved settings.",
        tags: ["Organization"],
        params: z.object({
          id: z.union([PopularAgentIdSchema, z.string().uuid()]),
        }),
        response: constructResponseSchema(
          z.object({ agents: z.number().int().nonnegative() }),
        ),
      },
    },
    async ({ organizationId, params }, reply) =>
      reply.send({
        agents: await countAgentsBehindRuntime({
          organizationId,
          runtimeId: params.id,
        }),
      }),
  );

  fastify.post(
    "/api/agent-runtime-templates/:id/apply-to-agents",
    {
      schema: {
        operationId: RouteId.ApplyAgentRuntimeToAgents,
        description:
          "Give every existing agent of an Agent Runtime that runtime's current settings. Agents keep their own environment, credentials and ports.",
        tags: ["Organization"],
        params: z.object({
          id: z.union([PopularAgentIdSchema, z.string().uuid()]),
        }),
        response: constructResponseSchema(
          z.object({ updated: z.number().int().nonnegative() }),
        ),
      },
    },
    async (request, reply) => {
      const { organizationId, user, params } = request;
      const updated = await applyAgentRuntimeToAgents({
        organizationId,
        userId: user.id,
        runtimeId: params.id,
      });
      if (updated.agents.length === 0) request.auditSkip = true;
      const agents = updated.agents.map(({ name }) => name);
      request.auditBefore = {
        runtime: updated.name,
        agentsOnOtherSettings: agents,
      };
      request.auditAfter = { runtime: updated.name, agentsOnOtherSettings: [] };
      return reply.send({ updated: agents.length });
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
          "Save custom templates, the maintained templates' settings, and the combined runtime order. Settings start new agents; apply them to existing agents separately. The revision prevents overwriting concurrent edits.",
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
      const previous =
        await AgentRuntimeTemplateModel.getSettings(organizationId);
      const previousImages = new Map(
        previous.templates.map(({ id, runtime }) => [id, runtime.image.trim()]),
      );
      for (const template of body.templates) {
        // Checked only for new or changed images, so settings saved before
        // these rules still save.
        const image = template.runtime.image.trim();
        if (previousImages.get(template.id) === image) continue;
        if (
          agentCatalogIdForImage({
            image,
            catalogImages: config.agentRuntime.catalogImages,
          })
        )
          throw new ApiError(
            400,
            `${template.name} uses a maintained image, so agents on it run as that built-in runtime. Use another image, or configure the built-in runtime instead.`,
          );
        // An agent belongs to a custom runtime by its image, and so do the
        // permissions on it, so each image names one runtime.
        const other = body.templates.find(
          (candidate) =>
            candidate.id !== template.id &&
            candidate.runtime.image.trim() === image,
        );
        if (other)
          throw new ApiError(
            400,
            `${template.name} and ${other.name} use the same image. Give each custom runtime its own image.`,
          );
      }
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
      const settings =
        await AgentRuntimeTemplateModel.getSettings(organizationId);
      const template = settings.templates.find((item) => item.id === params.id);
      if (!template || template.hidden)
        throw new ApiError(404, "Runtime template not found");
      await assertCanUseAgentRuntime({
        organizationId,
        userId: user.id,
        runtime: template.runtime,
      });
      return reply.send(template);
    },
  );
};

export default agentRuntimeTemplateRoutes;
