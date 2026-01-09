import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import config from "@/config";
import { McpServerRuntimeManager } from "@/mcp-server-runtime";
import { OrganizationModel } from "@/models";
import { isVertexAiEnabled } from "@/routes/proxy/utils/gemini-client";
import { getByosVaultKvVersion, isByosEnabled } from "@/secrets-manager";
import type { GlobalToolPolicy } from "@/types";

const featuresRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/features",
    {
      schema: {
        operationId: RouteId.GetFeatures,
        description: "Get feature flags",
        tags: ["Features"],
        response: {
          200: z.strictObject({
            /**
             * NOTE: add feature flags here, example:
             * mcp_registry: z.boolean(),
             */
            "orchestrator-k8s-runtime": z.boolean(),
            /** BYOS (Bring Your Own Secrets) - allows teams to use external Vault folders */
            byosEnabled: z.boolean(),
            /** Vault KV version when BYOS is enabled (null if BYOS is disabled) */
            byosVaultKvVersion: z.enum(["1", "2"]).nullable(),
            /** Vertex AI Gemini mode - when enabled, no API key needed for Gemini */
            geminiVertexAiEnabled: z.boolean(),
            /** vLLM mode - when enabled, no API key may be needed */
            vllmEnabled: z.boolean(),
            /** Ollama mode - when enabled, no API key is typically needed */
            ollamaEnabled: z.boolean(),
            /** Global tool policy - permissive bypasses policy checks, restrictive enforces them */
            globalToolPolicy: z.enum(["permissive", "restrictive"]),
            /** Browser streaming - enables live browser automation via Playwright MCP */
            browserStreamingEnabled: z.boolean(),
          }),
        },
      },
    },
    async (_request, reply) => {
      // Get global tool policy from first organization (fallback to permissive)
      const org = await OrganizationModel.getFirst();
      const globalToolPolicy: GlobalToolPolicy =
        org?.globalToolPolicy ?? "permissive";

      return reply.send({
        ...config.features,
        "orchestrator-k8s-runtime": McpServerRuntimeManager.isEnabled,
        byosEnabled: isByosEnabled(),
        byosVaultKvVersion: getByosVaultKvVersion(),
        geminiVertexAiEnabled: isVertexAiEnabled(),
        vllmEnabled: config.llm.vllm.enabled,
        ollamaEnabled: config.llm.ollama.enabled,
        globalToolPolicy,
      });
    },
  );
};

export default featuresRoutes;
