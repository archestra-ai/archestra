import { readFileSync } from "node:fs";
import { RouteId, SupportedProvidersSchema } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { getEmailProviderInfo } from "@/agents/incoming-email";
import { isBedrockIamAuthEnabled } from "@/clients/bedrock-credentials";
import { isVertexAiEnabled } from "@/clients/gemini-client";
import config from "@/config";
import { McpServerRuntimeManager } from "@/k8s/mcp-server-runtime";
import { OrganizationModel } from "@/models";
import { getByosVaultKvVersion, isByosEnabled } from "@/secrets-manager";
import { EmailProviderTypeSchema, type GlobalToolPolicy } from "@/types";
import { PUBLIC_CONFIG_PATH } from "./route-paths";

const configRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    PUBLIC_CONFIG_PATH,
    {
      schema: {
        operationId: RouteId.GetPublicConfig,
        description: "Get public config",
        tags: ["Config"],
        response: {
          200: z.strictObject({
            disableBasicAuth: z.boolean(),
            disableInvitations: z.boolean(),
            analytics: z.strictObject({
              enabled: z.boolean(),
              posthog: z.strictObject({
                key: z.string(),
                host: z.string(),
              }),
            }),
          }),
        },
      },
    },
    async (_request, reply) => {
      return reply.send({
        disableBasicAuth: config.auth.disableBasicAuth,
        disableInvitations: config.auth.disableInvitations,
        analytics: config.analytics,
      });
    },
  );

  fastify.get(
    "/api/config",
    {
      schema: {
        operationId: RouteId.GetConfig,
        description: "Get platform configuration and feature flags",
        tags: ["Config"],
        response: {
          200: z.strictObject({
            enterpriseFeatures: z.strictObject({
              core: z.boolean(),
              knowledgeBase: z.boolean(),
              fullWhiteLabeling: z.boolean(),
            }),
            features: z.strictObject({
              orchestratorK8sRuntime: z.boolean(),
              byosEnabled: z.boolean(),
              byosVaultKvVersion: z.enum(["1", "2"]).nullable(),
              bedrockIamAuthEnabled: z.boolean(),
              geminiVertexAiEnabled: z.boolean(),
              globalToolPolicy: z.enum(["permissive", "restrictive"]),
              incomingEmail: z.object({
                enabled: z.boolean(),
                provider: EmailProviderTypeSchema.optional(),
                displayName: z.string().optional(),
                emailDomain: z.string().optional(),
              }),
              mcpServerBaseImage: z.string(),
              orchestratorK8sNamespace: z.string(),
              isQuickstart: z.boolean(),
              ngrokDomain: z.string(),
              virtualKeyDefaultExpirationSeconds: z.number(),
              mcpSandboxDomain: z.string().nullable(),
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
        enterpriseFeatures: {
          core: config.enterpriseFeatures.core,
          knowledgeBase: config.enterpriseFeatures.knowledgeBase,
          fullWhiteLabeling: config.enterpriseFeatures.fullWhiteLabeling,
        },
        features: {
          orchestratorK8sRuntime: McpServerRuntimeManager.isEnabled,
          byosEnabled: isByosEnabled(),
          byosVaultKvVersion: getByosVaultKvVersion(),
          bedrockIamAuthEnabled: isBedrockIamAuthEnabled(),
          geminiVertexAiEnabled: isVertexAiEnabled(),
          globalToolPolicy,
          incomingEmail: getEmailProviderInfo(),
          mcpServerBaseImage: config.orchestrator.mcpServerBaseImage,
          orchestratorK8sNamespace: config.orchestrator.kubernetes.namespace,
          isQuickstart: config.isQuickstart,
          ngrokDomain: getNgrokDomain(),
          virtualKeyDefaultExpirationSeconds:
            config.llmProxy.virtualKeyDefaultExpirationSeconds,
          mcpSandboxDomain: config.mcpSandbox.domain,
        },
        providerBaseUrls: {
          openai: config.llm.openai.baseUrl || null,
          openrouter: config.llm.openrouter.baseUrl || null,
          anthropic: config.llm.anthropic.baseUrl || null,
          gemini: config.llm.gemini.baseUrl || null,
          bedrock: config.llm.bedrock.baseUrl || null,
          cohere: config.llm.cohere.baseUrl || null,
          cerebras: config.llm.cerebras.baseUrl || null,
          mistral: config.llm.mistral.baseUrl || null,
          perplexity: config.llm.perplexity.baseUrl || null,
          groq: config.llm.groq.baseUrl || null,
          xai: config.llm.xai.baseUrl || null,
          vllm: config.llm.vllm.baseUrl || null,
          ollama: config.llm.ollama.baseUrl || null,
          zhipuai: config.llm.zhipuai.baseUrl || null,
          minimax: config.llm.minimax.baseUrl || null,
          deepseek: config.llm.deepseek.baseUrl || null,
          azure: config.llm.azure.baseUrl || null,
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
