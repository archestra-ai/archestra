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

/**
 * What the setting is for, ahead of what the chosen option does — the fixed
 * lead-in that {@link TOOL_CONNECTION_PROMPTING} is read against.
 *
 * The per-choice line names a consequence ("nothing up front", "the chat opens
 * by naming…") without ever saying which decision it is a consequence of, so a
 * reader who has not opened the menu has no anchor for it. This one sentence is
 * that anchor: it states the question the options answer, so the changing line
 * beneath it reads as "…and here is when". Kept record-neutral for the same
 * reason as the lines it precedes — one string has to serve an agent, a gateway
 * and a proxy alike.
 */
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

/**
 * Auto mode as a sentence rather than a count.
 *
 * Auto pins two settings the reader cannot change — progressive tool loading is
 * forced on, and missing connections always asks when a tool needs one — so
 * their rows are not rendered here. What progressive loading buys is the part
 * worth keeping, and it belongs in the one line the mode does get.
 */
export function excludedToolsSummary(count: number | null): string {
  const saves = "Saves context by exposing only search_tools and run_tool";
  // The exclusions editor opens on a server-side pre-fill, so until it has
  // loaded the reach is not known — better to say nothing about it than to
  // claim "every tool" and correct it a moment later.
  if (count === null) return `${saves}.`;
  if (count === 0) return `${saves}, with access to every tool.`;
  return `${saves}, with access to every tool except ${count}.`;
}

/** The same, for the knowledge half of Auto mode. */
export function excludedSourcesSummary(count: number): string {
  if (count === 0) return "Every knowledge source, with no exceptions.";
  return `Every knowledge source, except ${count}.`;
}

/**
 * Custom mode's counterpart to {@link excludedToolsSummary}.
 *
 * Empty at zero: the editor draws its own empty state directly below, and a
 * header that says "no tools assigned" over a panel headed "No tools assigned
 * yet" is the same sentence twice.
 */
export function assignedToolsSummary(count: number): string {
  if (count === 0) return "";
  return `${count} tool${count === 1 ? "" : "s"} assigned.`;
}

/** Auto mode for subagents, as a sentence. */
export function excludedSubagentsSummary(count: number): string {
  if (count === 0) return "Every subagent, with no exceptions.";
  return `Every subagent, except ${count}.`;
}

/** Custom mode for subagents, as a sentence. Empty at zero, as above. */
export function assignedSubagentsSummary(count: number): string {
  if (count === 0) return "";
  return `${count} subagent${count === 1 ? "" : "s"} assigned.`;
}

/**
 * Published skills, both modes in one call.
 *
 * One function rather than a ternary in the JSX: a conditional that resolves to
 * bare text is re-parented by Chrome's translator and crashes React
 * (facebook/react#11538), which the repo lints for.
 */
export function publishedSkillsSummary(params: {
  publishesAll: boolean;
  excludedCount: number;
  assignedCount: number;
}): string {
  if (params.publishesAll) {
    return params.excludedCount === 0
      ? "Every organization skill in this environment, with no exceptions."
      : `Every organization skill in this environment, except ${params.excludedCount}.`;
  }
  if (params.assignedCount === 0) return "";
  return `${params.assignedCount} skill${params.assignedCount === 1 ? "" : "s"} published.`;
}
