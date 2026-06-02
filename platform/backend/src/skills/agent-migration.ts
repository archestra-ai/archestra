import { parseFullToolName, SKILL_ARCHESTRA_TOOL_SHORT_NAMES } from "@shared";
import type { ResourceVisibilityScope } from "@/types/visibility";

/**
 * Short names of the Archestra skill-runtime/plumbing tools (activate, read,
 * list, create, update). Every skill-enabled agent carries the whole set once
 * its org opts in, so recommending them inside a generated skill is circular
 * noise — the activating agent already has them. Matched by short name (prefix
 * stripped) so white-labeled tool prefixes are caught too.
 */
const SKILL_RUNTIME_TOOL_SHORT_NAMES: ReadonlySet<string> = new Set(
  SKILL_ARCHESTRA_TOOL_SHORT_NAMES,
);

/**
 * The subset of an agent the migration actually reads. Declaring it explicitly
 * (rather than the full `Agent`) documents the transform's true inputs and keeps
 * its unit tests honest — a full `Agent` is structurally assignable to it. Array
 * fields are `readonly` so wider element types (e.g. `Tool[]`) assign cleanly.
 *
 * @public — exported for testability (callers pass agents structurally)
 */
export interface MigratableAgent {
  id: string;
  name: string;
  description: string | null;
  systemPrompt: string | null;
  icon: string | null;
  scope: ResourceVisibilityScope;
  modelId: string | null;
  llmModel: string | null;
  tools: readonly { name: string }[];
  teams: readonly { id: string }[];
  labels: readonly { key: string; value: string }[];
  suggestedPrompts: readonly { summaryTitle: string; prompt: string }[];
  knowledgeBaseIds: readonly string[];
  connectorIds: readonly string[];
}

/**
 * Convert an internal `agent` into an Agent Skill (a SKILL.md instruction set).
 *
 * Agents and skills diverge structurally: an agent bundles a prompt *plus*
 * tools, a model, and knowledge sources, whereas a skill carries instructions
 * only — it is prepended to whichever agent invokes it. The conversion is
 * therefore lossy by nature. To make that loss explicit rather than silent,
 * every part of the source agent is either *carried* to a native skill field or
 * *annotated* into the SKILL.md body / metadata, and the {@link MigrationReport}
 * records which. The transform is pure (no IO) so both the REST route and the
 * MCP draft tool can share it and so it can be unit-tested directly.
 *
 * @see https://agentskills.io/specification
 */

/**
 * Marks a skill's `metadata.origin` as produced by agent→skill migration.
 *
 * @public — exported for testability
 */
export const SKILL_ORIGIN_AGENT = "agent";

/**
 * The {@link MigrationField} name each surface uses when it reports what it did
 * with the agent's scope. The transform leaves this out (it can't know the
 * persistence surface); callers append their own entry under this name.
 */
export const SCOPE_FIELD = "scope";

/**
 * A skill ready to persist, derived from an agent: the frontmatter fields plus
 * the markdown body, without the organization/author/source columns the caller
 * fills in from its request context.
 */
interface SkillDraft {
  name: string;
  description: string;
  /** The SKILL.md markdown body, frontmatter stripped. */
  content: string;
  license: string | null;
  compatibility: string | null;
  metadata: Record<string, string>;
  scope: ResourceVisibilityScope;
}

/** One mapped agent field and how it crossed the agent→skill gap. */
interface MigrationField {
  field: string;
  detail: string;
}

/**
 * What the conversion did with each part of the source agent. Nothing is
 * silently lost: a field is either `carried` to a native skill field or
 * `annotated` into the SKILL.md body / metadata.
 */
interface MigrationReport {
  carried: MigrationField[];
  annotated: MigrationField[];
}

interface AgentSkillMigration {
  draft: SkillDraft;
  /** Teams to carry over, populated only when the skill is team-scoped. */
  teamIds: string[];
  report: MigrationReport;
}

