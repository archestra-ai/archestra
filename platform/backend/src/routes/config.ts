import { readFileSync } from "node:fs";
import { RouteId, SupportedProvidersSchema } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { getEmailProviderInfo } from "@/agents/incoming-email";
import { isVertexAiEnabled } from "@/clients/gemini-client";
import config from "@/config";
import { getKnowledgeGraphProviderInfo } from "@/knowledge-graph";
import { McpServerRuntimeManager } from "@/mcp-server-runtime";
import { OrganizationModel } from "@/models";
import { getByosVaultKvVersion, isByosEnabled } from "@/secrets-manager";
import { EmailProviderTypeSchema, type GlobalToolPolicy } from "@/types";
import { KnowledgeGraphProviderTypeSchema } from "@/types/knowledge-graph";

const configRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/config",
    {
      schema: {
        operationId: RouteId.GetConfig,
        description: "Get platform configuration and feature flags",
        tags: ["Config"],
        response: {
          200: z.strictObject({
            features: z.strictObject({
              "orchestrator-k8s-runtime": z.boolean(),
              byosEnabled: z.boolean(),
              byosVaultKvVersion: z.enum(["1", "2"]).nullable(),
              geminiVertexAiEnabled: z.boolean(),
              globalToolPolicy: z.enum(["permissive", "restrictive"]),
              browserStreamingEnabled: z.boolean(),
              incomingEmail: z.object({
                enabled: z.boolean(),
                provider: EmailProviderTypeSchema.optional(),
                displayName: z.string().optional(),
                emailDomain: z.string().optional(),
              }),
              knowledgeGraph: z.object({
                enabled: z.boolean(),
                provider: KnowledgeGraphProviderTypeSchema.optional(),
                displayName: z.string().optional(),
              }),
              mcpServerBaseImage: z.string(),
              orchestratorK8sNamespace: z.string(),
              isQuickstart: z.boolean(),
              ngrokDomain: z.string(),
              virtualKeyDefaultExpirationSeconds: z.number(),
            }),
            providerBaseUrls: z.record(
              SupportedProvidersSchema,
              z.string().nullable(),
            ),
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
        features: {
          ...config.features,
          "orchestrator-k8s-runtime": McpServerRuntimeManager.isEnabled,
          byosEnabled: isByosEnabled(),
          byosVaultKvVersion: getByosVaultKvVersion(),
          geminiVertexAiEnabled: isVertexAiEnabled(),
          globalToolPolicy,
          incomingEmail: getEmailProviderInfo(),
          knowledgeGraph: getKnowledgeGraphProviderInfo(),
          mcpServerBaseImage: config.orchestrator.mcpServerBaseImage,
          orchestratorK8sNamespace: config.orchestrator.kubernetes.namespace,
          isQuickstart: config.isQuickstart,
          ngrokDomain: getNgrokDomain(),
          virtualKeyDefaultExpirationSeconds:
            config.llmProxy.virtualKeyDefaultExpirationSeconds,
        },
        providerBaseUrls: {
          openai: config.llm.openai.baseUrl || null,
          anthropic: config.llm.anthropic.baseUrl || null,
          gemini: config.llm.gemini.baseUrl || null,
          bedrock: config.llm.bedrock.baseUrl || null,
          cohere: config.llm.cohere.baseUrl || null,
          cerebras: config.llm.cerebras.baseUrl || null,
          mistral: config.llm.mistral.baseUrl || null,
          perplexity: config.llm.perplexity.baseUrl || null,
          groq: config.llm.groq.baseUrl || null,
          vllm: config.llm.vllm.baseUrl || null,
          ollama: config.llm.ollama.baseUrl || null,
          zhipuai: config.llm.zhipuai.baseUrl || null,
          minimax: config.llm.minimax.baseUrl || null,
          deepseek: config.llm.deepseek.baseUrl || null,
        },
      });
    },
  );
};

export default configRoutes;

/**
 * Get the ngrok domain from env var or from the file written by the
 * detect-ngrok-domain.sh script (for dynamically assigned domains).
 */
function getNgrokDomain(): string {
  if (config.ngrokDomain) return config.ngrokDomain;
  try {
    return readFileSync("/app/data/.ngrok_domain", "utf-8").trim();
  } catch {
    return "";
  }
}
