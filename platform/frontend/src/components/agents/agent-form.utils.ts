import type { AgentType, archestraApiTypes } from "@archestra/shared";
import type { SettingTone } from "@/components/setting-icon";

export function getNamePlaceholder(agentType: AgentType): string {
  const placeholders: Record<AgentType, string> = {
    mcp_gateway: "Enter MCP Gateway name",
    llm_proxy: "Enter LLM Proxy name",
    agent: "Enter agent name",
    profile: "Enter profile name",
  };
  return placeholders[agentType];
}

export function getDescriptionPlaceholder(agentType: AgentType): string {
  const placeholders: Record<AgentType, string> = {
    mcp_gateway: "Describe what this MCP Gateway is for",
    llm_proxy: "Describe what this LLM Proxy is for",
    agent: "Describe what this agent does",
    profile: "Describe what this profile is for",
  };
  return placeholders[agentType];
}

export function shouldShowDescriptionField(params: {
  agentType: AgentType;
  isBuiltIn: boolean;
}) {
  return !params.isBuiltIn;
}

/**
 * Whether the Custom-tools picker offers owned Apps (serverType:"app" backing
 * catalogs) for this agent type. A chat agent renders an app inline from its
 * `__open` tool result; an MCP gateway or legacy profile — both served at
 * `/v1/mcp/:profileId` — expose that tool to a connected MCP client. LLM
 * proxies have no app-render surface. The backend still gates the catalog on
 * `app:read`, so this only decides which dialogs request the rows.
 */
export function shouldOfferAppCatalogs(agentType: AgentType): boolean {
  const offered: Record<AgentType, boolean> = {
    agent: true,
    mcp_gateway: true,
    profile: true,
    llm_proxy: false,
  };
  return offered[agentType];
}

export function normalizeSuggestedPrompts(
  prompts: Array<{ summaryTitle: string; prompt: string }>,
): Array<{ summaryTitle: string; prompt: string }> {
  return prompts
    .filter((sp) => sp.summaryTitle.trim())
    .map((sp) => ({
      summaryTitle: sp.summaryTitle.trim(),
      prompt: sp.prompt.trim() || sp.summaryTitle.trim(),
    }));
}

/**
 * What happens when someone using the agent has not connected one of the MCP
 * servers its tools come from — the choices, named once, so the wizard that
 * sets one and the detail page that reports it cannot name them differently.
 *
 * `allow` is the default.
 */
export const MISSING_CREDENTIAL_BEHAVIOR_OPTIONS: Array<{
  value: MissingCredentialBehavior;
  label: string;
}> = [
  { value: "allow", label: "When a tool needs it" },
  { value: "warn", label: "When the chat opens" },
  { value: "block", label: "Before they can chat" },
];

/**
 * What each choice actually does to the person chatting: one line per choice,
 * in the order the options are offered.
 *
 * Written from inside a chat rather than from the wizard's side of the
 * decision, because the same sentence has to serve a reader who is choosing
 * and a reader who is looking up what was chosen. That also keeps the record's
 * own noun out of it: a sentence naming the agent needs a different noun on a
 * gateway and on a proxy, and interpolating one into a shared template is what
 * let the two surfaces drift apart before — which `block` did anyway, naming
 * the gateway on agents and proxies too until this was rewritten.
 *
 * Each says what happens rather than what is "requested": the old labels never
 * said who was asked, for what, or what followed if they declined.
 */
export const TOOL_CONNECTION_PROMPTING: Record<
  MissingCredentialBehavior,
  string
> = {
  allow:
    "Nothing up front. A missing credential surfaces mid-answer, the moment a tool needs it.",
  warn: "The chat opens by naming every credential not yet connected. Tools needing one wait until it is connected.",
  block:
    "Nothing can be sent until every credential the tools need is connected.",
};

/** Record-neutral purpose copy shared by agents, gateways, and proxies. */
export const MISSING_CREDENTIAL_SUMMARY =
  "Some tools need a credential the user must connect first. This decides when they are prompted for it.";

/**
 * How each connectivity choice reads as a tone: an enforcement scale (lenient
 * → informational → fully enforced), never the error palette — the strictest
 * choice is a setting, not a failure.
 */
export const MISSING_CREDENTIAL_TONE: Record<
  MissingCredentialBehavior,
  SettingTone
> = {
  allow: "off",
  warn: "info",
  block: "on",
};

type MissingCredentialBehavior =
  archestraApiTypes.GetAgentResponses["200"]["missingCredentialBehavior"];

/** The same, for the knowledge half of Auto mode. */
export function excludedSourcesSummary(count: number): string {
  if (count === 0) return "Every knowledge source, with no exceptions.";
  return `Every knowledge source, except ${count}.`;
}

/** Auto mode for subagents, as a sentence. */
export function excludedSubagentsSummary(count: number): string {
  if (count === 0) return "All local agents are subagents.";
  return `All local agents are subagents, except ${count} excluded.`;
}