interface AgentToSkillOptions {
  /**
   * Description to use instead of the agent's own. The UI requires the user to
   * supply one when the agent has no description (a synthesized "migrated from"
   * line is useless to downstream agents), and lets them refine it otherwise.
   */
  description?: string;
}

export function agentToSkill(
  agent: MigratableAgent,
  options: AgentToSkillOptions = {},
): AgentSkillMigration {
  const carried: MigrationField[] = [];
  const annotated: MigrationField[] = [];

  const name = toSkillName(agent.name);
  if (name === agent.name) {
    carried.push({ field: "name", detail: `"${name}"` });
  } else {
    annotated.push({
      field: "name",
      detail: `normalized "${agent.name}" → "${name}" for slash-command use`,
    });
  }

  const description = deriveDescription(
    agent,
    options.description,
    carried,
    annotated,
  );
  const metadata = buildMetadata(agent, annotated);
  const content = buildContent({
    agent,
    name,
    description,
    carried,
    annotated,
  });
  const teamIds =
    agent.scope === "team" ? agent.teams.map((team) => team.id) : [];

  // Scope is intentionally NOT reported here: whether it survives depends on the
  // persistence surface, not the transform. The REST route persists draft.scope
  // (and teamIds) faithfully and reports it carried; the MCP draft path ends in
  // create_skill, which always makes a personal skill, so it reports scope
  // annotated. Each caller appends its own scope entry — see SCOPE_FIELD.

  return {
    draft: {
      name,
      description,
      content,
      license: null,
      compatibility: null,
      metadata,
      scope: agent.scope,
    },
    teamIds,
    report: { carried, annotated },
  };
}

// ===== Internal helpers =====

const MAX_SKILL_NAME_LENGTH = 64;

/**
 * Slugify an agent name into a skill name: lowercase, non-alphanumerics
 * collapsed to single hyphens, trimmed and length-capped so it works as a
 * `/slash-command`. Falls back to a stable default for names that slugify away
 * entirely (e.g. emoji-only).
 */
function toSkillName(agentName: string): string {
  const slug = agentName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SKILL_NAME_LENGTH)
    .replace(/-+$/g, "");
  return slug || "migrated-agent";
}

/**
 * A skill's `description` is required and drives activation. Prefer the
 * caller-supplied description (the UI requires one when the agent lacks its
 * own), then the agent's own; fall back to the agent name only as a last resort
 * — never a "migrated from" line, which is noise to whatever agent activates the
 * skill.
 */
function deriveDescription(
  agent: MigratableAgent,
  override: string | undefined,
  carried: MigrationField[],
  annotated: MigrationField[],
): string {
  const provided = override?.trim();
  if (provided) {
    carried.push({ field: "description", detail: "set during conversion" });
    return provided;
  }
  const existing = agent.description?.trim();
  if (existing) {
    carried.push({ field: "description", detail: "carried from the agent" });
    return existing;
  }
  annotated.push({
    field: "description",
    detail: "no description provided; using the agent name — add a real one",
  });
  return agent.name;
}

function buildMetadata(
  agent: MigratableAgent,
  annotated: MigrationField[],
): Record<string, string> {
  const metadata: Record<string, string> = {};

  for (const label of agent.labels) {
    metadata[label.key] = label.value;
  }
  if (agent.labels.length > 0) {
    annotated.push({
      field: "labels",
      detail: `${agent.labels.length} label(s) copied into metadata`,
    });
  }

  if (agent.icon) {
    metadata.icon = agent.icon;
    annotated.push({ field: "icon", detail: "stored in metadata.icon" });
  }

  if (agent.modelId) {
    metadata.originAgentModelId = agent.modelId;
  }

  // provenance: lets the UI link back to the origin agent and detect re-conversions.
  metadata.origin = SKILL_ORIGIN_AGENT;
  metadata.originAgentId = agent.id;
  annotated.push({
    field: "provenance",
    detail: "origin + originAgentId recorded in metadata",
  });

  return metadata;
}

