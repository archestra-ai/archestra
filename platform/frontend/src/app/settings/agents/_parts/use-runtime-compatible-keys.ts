import {
  getAgentRuntimeProviderCompatibility,
  providerSupportsChat,
} from "@archestra/shared";
import { useMemo } from "react";
import { useAvailableLlmProviderApiKeys } from "@/lib/llm-provider-api-keys.query";
import type { RuntimeAgent } from "./runtime-agent";

/** Chat-capable provider keys that every given agent's runtime can use. */
export function useRuntimeCompatibleKeys(agents: RuntimeAgent[]) {
  const { data: apiKeys } = useAvailableLlmProviderApiKeys({
    toastOnError: false,
  });
  return useMemo(
    () =>
      (apiKeys ?? []).filter(
        (key) =>
          providerSupportsChat(key.provider) &&
          agents.every(
            (agent) =>
              getAgentRuntimeProviderCompatibility({
                inferenceProtocol: agent.inferenceProtocol,
                runtimeCommand: agent.runtimeCommand,
                provider: key.provider,
              }).compatible,
          ),
      ),
    [apiKeys, agents],
  );
}
