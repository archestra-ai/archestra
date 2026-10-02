import { useInternalAgents } from "@/lib/agent.query";
import { useFeature } from "@/lib/config/config.query";
import { useRuntimeCredentials } from "@/lib/runtime-credentials.query";

export function useAccountConnections() {
  const runtimeEnabled = useFeature("agentRuntime");
  const enabled = runtimeEnabled === true;
  const definitions = useRuntimeCredentials(enabled);
  const agents = useInternalAgents({ enabled });
  const personalDefinitions = (definitions.data ?? []).filter(
    (definition) => definition.allowPersonal,
  );
  const claudeAgent = agents.data?.find(
    (agent) => agent.runtime?.command?.[0] === "archestra-claude-code",
  );
  const isError = enabled && (definitions.isError || agents.isError);
  // Wait for empty cached results to finish revalidating before redirecting.
  const isApplicable =
    runtimeEnabled === false
      ? false
      : enabled && (personalDefinitions.length > 0 || claudeAgent)
        ? true
        : enabled &&
            definitions.isSuccess &&
            agents.isSuccess &&
            !definitions.isFetching &&
            !agents.isFetching
          ? false
          : undefined;

  return {
    definitions,
    agents,
    personalDefinitions,
    claudeAgent,
    isError,
    isApplicable,
  };
}
