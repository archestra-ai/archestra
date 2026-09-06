import { isAzureAiFoundryBaseUrl } from "@/clients/azure-url";
import config from "@/config";
import { anthropicVertexClient } from "./anthropic-vertex";
import { anthropicWorkloadIdentity } from "./anthropic-workload-identity";
import { isAnthropicAzureFoundryEntraIdEnabled } from "./azure-openai-credentials";

export function isAnthropicKeylessAuthEnabled(): boolean {
  return (
    anthropicVertexClient.isEnabled() ||
    anthropicWorkloadIdentity.isEnabled() ||
    (isAnthropicAzureFoundryEntraIdEnabled() &&
      isAzureAiFoundryBaseUrl(config.llm.anthropic.baseUrl))
  );
}