function buildContent(params: {
  agent: MigratableAgent;
  name: string;
  description: string;
  carried: MigrationField[];
  annotated: MigrationField[];
}): string {
  const { agent, name, description, carried, annotated } = params;
  const sections: string[] = [];

  const systemPrompt = agent.systemPrompt?.trim();
  if (systemPrompt) {
    sections.push(systemPrompt);
    carried.push({ field: "systemPrompt", detail: "became the skill body" });
  } else {
    annotated.push({
      field: "systemPrompt",
      detail:
        "agent had no system prompt; body synthesized from name/description",
    });
  }

  const recommendedTools = buildRecommendedToolsSection(agent, carried);
  if (recommendedTools) sections.push(recommendedTools);

  const examples = buildExamplesSection(agent, annotated);
  if (examples) sections.push(examples);

  // Model/knowledge bindings have no skill equivalent and mean nothing to a
  // downstream agent, so they are reported to the user but kept out of the body.
  annotateUnmappedBindings(agent, annotated);

  const body = sections.join("\n\n").trim();
  return body || `# ${name}\n\n${description}`;
}

/**
 * List the agent's tools as a recommendation for whatever agent activates the
 * skill. Tools have no native skill equivalent, but their names are actionable
 * guidance — unlike the agent's model/knowledge bindings, which are noise to a
 * downstream agent and are reported out-of-band instead (see
 * {@link annotateUnmappedBindings}). No mention of the migration: the skill
 * stands on its own.
 */
function buildRecommendedToolsSection(
  agent: MigratableAgent,
  carried: MigrationField[],
): string | null {
  const tools = agent.tools.filter((tool) => !isSkillRuntimeTool(tool.name));
  if (tools.length === 0) return null;

  carried.push({
    field: "tools",
    detail: `${tools.length} tool(s) listed as recommended`,
  });
  return (
    "## Recommended tools\n\n" +
    "This skill works best with these tools available:\n\n" +
    tools.map((tool) => `- ${tool.name}`).join("\n")
  );
}

/** True for an Archestra skill-runtime tool, regardless of its server prefix. */
function isSkillRuntimeTool(toolName: string): boolean {
  const { toolName: shortName } = parseFullToolName(toolName);
  return SKILL_RUNTIME_TOOL_SHORT_NAMES.has(shortName);
}

/**
 * Record the agent bindings that cannot cross into a skill — model and
 * knowledge sources — so the conversion report stays honest, without polluting
 * the skill body with details a downstream agent does not care about.
 */
function annotateUnmappedBindings(
  agent: MigratableAgent,
  annotated: MigrationField[],
): void {
  if (agent.modelId || agent.llmModel) {
    annotated.push({
      field: "modelId",
      detail: "agent's default model is not carried over",
    });
  }
  if (agent.knowledgeBaseIds.length > 0) {
    annotated.push({
      field: "knowledgeBaseIds",
      detail: `${agent.knowledgeBaseIds.length} knowledge base(s) not carried over`,
    });
  }
  if (agent.connectorIds.length > 0) {
    annotated.push({
      field: "connectorIds",
      detail: `${agent.connectorIds.length} knowledge connector(s) not carried over`,
    });
  }
}

function buildExamplesSection(
  agent: MigratableAgent,
  annotated: MigrationField[],
): string | null {
  if (agent.suggestedPrompts.length === 0) return null;

  const lines = agent.suggestedPrompts.map(
    (prompt) => `- ${prompt.summaryTitle}: ${prompt.prompt}`,
  );
  annotated.push({
    field: "suggestedPrompts",
    detail: `${agent.suggestedPrompts.length} prompt(s) listed under Example prompts`,
  });
  return `## Example prompts\n\n${lines.join("\n")}`;
}
