import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { bundledGenericAdapterRuntimeManager } from "@/agents/chatops/bundled-generic-adapter-runtime-manager";
import { chatOpsManager } from "@/agents/chatops/chatops-manager";
import GenericChatOpsProvider from "@/agents/chatops/generic-provider";
import { CHATOPS_RATE_LIMIT } from "@/agents/chatops/constants";
import { isRateLimited } from "@/agents/utils";
import { type AllowedCacheKey, CacheKey } from "@/cache-manager";
import logger from "@/logging";
import { ApiError, type BundledChatOpsAdapterId } from "@/types";
import { ChatOpsExternalIdMappingModel, UserModel } from "@/models";
import {
  GenericMessageEventRequestSchema,
  GenericInteractiveEventRequestSchema,
  GenericChannelSyncRequestSchema,
} from "@/types/chatops-generic";

const genericProviderCache = new Map<string, GenericChatOpsProvider>();

const AcceptedResponseSchema = z.object({
  accepted: z.literal(true),
  asynchronous: z.literal(true),
});

const ChannelSyncResponseSchema = z.object({
  ok: z.literal(true),
  upserted: z.number().int().nonnegative(),
  deleted: z.number().int().nonnegative(),
  deduplicated: z.number().int().nonnegative(),
});

function resolveProvider(
  adapterId: string,
  baseUrl: string,
  displayName: string,
  workspaceId?: string,
  workspaceName?: string,
): GenericChatOpsProvider {
  const cached = genericProviderCache.get(adapterId);
  if (cached) return cached;

  const provider = new GenericChatOpsProvider({
    adapterId,
    baseUrl,
    workspaceId,
    workspaceName,
    displayName,
  });
  provider.setEventHandler(chatOpsManager);
  genericProviderCache.set(adapterId, provider);
  return provider;
}

function resolveAdapterAndProvider(adapterId: string): {
  provider: GenericChatOpsProvider;
  summary: { status: string };
} {
  const catalogEntry =
    bundledGenericAdapterRuntimeManager.getCatalogEntry(
      adapterId as BundledChatOpsAdapterId,
    );
  const summary = bundledGenericAdapterRuntimeManager.getSummary(
    adapterId as BundledChatOpsAdapterId,
  );

  if (summary.status !== "running") {
    throw new ApiError(
      503,
      `Adapter ${adapterId} is not running (status: ${summary.status})`,
    );
  }

  const port = catalogEntry.connectionPage?.port;
  const baseUrl = port
    ? `http://localhost:${port}`
    : `http://localhost:0`;

  const provider = resolveProvider(
    adapterId,
    baseUrl,
    catalogEntry.displayName,
  );

  return { provider, summary };
}

async function checkRateLimit(clientIp: string, label: string): Promise<void> {
  const rateLimitKey =
    `${CacheKey.WebhookRateLimit}-chatops-generic-${label}-${clientIp}` as AllowedCacheKey;
  const rateLimitConfig = {
    windowMs: CHATOPS_RATE_LIMIT.WINDOW_MS,
    maxRequests: CHATOPS_RATE_LIMIT.MAX_REQUESTS,
  };
  if (await isRateLimited(rateLimitKey, rateLimitConfig)) {
    logger.warn(
      { ip: clientIp },
      `[ChatOps Generic] Rate limit exceeded for ${label}`,
    );
    throw new ApiError(429, "Too many requests");
  }
}

const chatopsGenericRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.post(
    "/api/webhooks/chatops/generic/:adapterId/messages",
    {
      schema: {
        description: "Generic adapter incoming message webhook",
        tags: ["ChatOps Webhooks"],
        params: z.object({
          adapterId: z.string().min(1).max(128),
        }),
        body: GenericMessageEventRequestSchema,
        response: {
          202: AcceptedResponseSchema,
          404: z.object({
            error: z.object({ message: z.string(), type: z.string() }),
          }),
          429: z.object({
            error: z.object({ message: z.string(), type: z.string() }),
          }),
          503: z.object({
            error: z.object({ message: z.string(), type: z.string() }),
          }),
        },
      },
    },
    async (request, reply) => {
      const { adapterId } = request.params;

      const { provider } = resolveAdapterAndProvider(adapterId);

      await checkRateLimit(request.ip || "unknown", `${adapterId}-messages`);

      chatOpsManager
        .handleIncomingMessage(provider, request.body)
        .catch((error) => {
          logger.error(
            {
              adapterId,
              error: error instanceof Error ? error.message : String(error),
            },
            "[ChatOps Generic] Error processing message (async)",
          );
        });

      return reply.status(202).send({ accepted: true, asynchronous: true });
    },
  );

  fastify.post(
    "/api/webhooks/chatops/generic/:adapterId/interactive",
    {
      schema: {
        description: "Generic adapter interactive event webhook",
        tags: ["ChatOps Webhooks"],
        params: z.object({
          adapterId: z.string().min(1).max(128),
        }),
        body: GenericInteractiveEventRequestSchema,
        response: {
          202: AcceptedResponseSchema,
          404: z.object({
            error: z.object({ message: z.string(), type: z.string() }),
          }),
          429: z.object({
            error: z.object({ message: z.string(), type: z.string() }),
          }),
          503: z.object({
            error: z.object({ message: z.string(), type: z.string() }),
          }),
        },
      },
    },
    async (request, reply) => {
      const { adapterId } = request.params;

      const { provider } = resolveAdapterAndProvider(adapterId);

      await checkRateLimit(
        request.ip || "unknown",
        `${adapterId}-interactive`,
      );

      chatOpsManager
        .handleInteractiveSelection(provider, request.body)
        .catch((error) => {
          logger.error(
            {
              adapterId,
              error: error instanceof Error ? error.message : String(error),
            },
            "[ChatOps Generic] Error processing interactive event (async)",
          );
        });

      return reply.status(202).send({ accepted: true, asynchronous: true });
    },
  );

  fastify.post(
    "/api/webhooks/chatops/generic/:adapterId/channels/sync",
    {
      schema: {
        description: "Generic adapter channel sync webhook",
        tags: ["ChatOps Webhooks"],
        params: z.object({
          adapterId: z.string().min(1).max(128),
        }),
        body: GenericChannelSyncRequestSchema,
        response: {
          200: ChannelSyncResponseSchema,
          404: z.object({
            error: z.object({ message: z.string(), type: z.string() }),
          }),
          429: z.object({
            error: z.object({ message: z.string(), type: z.string() }),
          }),
          503: z.object({
            error: z.object({ message: z.string(), type: z.string() }),
          }),
        },
      },
    },
    async (request, reply) => {
      const { adapterId } = request.params;

      const { provider } = resolveAdapterAndProvider(adapterId);

      await checkRateLimit(
        request.ip || "unknown",
        `${adapterId}-channels-sync`,
      );

      const body = request.body;

      provider.syncChannels(
        body.channels.map((ch) => ({
          externalId: ch.externalId,
          name: ch.name ?? null,
          kind: ch.kind,
          dmOwnerEmail: ch.dmOwnerEmail ?? null,
        })),
      );

      return reply.send({
        ok: true,
        upserted: body.channels.length,
        deleted: 0,
        deduplicated: 0,
      });
    },
  );

  fastify.get(
    "/api/webhooks/chatops/generic/:adapterId/agents",
    {
      schema: {
        description: "List available agents for a generic adapter",
        tags: ["ChatOps Webhooks"],
        params: z.object({
          adapterId: z.string().min(1).max(128),
        }),
        querystring: z.object({
          senderEmail: z.string().email().optional(),
          senderExternalId: z.string().min(1).max(512).optional(),
          isDm: z.enum(["true", "false"]).optional(),
        }),
        response: {
          200: z.object({
            agents: z.array(z.object({ id: z.string(), name: z.string() })),
          }),
          404: z.object({
            error: z.object({ message: z.string(), type: z.string() }),
          }),
          503: z.object({
            error: z.object({ message: z.string(), type: z.string() }),
          }),
        },
      },
    },
    async (request, reply) => {
      const { adapterId } = request.params;
      resolveAdapterAndProvider(adapterId);
      await checkRateLimit(request.ip || "unknown", `${adapterId}-agents`);
      const isDm = request.query.isDm === "true";
      let senderEmail = request.query.senderEmail;
      if (!senderEmail && request.query.senderExternalId) {
        const mapping = await ChatOpsExternalIdMappingModel.findByExternalId(
          adapterId,
          request.query.senderExternalId,
        );
        if (mapping) {
          const user = await UserModel.getById(mapping.userId);
          senderEmail = user?.email;
        }
      }
      if (request.query.senderExternalId && !senderEmail) {
        return reply.send({ agents: [] });
      }
      const agents = await chatOpsManager.getAccessibleChatopsAgents({
        senderEmail,
        isDm,
      });
      return reply.send({ agents });
    },
  );
};

export default chatopsGenericRoutes;
