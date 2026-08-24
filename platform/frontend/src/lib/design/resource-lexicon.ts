import type { AgentScope } from "@archestra/shared";
import {
  AGENT_PAGE_CONFIGS,
  type AgentPageKind,
} from "@/components/agent-pages/agent-page-config";

/**
 * One vocabulary for the five entity surfaces: agents, skills, LLM proxies,
 * MCP gateways, MCP servers.
 *
 * Before this existed the same field carried a different name per page
 * ("Environment" on the agents list, "Environments" on a skill), the same
 * verb carried a different label per page ("Chat" on an agent, "Chat with a
 * skill" on a skill) and the same fact was phrased three ways ("by Admin on
 * Aug 20, 2026", "on Aug 20, 2026", "Aug 20, 2026"). None of that is a
 * per-page decision, so none of it is written per page any more.
 *
 * The three agent-shaped families read their names out of
 * `AGENT_PAGE_CONFIGS` rather than repeating them here: two spellings of
 * "MCP Gateway" that drift is exactly the failure this module exists to stop.
 */

/**
 * The five surfaces one vocabulary has to cover.
 *
 * Deliberately NOT `AgentPageKind` with two members bolted on. That type is a
 * routing and permission key: it indexes `AGENT_PAGE_CONFIGS`, whose entries
 * carry a base path, a permission resource and wizard copy. Skills and MCP
 * servers have none of those, so widening it would mean optionalising the
 * fields that make the config a config, and every caller of
 * `AGENT_PAGE_CONFIGS[kind].resource` would have to start handling a missing
 * resource that cannot actually happen. Naming is a separate axis, so it gets
 * a separate key.
 */
export type ResourceKey = AgentPageKind | "skill" | "mcp_server";

export interface ResourceNames {
  /** Title case: a page title, or a button's object ("Create Agent"). */
  singular: string;
  /** Mid-sentence; acronyms keep their case ("this MCP gateway"). */
  singularInSentence: string;
  /** Title case: the list page's title, and the back link out of a detail page. */
  plural: string;
}

export const RESOURCE_LEXICON: Record<ResourceKey, ResourceNames> = {
  agent: agentShapedNames("agent"),
  mcp_gateway: agentShapedNames("mcp_gateway"),
  skill: {
    singular: "Skill",
    singularInSentence: "skill",
    plural: "Skills",
  },
  mcp_server: {
    singular: "MCP Server",
    singularInSentence: "MCP server",
    plural: "MCP Servers",
  },
};

/**
 * The back link out of a detail page. One formula, taken from the resource's
 * plural, so the link and the list it returns to always read the same: a
 * detail page that says "Back to skills" while the list is titled "Skills"
 * is two names for one destination.
 */
export function backToListLabel(resource: ResourceKey): string {
  return RESOURCE_LEXICON[resource].plural;
}

/**
 * The back link out of a wizard, which returns to the record being edited
 * rather than to the list.
 */
export function backToRecordLabel(resource: ResourceKey): string {
  return `Back to ${RESOURCE_LEXICON[resource].singularInSentence}`;
}

/**
 * The name of a field, wherever that field is shown.
 *
 * `environment` is singular on every surface including the ones that render
 * several: the label names the field, and pluralising it on the pages that
 * happen to hold more than one value made the same field look like two
 * different ones.
 */
export const FIELD_LABEL = {
  environment: "Environment",
} as const;

/**
 * The label of a verb, wherever that verb is offered: a row action's hover
 * label and accessible name, a header button, a kebab item.
 *
 * Only verbs that appear on more than one of the five surfaces live here. A
 * verb one page alone offers ("Convert to skill") has nothing to agree with
 * and stays where it is used.
 */
export const ACTION_LABEL = {
  chat: "Chat",
  connect: "Connect",
  edit: "Edit",
  /** The read-only destination offered in Edit's place when Edit is not the user's to take. */
  view: "View",
  clone: "Clone",
  versionHistory: "Version history",
  restore: "Restore",
  delete: "Delete",
} as const;

/**
 * Why a mutating control is refused, when RBAC is not what refused it.
 *
 * The scope check is the same rule on every one of these surfaces (the
 * backend's `requireScopedModifyPermission`), so the sentence explaining it is
 * written once. It matters that the reason is stated rather than the control
 * removed: a user who cannot see the button has no way to learn that the
 * record simply is not theirs.
 *
 * The rule is not one sentence, though, because it is not one rule: the
 * backend admits a team admin only for a team-scoped record they belong to,
 * and nobody but a resource admin for an org-scoped one. Naming a team admin
 * on an org-scoped record sends the reader to somebody who will be refused
 * just as they were.
 */
export function notYoursToChange({
  resource,
  scope,
}: {
  resource: ResourceKey;
  scope: AgentScope;
}): string {
  const name = RESOURCE_LEXICON[resource].singularInSentence;
  switch (scope) {
    case "personal":
      return `Only this ${name}'s author or an admin can change it`;
    case "team":
      return `Only this ${name}'s author, a team admin of the teams it is shared with, or an admin can change it`;
    case "org":
      return `Only an admin can change this org-wide ${name}`;
  }
}

// === internal ===

function agentShapedNames(kind: AgentPageKind): ResourceNames {
  const config = AGENT_PAGE_CONFIGS[kind];
  return {
    singular: config.singular,
    singularInSentence: config.singularInSentence,
    plural: config.plural,
  };
}
