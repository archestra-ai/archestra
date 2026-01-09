import config from "@/config";
import anthropicProxyRoutesV1 from "./proxy/anthropic";
import geminiProxyRoutesV1 from "./proxy/gemini";
import openAiProxyRoutesV1 from "./proxy/openai";
import anthropicProxyRoutesV2 from "./proxy/routesv2/anthropic";
import geminiProxyRoutesV2 from "./proxy/routesv2/gemini";
import openAiProxyRoutesV2 from "./proxy/routesv2/openai";
import minimaxProxyRoutesV2 from "./proxy/routesv2/minimax";
import mistralProxyRoutesV2 from "./proxy/routesv2/mistral";
import deepseekProxyRoutesV2 from "./proxy/routesv2/deepseek";
import groqProxyRoutesV2 from "./proxy/routesv2/groq";
import perplexityProxyRoutesV2 from "./proxy/routesv2/perplexity";
import cerebrasProxyRoutesV2 from "./proxy/routesv2/cerebras";
import xaiProxyRoutesV2 from "./proxy/routesv2/xai";
import zaiProxyRoutesV2 from "./proxy/routesv2/zai";
import togetheraiProxyRoutesV2 from "./proxy/routesv2/togetherai";
import fireworksProxyRoutesV2 from "./proxy/routesv2/fireworks";
import sambanovaProxyRoutesV2 from "./proxy/routesv2/sambanova";
import novitaProxyRoutesV2 from "./proxy/routesv2/novita";

export { default as a2aRoutes } from "./a2a";
export { default as agentRoutes } from "./agent";
export { default as agentToolRoutes } from "./agent-tool";
export { default as authRoutes } from "./auth";
export { default as autonomyPolicyRoutes } from "./autonomy-policies";
export { default as browserStreamRoutes } from "./browser-stream";
export { default as chatApiKeysRoutes } from "./chat/routes.api-keys";
export { default as chatRoutes } from "./chat/routes.chat";
export { default as chatModelsRoutes } from "./chat/routes.models";
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
// Gemini proxy routes - V1 (legacy) by default, V2 (unified handler) via env var
export const geminiProxyRoutes = config.llm.gemini.useV2Routes
  ? geminiProxyRoutesV2
  : geminiProxyRoutesV1;
// OpenAI proxy routes - V1 (legacy) by default, V2 (unified handler) via env var
export const openAiProxyRoutes = config.llm.openai.useV2Routes
  ? openAiProxyRoutesV2
  : openAiProxyRoutesV1;

// MiniMax proxy routes
export const minimaxProxyRoutes = minimaxProxyRoutesV2;

// Mistral proxy routes
export const mistralProxyRoutes = mistralProxyRoutesV2;

// DeepSeek proxy routes
export const deepseekProxyRoutes = deepseekProxyRoutesV2;

// Groq proxy routes
export const groqProxyRoutes = groqProxyRoutesV2;

// Perplexity proxy routes
export const perplexityProxyRoutes = perplexityProxyRoutesV2;

// Cerebras proxy routes
export const cerebrasProxyRoutes = cerebrasProxyRoutesV2;

// xAI proxy routes
export const xaiProxyRoutes = xaiProxyRoutesV2;

// Z.ai proxy routes
export const zaiProxyRoutes = zaiProxyRoutesV2;

// Together AI proxy routes
export const togetheraiProxyRoutes = togetheraiProxyRoutesV2;

// Fireworks proxy routes
export const fireworksProxyRoutes = fireworksProxyRoutesV2;

// SambaNova proxy routes
export const sambanovaProxyRoutes = sambanovaProxyRoutesV2;

// Novita proxy routes
export const novitaProxyRoutes = novitaProxyRoutesV2;

export { default as secretsRoutes } from "./secrets";
export { default as statisticsRoutes } from "./statistics";
export { default as teamRoutes } from "./team";
export { default as tokenRoutes } from "./token";
export { default as tokenPriceRoutes } from "./token-price";
export { default as toolRoutes } from "./tool";
export { default as userTokenRoutes } from "./user-token";
