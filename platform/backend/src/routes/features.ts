import { RouteId } from "@shared";
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
            /** Mistral mode - when enabled, Mistral AI provider is available */
            mistralEnabled: z.boolean(),
            /** Global tool policy - permissive bypasses policy checks, restrictive enforces them */
            globalToolPolicy: z.enum(["permissive", "restrictive"]),
            /** Browser streaming - enables live browser automation via Playwright MCP */
            browserStreamingEnabled: z.boolean(),
            /** Incoming email - allows agents to be invoked via email */
            incomingEmail: z.object({
              enabled: z.boolean(),
              provider: EmailProviderTypeSchema.optional(),
              displayName: z.string().optional(),
              emailDomain: z.string().optional(),
            }),
            /** Knowledge graph - allows document ingestion into knowledge graph on file upload */
            knowledgeGraph: z.object({
              enabled: z.boolean(),
              provider: KnowledgeGraphProviderTypeSchema.optional(),
              displayName: z.string().optional(),
            }),
            /** MCP server base Docker image (shown in UI for reference) */
            mcpServerBaseImage: z.string(),
            /** Default K8s namespace for MCP server pods */
            orchestratorK8sNamespace: z.string(),
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
        mistralEnabled: true, // Mistral is always enabled (has default base URL)
        globalToolPolicy,
        incomingEmail: getEmailProviderInfo(),
        knowledgeGraph: getKnowledgeGraphProviderInfo(),
        mcpServerBaseImage: config.orchestrator.mcpServerBaseImage,
        orchestratorK8sNamespace: config.orchestrator.kubernetes.namespace,
      });
    },
  );
};

export default featuresRoutes;
