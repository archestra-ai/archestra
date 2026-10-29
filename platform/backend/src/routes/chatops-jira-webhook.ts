import { Readable } from "node:stream";
import type { FastifyRequest } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import JiraProvider from "@/agents/chatops/jira-provider";
import ChatOpsConfigModel from "@/models/chatops-config";
import { getHiddenMessagingChannels } from "@/services/integration-overrides";
import { enqueueJiraChatOpsEvent } from "@/services/jira-chatops-events";
import { ApiError, constructResponseSchema } from "@/types";
import type { JiraDbConfig } from "@/types/chatops-jira";

const MAX_WEBHOOK_BYTES = 256 * 1024;

const chatopsJiraWebhookRoutes: FastifyPluginAsyncZod = async (fastify) => {
  // Request-scoped only: authentication material never enters a receipt or log.
  const authenticatedConfigs = new WeakMap<
    FastifyRequest,
    Pick<
      JiraDbConfig,
      "id" | "organizationId" | "siteUrl" | "ingressMode" | "webhookSecret"
    > & { botIds: string[] }
  >();
  fastify.post("/api/webhooks/chatops/jira/:integrationId", {
    bodyLimit: MAX_WEBHOOK_BYTES,
    schema: {
      tags: ["ChatOps"],
      params: z.object({ integrationId: z.string().uuid() }),
      body: z.unknown(),
      response: constructResponseSchema(z.object({ accepted: z.boolean() })),
    },
    // Authentication consumes bounded original bytes before Fastify's JSON
    // parser. Never store headers/signatures alongside the durable receipt.
    preParsing: async (request, _reply, payload) => {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of payload) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.length;
        if (size > MAX_WEBHOOK_BYTES)
          throw new ApiError(413, "Jira webhook is too large");
        chunks.push(buffer);
      }
      const raw = Buffer.concat(chunks);
      const config = await ChatOpsConfigModel.getJiraConfig();
      const bot = config?.bots[0];
      if (
        !config?.enabled ||
        config.ingressMode === "poll" ||
        config.id !== request.params.integrationId ||
        !bot
      )
        throw new ApiError(404, "Jira webhook is not configured");
      const provider = new JiraProvider(config, bot);
      if ((await getHiddenMessagingChannels(config.organizationId)).has("jira"))
        throw new ApiError(404, "Jira webhook is not configured");
      if (
        !(await provider.validateWebhookRequest(
          raw.toString("utf8"),
          request.headers,
        ))
      )
        throw new ApiError(401, "Invalid Jira webhook authentication");
      authenticatedConfigs.set(request, {
        id: config.id,
        organizationId: config.organizationId,
        siteUrl: config.siteUrl,
        ingressMode: config.ingressMode,
        webhookSecret: config.webhookSecret,
        botIds: config.bots
          .filter((candidate) => candidate.enabled)
          .map((candidate) => candidate.id),
      });
      return Readable.from(raw);
    },
    handler: async (request) => {
      const config = await ChatOpsConfigModel.getJiraConfig();
      if (!config?.enabled || config.id !== request.params.integrationId)
        throw new ApiError(404, "Jira webhook is not configured");
      const authenticated = authenticatedConfigs.get(request);
      if (
        !authenticated ||
        config.id !== authenticated.id ||
        config.organizationId !== authenticated.organizationId ||
        config.siteUrl !== authenticated.siteUrl ||
        config.ingressMode !== authenticated.ingressMode ||
        config.webhookSecret !== authenticated.webhookSecret
      )
        throw new ApiError(
          409,
          "Jira webhook configuration changed; retry delivery",
        );
      for (const botId of authenticated.botIds) {
        await enqueueJiraChatOpsEvent({
          integrationId: authenticated.id,
          botId,
          organizationId: authenticated.organizationId,
          payload: request.body,
          eventId:
            typeof request.headers["x-atlassian-webhook-identifier"] ===
            "string"
              ? request.headers["x-atlassian-webhook-identifier"]
              : undefined,
        });
      }
      // Every accepted bot receipt and queue item has committed before ACK.
      return { accepted: true };
    },
  });
};

export default chatopsJiraWebhookRoutes;
