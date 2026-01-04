import config from "@/config";
import anthropicProxyRoutesV1 from "./proxy/anthropic";
import openAiProxyRoutesV1 from "./proxy/openai";
import anthropicProxyRoutesV2 from "./proxy/routesv2/anthropic";
import openAiProxyRoutesV2 from "./proxy/routesv2/openai";

export { default as a2aRoutes } from "./a2a";
export { default as agentRoutes } from "./agent";
export { default as agentToolRoutes } from "./agent-tool";
export { default as authRoutes } from "./auth";
export { default as autonomyPolicyRoutes } from "./autonomy-policies";
export { default as chatRoutes } from "./chat/routes";
export { default as chatApiKeysRoutes } from "./chat-api-keys";
export { default as chatModelsRoutes } from "./chat-models";
export { default as dualLlmConfigRoutes } from "./dual-llm-config";
export { default as dualLlmResultRoutes } from "./dual-llm-result";
export { default as featuresRoutes } from "./features";
export { default as interactionRoutes } from "./interaction";
export { default as internalMcpCatalogRoutes } from "./internal-mcp-catalog";
export { default as invitationRoutes } from "./invitation";
export { default as limitsRoutes } from "./limits";
export { legacyMcpGatewayRoutes, newMcpGatewayRoutes } from "./mcp-gateway";
export { default as mcpServerRoutes } from "./mcp-server";
export { default as mcpServerInstallationRequestRoutes } from "./mcp-server-installation-requests";
export { default as mcpToolCallRoutes } from "./mcp-tool-call";
export { default as oauthRoutes } from "./oauth";
export { default as optimizationRuleRoutes } from "./optimization-rule";
export { default as organizationRoutes } from "./organization";
export { default as policyConfigSubagentRoutes } from "./policy-config-subagent";
export { default as promptAgentRoutes } from "./prompt-agents";
export { default as promptRoutes } from "./prompts";
// Anthropic proxy routes - V1 (legacy) by default, V2 (unified handler) via env var
export const anthropicProxyRoutes = config.llm.anthropic.useV2Routes
  ? anthropicProxyRoutesV2
  : anthropicProxyRoutesV1;
export { default as geminiProxyRoutes } from "./proxy/gemini";
// OpenAI proxy routes - V1 (legacy) by default, V2 (unified handler) via env var
export const openAiProxyRoutes = config.llm.openai.useV2Routes
  ? openAiProxyRoutesV2
  : openAiProxyRoutesV1;
export { default as secretsRoutes } from "./secrets";
export { default as statisticsRoutes } from "./statistics";
export { default as teamRoutes } from "./team";
export { default as tokenRoutes } from "./token";
export { default as tokenPriceRoutes } from "./token-price";
export { default as toolRoutes } from "./tool";
export { default as userTokenRoutes } from "./user-token";
