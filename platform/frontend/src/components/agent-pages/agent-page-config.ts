import type { AgentType } from "@archestra/shared";
import type { AgentIconVariant } from "@/components/agent-icon";
import type { WizardStepDefinition } from "@/components/wizard-stepper";

/**
 * The two route families that host an agent-shaped resource. Legacy
 * `profile` rows have no family of their own: the gateway pages accept them.
 */
export type AgentPageKind = "agent" | "mcp_gateway";

export interface AgentPageConfig {
  kind: AgentPageKind;
  /** The list route; the detail and create routes hang off it. */
  basePath: "/agents" | "/mcp/gateways";
  singular: string;
  /** `singular` mid-sentence — acronyms keep their case ("this MCP gateway"). */
  singularInSentence: string;
  plural: string;
  /** Permission resource the routes are gated on. */
  resource: "agent" | "llmProxy" | "mcpGateway";
  defaultIconType: AgentIconVariant;
  /** Sub-headline under "Create <singular>". */
  createDescription: string;
  /** Body of the permanent-delete confirmation; names what history survives. */
  permanentDeleteDescription: (name: string) => string;
}

export const AGENT_PAGE_CONFIGS: Record<AgentPageKind, AgentPageConfig> = {
  agent: {
    kind: "agent",
    basePath: "/agents",
    singular: "Agent",
    singularInSentence: "agent",
    plural: "Agents",
    resource: "agent",
    defaultIconType: "agent",
    createDescription:
      "Give the agent a name and instructions, then pick the tools and knowledge it can use.",
    permanentDeleteDescription: (name) =>
      `This destroys "${name}" and everything it owns. Its chats and LLM interaction history are kept, no longer pointing at the agent. Nothing recovers the agent itself.`,
  },
  mcp_gateway: {
    kind: "mcp_gateway",
    basePath: "/mcp/gateways",
    singular: "MCP Gateway",
    singularInSentence: "MCP gateway",
    plural: "MCP Gateways",
    resource: "mcpGateway",
    defaultIconType: "mcp_gateway",
    createDescription:
      "Name the gateway and choose who can use it, then pick the tools it exposes and connect a client.",
    permanentDeleteDescription: (name) =>
      `This destroys "${name}" and everything it owns. Its MCP tool-call history is kept, no longer pointing at the gateway. Nothing recovers the gateway itself.`,
  },
};

/** The route family a stored agent type belongs to. */
export function agentPageKindForType(agentType: AgentType): AgentPageKind {
  switch (agentType) {
    case "mcp_gateway":
    // Legacy profiles have no family of their own; the gateway routes are
    // their canonical home.
    case "profile":
      return "mcp_gateway";
    default:
      return "agent";
  }
}

/**
 * Whether a route family may render an agent of the given type. A mismatch
 * (a gateway id under `/agents/`) is redirected to the type's own family
 * rather than shown under the wrong header.
 */
export function isAgentTypeAllowedOnPage(
  kind: AgentPageKind,
  agentType: AgentType,
): boolean {
  switch (kind) {
    case "agent":
      return agentType === "agent";
    case "mcp_gateway":
      return agentType === "mcp_gateway" || agentType === "profile";
  }
}

export function agentListHref(kind: AgentPageKind): string {
  return AGENT_PAGE_CONFIGS[kind].basePath;
}

export function agentNewHref(kind: AgentPageKind): string {
  return `${AGENT_PAGE_CONFIGS[kind].basePath}/new`;
}

export type AgentSetupStepId = "configuration" | "tools" | "advanced";

export type AgentSetupStep = WizardStepDefinition<AgentSetupStepId>;

/**
 * The detail page's tabs. The setup steps are the record's configuration,
 * edited in place; `connect` and `executions` are the two read-only views of
 * it. `configuration` is the page's default and carries no `?tab=`.
 */
export type AgentDetailTab = AgentSetupStepId | "connect" | "executions";

export function agentDetailHref(
  kind: AgentPageKind,
  id: string,
  tab?: AgentDetailTab,
): string {
  const base = `${AGENT_PAGE_CONFIGS[kind].basePath}/${encodeURIComponent(id)}`;
  return tab && tab !== "configuration" ? `${base}?tab=${tab}` : base;
}

/**
 * Where "edit this record" lands. Configuration is not a page of its own any
 * more: it is the detail page's own tabs, so every edit deep link in the app
 * resolves to one of them.
 */
export function agentConfigureHref(
  kind: AgentPageKind,
  id: string,
  step?: AgentSetupStepId,
): string {
  return agentDetailHref(kind, id, step);
}

/** The tab a `?tab=` value names, or `configuration` when it names none. */
export function resolveAgentDetailTab(
  tabs: readonly AgentDetailTab[],
  tabParam: string | null | undefined,
): AgentDetailTab {
  const match = tabs.find((tab) => tab === tabParam);
  return match ?? tabs[0] ?? "configuration";
}

const CONFIGURATION_STEP: AgentSetupStep = {
  id: "configuration",
  title: "Configuration",
};
const TOOLS_STEP: AgentSetupStep = { id: "tools", title: "Tools & Knowledge" };
const ADVANCED_STEP: AgentSetupStep = { id: "advanced", title: "Advanced" };

/**
 * The setup wizard's steps for one agent — the same on create and on edit.
 * Configuration is what the record is and who can use it; Tools & Knowledge
 * holds everything the agent reaches; Advanced the settings a record rarely
 * needs. A built-in agent is a single-step edit, so its host renders no
 * stepper. Connecting is not a step: it is the detail page's Connect section,
 * where a record lands once created and which the list's Connect action opens.
 */
export function getAgentSetupSteps({
  builtIn,
}: {
  agentType: AgentType;
  builtIn: boolean;
}): AgentSetupStep[] {
  if (builtIn) return [CONFIGURATION_STEP];
  return [CONFIGURATION_STEP, TOOLS_STEP, ADVANCED_STEP];
}

/**
 * Where the row/dialog deep links of the list pages now land. The list pages
 * used to open create/edit/view dialogs from `?create=true`, `?edit=<id>` and
 * `?view=<id>`; those URLs are still shared and bookmarked, so the list pages
 * forward them to the routed pages. Returns null when the params carry no
 * such request.
 */
export function resolveLegacyAgentDialogRedirect(
  kind: AgentPageKind,
  searchParams: URLSearchParams,
): string | null {
  // Everything the dialog params did not claim travels with the redirect: such
  // a link usually carries the list's own state too (`?edit=x&name=…&page=2`),
  // and dropping it would strand whoever follows the deep link back.
  const carried = new URLSearchParams(searchParams.toString());
  for (const consumed of ["create", "edit", "view", "openTools"]) {
    carried.delete(consumed);
  }
  const withCarried = (href: string) => {
    const rest = carried.toString();
    if (!rest) return href;
    return `${href}${href.includes("?") ? "&" : "?"}${rest}`;
  };

  if (searchParams.get("create") === "true") {
    return withCarried(agentNewHref(kind));
  }
  const editId = searchParams.get("edit");
  if (editId) {
    // `?openTools=true` used to pop the tools picker open inside the edit
    // dialog; it now lands on the tools tab with the same request.
    const openTools = searchParams.get("openTools") === "true";
    const href = agentConfigureHref(
      kind,
      editId,
      openTools ? "tools" : undefined,
    );
    return withCarried(openTools ? `${href}&openTools=true` : href);
  }
  const viewId = searchParams.get("view");
  if (viewId) return withCarried(agentDetailHref(kind, viewId));
  return null;
}
