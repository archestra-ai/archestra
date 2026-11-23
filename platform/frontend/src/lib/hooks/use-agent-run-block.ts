import {
  type archestraApiTypes,
  SUBSCRIPTION_CREDENTIALS,
} from "@archestra/shared";
import { useAgentRuntimePreflight } from "@/lib/agent-runtime.query";

type Preflight = archestraApiTypes.GetAgentRuntimePreflightResponses["200"];

/**
 * Why the reader cannot start a run on a runtime agent right now, as one
 * short instruction, or null when they can (or the check has not answered).
 * Every control that starts a run shows it instead of acting.
 */
export function useAgentRunBlock(agentId: string, enabled: boolean) {
  const preflight = useAgentRuntimePreflight(agentId, enabled);
  if (!enabled || !preflight.data) return null;
  return agentRunBlock(preflight.data);
}

/**
 * Every block is one short instruction: what to do, and for whom when it is
 * not the reader's to do.
 */
export function agentRunBlock(preflight: Preflight): string | null {
  if (preflight.ready) return null;
  const missing = [...preflight.missing, ...preflight.misconfigured];
  if (missing.some(({ adminOnly }) => adminOnly)) {
    return "Only admins can run this agent.";
  }
  if (missing.some(({ key }) => key === CLAUDE_ACCOUNT)) {
    return doThis("Sign in with Claude");
  }
  if (preflight.missingSubscription) {
    return doThis(
      SUBSCRIPTION_CREDENTIALS[preflight.missingSubscription].connect
        .signInTitle,
    );
  }
  if (preflight.accountError) {
    // The company option's connection is left to each person, and they have
    // picked none that runs: they pick one on the agent's page.
    if (preflight.accountErrorFromConnection) {
      return doThis("Choose a connection");
    }
    // Their subscription does not offer the agent's model, or the model is
    // left to them: they pick one of their own on the agent's page.
    if (preflight.accountErrorFromModel) return doThis("Choose a model");
    return preflight.accountErrorFromChoice
      ? doThis("Choose your account again")
      : "Contact your admin to set up this agent account.";
  }
  const credentials = missing.filter(({ key }) => key !== CLAUDE_ACCOUNT);
  const askAdmin = credentials.filter(({ canConnect }) => canConnect === false);
  if (askAdmin.length > 0) {
    return `Contact your admin to set up ${labels(askAdmin)} for this agent.`;
  }
  if (credentials.length > 0) return doThis(`Set up ${labels(credentials)}`);
  return preflight.incompatible
    ? "Pick a model this agent can run."
    : doThis("Finish its setup");
}

// ===

const CLAUDE_ACCOUNT = "CLAUDE_CODE_ACCOUNT";

function doThis(action: string): string {
  return `${action} to run this agent.`;
}

function labels(credentials: Array<{ label: string }>): string {
  const names = [...new Set(credentials.map(({ label }) => label))];
  return names.length > 2
    ? `${names.slice(0, 2).join(", ")} and ${names.length - 2} more`
    : names.join(" and ");
}
