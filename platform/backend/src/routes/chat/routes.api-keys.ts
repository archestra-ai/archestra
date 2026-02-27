```typescript
import type { IncomingHttpHeaders } from "node:http";
import { PROVIDERS_WITH_OPTIONAL_API_KEY, RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { capitalize } from "lodash-es";
import { z } from "zod";
import {
  hasAnyAgentTypeAdminPermission,
  hasPermission,
} from "@/auth";
import { isVertexAiEnabled } from "@/clients/gemini-client";
import logger from "@/logging";
import {
  ApiKeyModelModel,
  ChatApiKeyModel,
  TeamModel,
  VirtualApiKeyModel,
} from "@/models";
import { testProviderApiKey } from "@/routes/chat/routes.models";
import {
  assertByosEnabled,
  isByosEnabled,
  secretManager,
} from "@/secrets-manager";
import { modelSyncService } from "@/services/model-sync";
import {
  ApiError,
  ChatApiKeyScopeSchema,
  ChatApiKeyWithScopeInfoSchema,
  constructResponseSchema,
  SelectChatApiKeySchema,
  type SelectSecret,
  type SupportedChatProvider,
  SupportedChatProviderSchema,
} from "@/types";

const chatApiKeysRoutes: FastifyPluginAsyncZod = async (fastify) => {
  // ... existing code

  // Add x.ai (Grok) support
  fastify.get(
    "/api/chat-api-keys/xai-grok",
    {
      schema: {
        operationId: RouteId.GetXaiGrokApiKeys,
        description: "Get x.ai (Grok) API keys",
        tags: ["Chat API Keys"],
        response: constructResponseSchema(
          z.array(ChatApiKeyWithScopeInfoSchema),
        ),
      },
    },
    async ({ organizationId, user }, reply) => {
      // Get user's team IDs
      const userTeamIds = await TeamModel.getUserTeamIds(user.id);

      // Check if user is an agent admin
      const isAgentAdmin = await hasAnyAgentTypeAdminPermission({
        userId: user.id,
        organizationId,
      });

      const apiKeys = await ChatApiKeyModel.getVisibleKeys(
        organizationId,
        user.id,
        userTeamIds,
        isAgentAdmin,
      );
      return reply.send(apiKeys);
    },
  );

  // ... existing code
};

export default chatApiKeysRoutes;