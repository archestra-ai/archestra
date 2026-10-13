import config from "@/config";
import {
  LlmProviderApiKeyModel,
  LlmProviderApiKeyModelLinkModel,
  TeamModel,
} from "@/models";
import type { Agent, AgentRuntime, AgentType } from "@/types";
import { ApiError } from "@/types";
import { isAnyAgentRuntimeBackendDriverEnabled } from "./backends";
import { getResolvedAgentRuntimeModelCompatibility } from "./model-compatibility";

// Checks every surface that writes an Agent's runtime or model must run. The
// agents REST routes and the create_agent/edit_agent MCP tools both call these,
// so neither can store a runtime or model pairing the other would refuse.

export function requireAgentRuntimePermission(params: {
  agentType: AgentType;
  runtime?: AgentRuntime | null;
  isAdmin: boolean;
}): void {
  if (params.runtime == null) return;
  if (!isAnyAgentRuntimeBackendDriverEnabled()) {
    throw new ApiError(
      400,
      "Agent Runtime is unavailable: this cluster does not have the Agent Sandbox controller installed",
    );
  }
  if (params.agentType !== "agent") {
    throw new ApiError(400, "Agent Runtime can only be configured for Agents");
  }
  if (params.runtime.privileged && !params.isAdmin) {
    throw new ApiError(
      403,
      "Only Agent administrators can enable a privileged background deployment",
    );
  }
  if (params.runtime.privileged && !config.agentRuntime.allowPrivileged) {
    throw new ApiError(
      403,
      "Privileged background deployments are disabled by the deployment operator",
    );
  }
}

/** Refuse a model/key pair the caller cannot use, or a half-set pair. */
export async function assertAgentModelSelectionAvailable(params: {
  agent: Pick<Agent, "llmApiKeyId" | "modelId">;
  organizationId: string;
  userId: string;
}): Promise<void> {
  const { llmApiKeyId, modelId } = params.agent;
  if (!llmApiKeyId && !modelId) return;
  if (!llmApiKeyId || !modelId) {
    throw new ApiError(
      400,
      "An agent's model and API key must be set together",
    );
  }
  const userTeamIds = await TeamModel.getUserTeamIds(params.userId);
  const availableKeys = await LlmProviderApiKeyModel.getAvailableKeysForUser(
    params.organizationId,
    params.userId,
    userTeamIds,
  );
  const selectedKey = availableKeys.find((key) => key.id === llmApiKeyId);
  const selectedModelIsLinked = selectedKey
    ? (
        await LlmProviderApiKeyModelLinkModel.getModelsForApiKeyIds([
          selectedKey.id,
        ])
      ).some(({ model }) => model.id === modelId)
    : false;
  if (!selectedModelIsLinked) {
    throw new ApiError(
      400,
      "The selected model and API key must be linked and available to you",
    );
  }
}

export async function assertAgentRuntimeModelCompatibility(params: {
  runtime:
    | Pick<AgentRuntime, "command" | "inferenceProtocol" | "claudeCode">
    | null
    | undefined;
  agent: Pick<Agent, "llmApiKeyId" | "modelId">;
  organizationId: string;
  userId: string;
}): Promise<void> {
  const { runtime } = params;
  if (!runtime) return;
  await assertAgentModelSelectionAvailable(params);
  const result = await getResolvedAgentRuntimeModelCompatibility({
    ...params,
    runtime,
  });
  if (!result.compatibility.compatible) {
    throw new ApiError(409, result.compatibility.message);
  }
}
