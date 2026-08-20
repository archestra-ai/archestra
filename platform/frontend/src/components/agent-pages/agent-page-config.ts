import type { AgentType } from "@archestra/shared";
import type { AgentIconVariant } from "@/components/agent-icon";
import type { WizardStepDefinition } from "@/components/wizard-stepper";

/**
 * The three route families that host an agent-shaped resource. Legacy
 * `profile` rows (one record acting as both gateway and proxy) have no family
 * of their own: they are listed under both gateways and proxies, and either
 * family's pages accept them.
 */
export type AgentPageKind = "agent" | "llm_proxy" | "mcp_gateway";

export interface AgentPageConfig {
  kind: AgentPageKind;
  /** The list route; detail/new/edit routes hang off it. */
  basePath: "/agents" | "/llm/proxies" | "/mcp/gateways";
  singular: string;
  /** `singular` mid-sentence — acronyms keep their case ("this MCP gateway"). */
  singularInSentence: string;
  plural: string;
  /** Permission resource the routes are gated on. */
  resource: "agent" | "llmProxy" | "mcpGateway";
  defaultIconType: AgentIconVariant;
  /** Sub-headline under "Create <singular>". */
  createDescription: string;
  /** Sub-headline under "Edit <name>". */
  editDescription: string;
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
    editDescription:
      "Configure the agent, choose its tools and knowledge, and set its advanced options.",
    permanentDeleteDescription: (name) =>
      `This destroys "${name}" and everything it owns. Its chats and LLM interaction history are kept, no longer pointing at the agent. Nothing recovers the agent itself.`,
  },
  llm_proxy: {
    kind: "llm_proxy",
    basePath: "/llm/proxies",
    singular: "LLM Proxy",
    singularInSentence: "LLM proxy",
    plural: "LLM Proxies",
    resource: "llmProxy",
    defaultIconType: "llm_proxy",
    createDescription:
      "Name the proxy and choose who can use it, then connect your app to its endpoint.",
    editDescription: "Configure the proxy and set its advanced options.",
    permanentDeleteDescription: (name) =>
      `This destroys "${name}" and everything it owns. Its LLM interaction history is kept for cost reporting, no longer pointing at the proxy. Nothing recovers the proxy itself.`,
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
    editDescription:
      "Configure the gateway, choose the tools it exposes, and set its advanced options.",
    permanentDeleteDescription: (name) =>
      `This destroys "${name}" and everything it owns. Its MCP tool-call history is kept, no longer pointing at the gateway. Nothing recovers the gateway itself.`,
  },
};

/** The route family a stored agent type belongs to. */
export function agentPageKindForType(agentType: AgentType): AgentPageKind {
  switch (agentType) {
    case "llm_proxy":
      return "llm_proxy";
    case "mcp_gateway":
    // Legacy profiles serve both roles; the gateway routes are their canonical
    // home when nothing else says which side the caller came from.
    case "profile":
      return "mcp_gateway";
    default:
      return "agent";
  }
}

/**
 * Whether a route family may render an agent of the given type. A mismatch
 * (an agent id under `/llm/proxies/`) is redirected to the type's own family
 * rather than shown under the wrong header.
 */
export function isAgentTypeAllowedOnPage(
  kind: AgentPageKind,
  agentType: AgentType,
): boolean {
  switch (kind) {
    case "agent":
      return agentType === "agent";
    case "llm_proxy":
      return agentType === "llm_proxy" || agentType === "profile";
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

export type AgentDetailTab = "overview" | "connect";

export function agentDetailHref(
  kind: AgentPageKind,
  id: string,
  tab: AgentDetailTab = "overview",
): string {
  const base = `${AGENT_PAGE_CONFIGS[kind].basePath}/${encodeURIComponent(id)}`;
  return tab === "overview" ? base : `${base}?tab=${tab}`;
}

export type AgentSetupStepId = "configuration" | "tools" | "advanced";

export type AgentSetupStep = WizardStepDefinition<AgentSetupStepId>;

export function agentEditHref(
  kind: AgentPageKind,
  id: string,
  step?: AgentSetupStepId,
): string {
  const base = `${AGENT_PAGE_CONFIGS[kind].basePath}/${encodeURIComponent(id)}/edit`;
  return step ? `${base}?step=${step}` : base;
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
 * holds everything the agent reaches, which LLM proxies do not have; Advanced
 * the settings a record rarely needs. A built-in agent is a single-step edit,
 * so its host renders no stepper. Connecting is not a step: it is the detail
 * page's Connect tab, where a record lands once created and which the list's
 * Connect action opens.
 */
export function getAgentSetupSteps({
  agentType,
  builtIn,
}: {
  agentType: AgentType;
  builtIn: boolean;
}): AgentSetupStep[] {
  if (builtIn) return [CONFIGURATION_STEP];
  if (agentType === "llm_proxy") return [CONFIGURATION_STEP, ADVANCED_STEP];
  return [CONFIGURATION_STEP, TOOLS_STEP, ADVANCED_STEP];
}

/** The step a `?step=` value names, or the first step when it names none. */
export function resolveAgentSetupStep(
  steps: readonly AgentSetupStep[],
  stepParam: string | null | undefined,
): AgentSetupStepId {
  const match = steps.find((step) => step.id === stepParam);
  return (match ?? steps[0]).id;
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
    // dialog; it now lands on the tools step with the same request.
    const openTools = searchParams.get("openTools") === "true";
    const href = agentEditHref(kind, editId, openTools ? "tools" : undefined);
    return withCarried(openTools ? `${href}&openTools=true` : href);
  }
  const viewId = searchParams.get("view");
  if (viewId) return withCarried(agentDetailHref(kind, viewId));
  return null;
}
