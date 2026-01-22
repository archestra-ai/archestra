import config from "@/config";
import anthropicProxyRoutesV1 from "./proxy/anthropic";
import geminiProxyRoutesV1 from "./proxy/gemini";
import openAiProxyRoutesV1 from "./proxy/openai";
import anthropicProxyRoutesV2 from "./proxy/routesv2/anthropic";
import cerebrasProxyRoutesV2 from "./proxy/routesv2/cerebras";
import geminiProxyRoutesV2 from "./proxy/routesv2/gemini";
import ollamaProxyRoutesV2 from "./proxy/routesv2/ollama";
import openAiProxyRoutesV2 from "./proxy/routesv2/openai";
import vllmProxyRoutesV2 from "./proxy/routesv2/vllm";
import zhipuaiProxyRoutesV2 from "./proxy/routesv2/zhipuai";

export { default as a2aRoutes } from "./a2a";
export { default as agentRoutes } from "./agent";
export { default as agentToolRoutes } from "./agent-tool";
export { default as authRoutes } from "./auth";
export { default as autonomyPolicyRoutes } from "./autonomy-policies";
export { default as browserStreamRoutes } from "./browser-stream";
export { default as chatApiKeysRoutes } from "./chat/routes.api-keys";
export { default as chatRoutes } from "./chat/routes.chat";
export { default as chatModelsRoutes } from "./chat/routes.models";
export { default as chatopsRoutes } from "./chatops";
export { default as dualLlmConfigRoutes } from "./dual-llm-config";
export { default as dualLlmResultRoutes } from "./dual-llm-result";
export { default as featuresRoutes } from "./features";
export { default as incomingEmailRoutes } from "./incoming-email";
export { default as interactionRoutes } from "./interaction";
export { default as internalMcpCatalogRoutes } from "./internal-mcp-catalog";
export { default as invitationRoutes } from "./invitation";
export { default as limitsRoutes } from "./limits";
export { mcpGatewayRoutes } from "./mcp-gateway";
export { default as mcpServerRoutes } from "./mcp-server";
export { default as mcpServerInstallationRequestRoutes } from "./mcp-server-installation-requests";
export { default as mcpToolCallRoutes } from "./mcp-tool-call";
export { default as oauthRoutes } from "./oauth";
export { default as optimizationRuleRoutes } from "./optimization-rule";
export { default as organizationRoutes } from "./organization";
export { default as organizationRoleRoutes } from "./organization-role";
export { default as policyConfigSubagentRoutes } from "./policy-config-subagent";
export { default as promptAgentRoutes } from "./prompt-agents";
export { default as promptRoutes } from "./prompts";
// Anthropic proxy routes - V1 (legacy) by default, V2 (unified handler) via env var
export const anthropicProxyRoutes = config.llm.anthropic.useV2Routes
  ? anthropicProxyRoutesV2
  : anthropicProxyRoutesV1;
// Cerebras proxy routes - V2 only (no legacy V1 implementation)
export const cerebrasProxyRoutes = cerebrasProxyRoutesV2;
// Gemini proxy routes - V1 (legacy) by default, V2 (unified handler) via env var
export const geminiProxyRoutes = config.llm.gemini.useV2Routes
  ? geminiProxyRoutesV2
  : geminiProxyRoutesV1;
// OpenAI proxy routes - V1 (legacy) by default, V2 (unified handler) via env var
export const openAiProxyRoutes = config.llm.openai.useV2Routes
  ? openAiProxyRoutesV2
  : openAiProxyRoutesV1;
// vLLM proxy routes - V2 only (unified handler, OpenAI-compatible)
export const vllmProxyRoutes = config.llm.vllm.useV2Routes
  ? vllmProxyRoutesV2
  : vllmProxyRoutesV2; // vLLM only has V2 since it was added after the unified handler
// Ollama proxy routes - V2 only (unified handler, OpenAI-compatible)
export const ollamaProxyRoutes = config.llm.ollama.useV2Routes
  ? ollamaProxyRoutesV2
  : ollamaProxyRoutesV2; // Ollama only has V2 since it was added after the unified handler
// Zhipu AI proxy routes - V2 only (new provider, no legacy v1)
export const zhipuaiProxyRoutes = zhipuaiProxyRoutesV2;
export { default as secretsRoutes } from "./secrets";
export { default as statisticsRoutes } from "./statistics";
export { default as teamRoutes } from "./team";
export { default as tokenRoutes } from "./token";
export { default as tokenPriceRoutes } from "./token-price";
export { default as toolRoutes } from "./tool";
export { default as userRoutes } from "./user";
export { default as userTokenRoutes } from "./user-token";
