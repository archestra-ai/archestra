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
  { value: "allow", label: "Requested when needed" },
  { value: "warn", label: "Requested at chat start" },
  { value: "block", label: "Required before use" },
];

/**
 * When users get prompted to connect the servers behind these tools: one line
 * per choice, in the order the options are offered.
 *
 * Written from inside a chat rather than from the wizard's side of the
 * decision, because the same sentence has to serve a reader who is choosing
 * and a reader who is looking up what was chosen. That also keeps the record's
 * own noun out of it: a sentence naming the agent needs a different noun on a
 * gateway and on a proxy, and interpolating one into a shared template is what
 * let the two surfaces drift apart before.
 */
export const TOOL_CONNECTION_PROMPTING: Record<
  MissingCredentialBehavior,
  string
> = {
  allow: "Prompt only when a tool needs a server connection.",
  warn: "At chat start, prompt for every server that is not connected. Their tools remain unavailable until it is.",
  block:
    "Require every backing server to be connected before the gateway can be used.",
};

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
