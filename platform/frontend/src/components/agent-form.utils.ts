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
 * What happens when someone sharing the agent has not connected one of the
 * MCP servers its tools come from — the form's choices, in its words, so the
 * detail page describes the saved choice the same way.
 */
export const MISSING_CREDENTIAL_BEHAVIOR_OPTIONS: Array<{
  value: MissingCredentialBehavior;
  label: string;
  /** One line on what a missing server connection means under this choice. */
  describe: (noun: string) => string;
}> = [
  {
    value: "allow",
    label: "Requested when needed",
    describe: () =>
      "The default — nothing is shown up front. A connection is requested the moment a tool call needs one.",
  },
  {
    value: "warn",
    label: "Requested at chat start",
    describe: () =>
      "The chat opens by naming the servers not yet connected, with an offer to connect. Tools from those servers wait until then.",
  },
  {
    value: "block",
    label: "Required before use",
    describe: (noun) =>
      `The ${noun} stays unavailable until every server its tools come from is connected.`,
  },
];

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
