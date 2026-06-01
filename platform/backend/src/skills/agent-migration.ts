import { dump as dumpYaml } from "js-yaml";
import type { ResourceVisibilityScope } from "@/types/visibility";

/**
 * The subset of an agent the migration actually reads. Declaring it explicitly
 * (rather than the full `Agent`) documents the transform's true inputs and keeps
 * its unit tests honest — a full `Agent` is structurally assignable to it. Array
 * fields are `readonly` so wider element types (e.g. `Tool[]`) assign cleanly.
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

/** Marks a skill's `metadata.origin` as produced by agent→skill migration. */
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
export interface SkillDraft {
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
export interface MigrationField {
  field: string;
  detail: string;
}

/**
 * What the conversion did with each part of the source agent. Nothing is
 * silently lost: a field is either `carried` to a native skill field or
 * `annotated` into the SKILL.md body / metadata.
 */
export interface MigrationReport {
  carried: MigrationField[];
  annotated: MigrationField[];
}

export interface AgentSkillMigration {
  draft: SkillDraft;
  /** Teams to carry over, populated only when the skill is team-scoped. */
  teamIds: string[];
  report: MigrationReport;
}

export function agentToSkill(agent: MigratableAgent): AgentSkillMigration {
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

  const description = deriveDescription(agent, carried, annotated);
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

/**
 * Render a {@link SkillDraft} as a complete SKILL.md manifest (YAML frontmatter
 * + body) that round-trips through `parseSkillManifest`. The MCP draft tool
 * returns this string for the model to edit before calling `create_skill`; the
 * REST route persists the structured draft directly and does not need it.
 */
export function serializeSkillManifest(draft: SkillDraft): string {
  const frontmatter: Record<string, unknown> = {
    name: draft.name,
    description: draft.description,
  };
  if (draft.license) frontmatter.license = draft.license;
  if (draft.compatibility) frontmatter.compatibility = draft.compatibility;
  if (Object.keys(draft.metadata).length > 0) {
    frontmatter.metadata = draft.metadata;
  }

  const yaml = dumpYaml(frontmatter, { lineWidth: -1 }).trimEnd();
  return `---\n${yaml}\n---\n\n${draft.content}\n`;
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
 * A skill's `description` is required and drives activation; an agent's is
 * nullable. Use the agent's when present, otherwise synthesize one and record
 * that it was generated.
 */
function deriveDescription(
  agent: MigratableAgent,
  carried: MigrationField[],
  annotated: MigrationField[],
): string {
  const existing = agent.description?.trim();
  if (existing) {
    carried.push({ field: "description", detail: "carried from the agent" });
    return existing;
  }
  annotated.push({
    field: "description",
    detail: "agent had none; a placeholder description was synthesized",
  });
  return `Migrated from the "${agent.name}" agent.`;
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

  const requirements = buildRequirementsSection(agent, annotated);
  if (requirements) sections.push(requirements);

  const examples = buildExamplesSection(agent, annotated);
  if (examples) sections.push(examples);

  const body = sections.join("\n\n").trim();
  return body || `# ${name}\n\n${description}`;
}

/**
 * Surface the agent's tool/model/knowledge bindings — which have no native skill
 * equivalent — as a human-readable section, so the loss is visible inside the
 * artifact and the invoking agent knows what to re-attach.
 */
function buildRequirementsSection(
  agent: MigratableAgent,
  annotated: MigrationField[],
): string | null {
  const lines: string[] = [];

  if (agent.tools.length > 0) {
    lines.push(`- Tools: ${agent.tools.map((tool) => tool.name).join(", ")}`);
    annotated.push({
      field: "tools",
      detail: `${agent.tools.length} tool(s) listed under Requirements`,
    });
  }

  if (agent.modelId || agent.llmModel) {
    lines.push("- Default model: configured on the source agent");
    annotated.push({
      field: "modelId",
      detail: "noted under Requirements and in metadata",
    });
  }

  if (agent.knowledgeBaseIds.length > 0) {
    lines.push(`- Knowledge bases: ${agent.knowledgeBaseIds.length}`);
    annotated.push({
      field: "knowledgeBaseIds",
      detail: `${agent.knowledgeBaseIds.length} knowledge base(s) noted under Requirements`,
    });
  }

  if (agent.connectorIds.length > 0) {
    lines.push(`- Knowledge connectors: ${agent.connectorIds.length}`);
    annotated.push({
      field: "connectorIds",
      detail: `${agent.connectorIds.length} connector(s) noted under Requirements`,
    });
  }

  if (lines.length === 0) return null;

  return (
    "## Requirements\n\n" +
    `Migrated from the "${agent.name}" agent, which had its own tools and ` +
    "configuration. A skill carries instructions only — re-attach the " +
    "equivalents to whichever agent invokes this skill:\n\n" +
    lines.join("\n")
  );
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
