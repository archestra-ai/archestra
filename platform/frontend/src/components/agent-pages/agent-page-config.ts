import type { AgentType } from "@archestra/shared";
import type { AgentFormSection } from "@/components/agent-form";
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

export type AgentSetupStepId =
  | "configuration"
  | "tools"
  | "messaging"
  | "advanced";

export type AgentSetupStep = WizardStepDefinition<AgentSetupStepId>;

/**
 * The sections of a record's own page, listed down its side the way the
 * settings surface lists its own. The first four are edited in place;
 * `connect` and `executions` are the two views onto a configured record.
 * `general` is the page's default and carries no `?section=`.
 */
export type AgentDetailSection =
  | "general"
  | "tools"
  | "messaging"
  | "advanced"
  | "settings"
  | "connect"
  | "executions";

/**
 * The form group a page section mounts, for the four that edit the record.
 * `general` is the form's `configuration` group under the name the sidebar
 * gives it.
 */
/**
 * The form groups a page section mounts.
 *
 * `settings` is a gateway's single configuration tab: it mounts three groups at
 * once, which is all merging them amounts to — the form renders every group it
 * is given. An agent keeps the groups on separate tabs, where its longer
 * configuration has room to breathe.
 */
export const AGENT_SECTION_FORM_GROUPS = {
  general: ["configuration"],
  tools: ["tools"],
  messaging: ["messaging"],
  advanced: ["advanced"],
  settings: ["configuration", "tools", "advanced"],
} as const satisfies Partial<
  Record<AgentDetailSection, readonly AgentFormSection[]>
>;

/**
 * Where a bare detail URL lands, which is the record's first section.
 *
 * A gateway exists to be connected to, so it opens on Connect; everything else
 * opens on its own configuration. The paramless form has to agree with this,
 * or the tab bar's current tab would link somewhere other than the address it
 * is rendered at — which is what tells the unsaved-changes guard that clicking
 * the tab you are on goes nowhere.
 */
function defaultDetailSection(kind: AgentPageKind): AgentDetailSection {
  return kind === "mcp_gateway" ? "connect" : "general";
}

export function agentDetailHref(
  kind: AgentPageKind,
  id: string,
  section?: AgentDetailSection,
): string {
  const base = `${AGENT_PAGE_CONFIGS[kind].basePath}/${encodeURIComponent(id)}`;
  return section && section !== defaultDetailSection(kind)
    ? `${base}?section=${section}`
    : base;
}

/**
 * Where "edit this record" lands. Configuration is not a page of its own any
 * more: it is the detail page's own sections, so every edit deep link in the
 * app resolves to one of them. The wizard's step ids are what those links
 * carry, so they are translated here.
 */
export function agentConfigureHref(
  kind: AgentPageKind,
  id: string,
  step?: AgentSetupStepId,
): string {
  // "Edit this record" means its configuration, never wherever the page
  // happens to open — a gateway opens on Connect, which configures nothing.
  //
  // A gateway holds that configuration in one Settings tab, so the three steps
  // the wizard walks separately all resolve there. Sending it to `?section=tools`
  // would name a section it does not have, and the page would quietly correct
  // the URL back to Connect.
  const section = step ? SECTION_FOR_SETUP_STEP[step] : "general";
  if (kind === "mcp_gateway") {
    return agentDetailHref(
      kind,
      id,
      section === "messaging" ? section : "settings",
    );
  }
  return agentDetailHref(kind, id, section);
}

/** The section a `?section=` value names, or the first when it names none. */
export function resolveAgentDetailSection(
  sections: readonly AgentDetailSection[],
  sectionParam: string | null | undefined,
): AgentDetailSection {
  const match = sections.find((section) => section === sectionParam);
  return match ?? sections[0] ?? "general";
}

const SECTION_FOR_SETUP_STEP = {
  configuration: "general",
  tools: "tools",
  messaging: "messaging",
  advanced: "advanced",
} as const satisfies Record<AgentSetupStepId, AgentDetailSection>;

const CONFIGURATION_STEP: AgentSetupStep = {
  id: "configuration",
  title: "Configuration",
};
const TOOLS_STEP: AgentSetupStep = { id: "tools", title: "Tools & Knowledge" };
const MESSAGING_STEP: AgentSetupStep = {
  id: "messaging",
  title: "Messaging Channels",
};
const ADVANCED_STEP: AgentSetupStep = { id: "advanced", title: "Advanced" };

/**
 * The setup wizard's steps for one agent — the same on create and on edit.
 * Configuration is what the record is and who can use it; Tools & Knowledge
 * holds everything the agent reaches; Messaging Channels where it answers;
 * Advanced the settings a record rarely needs. Only an `agent` has channels —
 * a gateway or proxy is not something a person messages — so the step is
 * offered for that type alone. A built-in agent is a single-step edit, so its host renders no
 * stepper. Connecting is not a step: it is the detail page's Connect section,
 * where a record lands once created and which the list's Connect action opens.
 */
export function getAgentSetupSteps({
  agentType,
  builtIn,
}: {
  agentType: AgentType;
  builtIn: boolean;
}): AgentSetupStep[] {
  if (builtIn) return [CONFIGURATION_STEP];
  return [
    CONFIGURATION_STEP,
    TOOLS_STEP,
    ...(agentType === "agent" ? [MESSAGING_STEP] : []),
    ADVANCED_STEP,
  ];
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
    // `&` only works if the href already carries a query, which is not
    // guaranteed: a section that is the record's default carries no param.
    return withCarried(
      openTools
        ? `${href}${href.includes("?") ? "&" : "?"}openTools=true`
        : href,
    );
  }
  const viewId = searchParams.get("view");
  if (viewId) return withCarried(agentDetailHref(kind, viewId));
  return null;
}
