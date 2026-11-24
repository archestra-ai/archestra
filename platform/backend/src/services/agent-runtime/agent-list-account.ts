// SPDX-SnippetBegin
// SPDX-SnippetCopyrightText: 2026 Archestra Inc.
// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import {
  isClaudeCodeRuntimeCommand,
  runtimeRequestsClaudeSubscription,
  runtimeSupportsClaudeSubscription,
  SUBSCRIPTION_CREDENTIALS,
  type SupportedProvider,
  subscriptionKindForRuntimeCommand,
} from "@archestra/shared";
import config from "@/config";
import AgentRuntimeTemplateModel from "@/models/agent-runtime-template";
import type { Agent, AgentRuntimeAccountLock } from "@/types";
import { agentRuntimeFor, runtimeAccountKind } from "./account-resolution";

/**
 * Name the provider of the Agent Runtime agents whose runs use each
 * person's own subscription, as the Agents list shows them. Such an agent
 * stores no company connection, or one its lock sets aside: the provider is
 * the subscription's, and the connection the agent still stores is not
 * named. The kind its runtime's account rule names comes first, then the
 * agent's own lock, then its own settings. A person's own choice is not
 * read: the list shows what the agent gives everyone who chose nothing.
 */
export async function populateAgentListSubscriptionAccounts(params: {
  agents: Agent[];
  organizationId: string;
}): Promise<void> {
  const runtimeAgents = params.agents.filter(
    (agent) => agent.agentType === "agent" && !!agent.runtime,
  );
  if (runtimeAgents.length === 0) return;
  const settings = await AgentRuntimeTemplateModel.getSettings(
    params.organizationId,
  );
  for (const agent of runtimeAgents) {
    const runtime = agent.runtime;
    if (!runtime) continue;
    const kind =
      runtimeAccountKind(agentRuntimeFor({ runtime, settings })) ??
      ownLock(runtime.accountLock);
    const provider = subscriptionProvider({ agent, runtime, kind });
    if (!provider) continue;
    // The agent's model holds on the subscription only where it is the
    // subscription's provider's: one of a company connection's is set
    // aside with it.
    if (agent.resolvedLlmProvider !== provider)
      agent.resolvedLlmModelName = null;
    agent.resolvedLlmProvider = provider;
    agent.resolvedLlmProviderKeyName = null;
    agent.resolvedLlmPersonalSubscription = true;
  }
}

// ===

type Runtime = NonNullable<Agent["runtime"]>;

function ownLock(lock: unknown): AgentRuntimeAccountLock | null {
  return lock === "subscription" || lock === "key" ? lock : null;
}

/**
 * The provider of the personal subscription the agent's runs use by default,
 * or null when they use a company connection.
 */
function subscriptionProvider(params: {
  agent: Agent;
  runtime: Runtime;
  kind: AgentRuntimeAccountLock | null;
}): SupportedProvider | null {
  const { agent, runtime, kind } = params;
  if (kind === "key") return null;
  if (runtimeSupportsClaudeSubscription(runtime)) {
    if (kind === "subscription") return "anthropic";
    // Unlocked, the agent's own Claude account decides. The maintained
    // runtime with none set runs on Bedrock or Vertex where its connection
    // is one, as a run does.
    if (!runtimeRequestsClaudeSubscription(runtime)) return null;
    if (
      isClaudeCodeRuntimeCommand(runtime.command?.[0]) &&
      runtime.claudeCode?.authentication !== "subscription" &&
      (agent.resolvedLlmProvider === "bedrock" ||
        (agent.resolvedLlmProvider === "anthropic" &&
          config.llm.anthropic.vertexAi.enabled))
    ) {
      return null;
    }
    return "anthropic";
  }
  const subscription = subscriptionKindForRuntimeCommand(runtime.command?.[0]);
  if (!subscription) return null;
  // Unlocked, the maintained Codex runtime runs on each person's ChatGPT;
  // the others on the account the agent stores, named as it is.
  if (kind === "subscription" || subscription === "chatgpt") {
    return SUBSCRIPTION_CREDENTIALS[subscription].provider;
  }
  return null;
}
// SPDX-SnippetEnd
