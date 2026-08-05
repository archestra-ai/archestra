/**
 * Pure helpers for comparing two immutable agent config versions. A version's
 * snapshot is the whole canonical config rather than a patch, so the change
 * set the history dialog shows is computed here by pairing a version's
 * sections with its predecessor's.
 *
 * A snapshot is structured config, not a file set, so unlike the skill
 * version diff the unit of comparison is a *section* — the scalar settings,
 * the system prompt, each assignment collection, each hook — and each section
 * kind carries the shape its rendering needs: field rows, list items, or text.
 */

import type { AgentConfigSnapshot } from "@/lib/agent-version.query";

export type AgentConfigChange = "added" | "removed" | "changed" | "unchanged";

/**
 * One scalar setting, rendered for display on both sides. `change` is null
 * when there is no baseline — the oldest retained version, or a predecessor
 * that could not be read — since nothing about the row is then a comparison.
 */
export interface AgentFieldDiff {
  label: string;
  /** Rendered value in the viewed version; null when unset. */
  current: string | null;
  /** Rendered value in the baseline; null when unset or without a baseline. */
  previous: string | null;
  change: AgentConfigChange | null;
}

/** One row of an assignment collection (a tool, a knowledge base, ...). */
export interface AgentListItemDiff {
  key: string;
  label: string;
  /** Secondary line in the viewed version (e.g. a credential mode). */
  detail: string | null;
  /** Secondary line in the baseline, shown when the item changed. */
  previousDetail: string | null;
  change: AgentConfigChange | null;
}

interface SectionBase {
  id: string;
  label: string;
  /**
   * What the section did relative to the baseline; null without one, so the
   * tree claims nothing about what moved.
   */
  change: AgentConfigChange | null;
}

/** Scalar settings, read as label/value rows. */
export interface AgentFieldsSection extends SectionBase {
  kind: "fields";
  fields: AgentFieldDiff[];
}

/** An assignment collection, read as item rows with per-item changes. */
export interface AgentListSection extends SectionBase {
  kind: "list";
  items: AgentListItemDiff[];
  addedCount: number;
  removedCount: number;
  changedCount: number;
}

/** A text body (system prompt, hook content), read whole or as a text diff. */
export interface AgentTextSection extends SectionBase {
  kind: "text";
  language: string;
  /** Meta rows rendered above the text (a hook's event, enabled state, ...). */
  fields: AgentFieldDiff[];
  /** Text in the viewed version; null when the version does not carry it. */
  current: string | null;
  previous: string | null;
  /** Groups hook entries under one tree heading; null for root sections. */
  group: string | null;
}

export type AgentSnapshotSection =
  | AgentFieldsSection
  | AgentListSection
  | AgentTextSection;

/**
 * Compare a version's snapshot against its predecessor's, producing the
 * ordered section list the history dialog renders.
 *
 * Both sides are versions that were actually read. A version with no baseline
 * is not compared at all — every `change` is null — since calling everything
 * `added` would report the absence of a baseline as a fact about the agent's
 * history.
 *
 * The snapshot schema is one shape for every agent type, but the types edit
 * different parts of it — an LLM proxy assigns no tools, a gateway carries no
 * model or prompt. Sections and fields a type never edits are dropped, keyed
 * off the viewed snapshot's own `agentType`, so the history shows the same
 * surface the editor does.
 */
export function compareAgentSnapshots(
  current: AgentConfigSnapshot,
  previous: AgentConfigSnapshot | null,
): AgentSnapshotSection[] {
  const agentType = current.agentType;
  return [
    configurationSection(current, previous),
    ...(isInternalAgent(agentType)
      ? [systemPromptSection(current, previous)]
      : []),
    ...(assignsTools(agentType) ? toolsSections(current, previous) : []),
    ...(isInternalAgent(agentType)
      ? [suggestedPromptsSection(current, previous)]
      : []),
    ...(assignsTools(agentType) ? knowledgeSections(current, previous) : []),
    ...(isInternalAgent(agentType) ? hookSections(current, previous) : []),
  ];
}

/** The tool surface: assignments, exclusions, and delegation exclusions. */
function toolsSections(
  current: Snapshot,
  previous: Snapshot | null,
): AgentListSection[] {
  return [
    listSection({
      id: "tools",
      label: "Tools",
      current: current.tools.map((tool) => ({
        key: tool.toolId,
        label: tool.name,
        detail: tool.credentialResolutionMode,
      })),
      previous: previous?.tools.map((tool) => ({
        key: tool.toolId,
        label: tool.name,
        detail: tool.credentialResolutionMode,
      })),
    }),
    listSection({
      id: "excluded-tools",
      label: "Excluded tools",
      current: current.excludedTools.map((tool) => ({
        key: tool.toolId,
        label: tool.name,
        detail: null,
      })),
      previous: previous?.excludedTools.map((tool) => ({
        key: tool.toolId,
        label: tool.name,
        detail: null,
      })),
    }),
    listSection({
      id: "excluded-subagents",
      label: "Excluded subagents",
      current: current.excludedSubagents.map((subagent) => ({
        key: subagent.agentId,
        label: subagent.name,
        detail: null,
      })),
      previous: previous?.excludedSubagents.map((subagent) => ({
        key: subagent.agentId,
        label: subagent.name,
        detail: null,
      })),
    }),
  ];
}

function suggestedPromptsSection(
  current: Snapshot,
  previous: Snapshot | null,
): AgentListSection {
  return listSection({
    id: "suggested-prompts",
    label: "Suggested prompts",
    current: current.suggestedPrompts.map((prompt) => ({
      key: prompt.summaryTitle,
      label: prompt.summaryTitle,
      detail: prompt.prompt,
    })),
    previous: previous?.suggestedPrompts.map((prompt) => ({
      key: prompt.summaryTitle,
      label: prompt.summaryTitle,
      detail: prompt.prompt,
    })),
  });
}

/** Assigned knowledge: knowledge bases and connectors. */
function knowledgeSections(
  current: Snapshot,
  previous: Snapshot | null,
): AgentListSection[] {
  return [
    listSection({
      id: "knowledge-bases",
      label: "Knowledge bases",
      current: current.knowledgeBases.map((kb) => ({
        key: kb.id,
        label: kb.name,
        detail: null,
      })),
      previous: previous?.knowledgeBases.map((kb) => ({
        key: kb.id,
        label: kb.name,
        detail: null,
      })),
    }),
    listSection({
      id: "connectors",
      label: "Connectors",
      current: current.connectors.map((connector) => ({
        key: connector.id,
        label: connector.name,
        detail: null,
      })),
      previous: previous?.connectors.map((connector) => ({
        key: connector.id,
        label: connector.name,
        detail: null,
      })),
    }),
  ];
}

/** Sections that moved — what the "Changes" mode lists. */
export function changedSections(
  sections: AgentSnapshotSection[],
): AgentSnapshotSection[] {
  return sections.filter(
    (section) => section.change !== null && section.change !== "unchanged",
  );
}

// === Internal helpers ===

type Snapshot = AgentConfigSnapshot;

// What each agent type actually edits, mirrored from the agent dialog's
// per-type visibility (`agent-dialog.tsx`). Only an internal agent carries a
// prompt, a model, hooks, and email triggers; only an LLM proxy assigns no
// tools. An unknown type errs toward showing more rather than hiding edits.
function isInternalAgent(agentType: string): boolean {
  return agentType === "agent";
}

function assignsTools(agentType: string): boolean {
  return agentType !== "llm_proxy";
}

function configurationSection(
  current: Snapshot,
  previous: Snapshot | null,
): AgentFieldsSection {
  const fields = CONFIGURATION_FIELDS.filter(
    ({ when }) => when?.(current.agentType) ?? true,
  ).map(({ label, render }) =>
    fieldDiff(label, render(current), previous ? render(previous) : null, {
      hasBaseline: previous !== null,
    }),
  );
  return {
    id: "configuration",
    label: "Configuration",
    kind: "fields",
    fields,
    change: sectionChange(previous !== null, fields),
  };
}

function systemPromptSection(
  current: Snapshot,
  previous: Snapshot | null,
): AgentTextSection {
  return {
    id: "system-prompt",
    label: "System prompt",
    kind: "text",
    language: "markdown",
    fields: [],
    current: current.systemPrompt,
    previous: previous?.systemPrompt ?? null,
    group: null,
    change: !previous
      ? null
      : (previous.systemPrompt ?? "") === (current.systemPrompt ?? "")
        ? "unchanged"
        : "changed",
  };
}

interface ListInput {
  key: string;
  label: string;
  detail: string | null;
}

function listSection(params: {
  id: string;
  label: string;
  current: ListInput[];
  previous: ListInput[] | undefined;
}): AgentListSection {
  const hasBaseline = params.previous !== undefined;
  const previousByKey = new Map(
    (params.previous ?? []).map((item) => [item.key, item]),
  );

  const items: AgentListItemDiff[] = params.current.map((item) => {
    const before = previousByKey.get(item.key) ?? null;
    return {
      key: item.key,
      label: item.label,
      detail: item.detail,
      previousDetail: before?.detail ?? null,
      change: !hasBaseline
        ? null
        : !before
          ? "added"
          : before.detail === item.detail && before.label === item.label
            ? "unchanged"
            : "changed",
    };
  });

  const currentKeys = new Set(params.current.map((item) => item.key));
  for (const item of params.previous ?? []) {
    if (currentKeys.has(item.key)) continue;
    items.push({
      key: item.key,
      label: item.label,
      detail: null,
      previousDetail: item.detail,
      change: "removed",
    });
  }
  items.sort((a, b) => a.label.localeCompare(b.label));

  const count = (change: AgentConfigChange) =>
    items.filter((item) => item.change === change).length;
  const addedCount = count("added");
  const removedCount = count("removed");
  const changedCount = count("changed");
  return {
    id: params.id,
    label: params.label,
    kind: "list",
    items,
    addedCount,
    removedCount,
    changedCount,
    change: !hasBaseline
      ? null
      : addedCount + removedCount + changedCount > 0
        ? "changed"
        : "unchanged",
  };
}

/**
 * One text section per hook across both sides, keyed by event and file name —
 * a hook only the baseline holds is a removal, and still gets a row to read.
 * The file name alone would not do: the same name is allowed under two events,
 * and collapsing those into one row would diff one hook's body against the
 * other's.
 */
function hookSections(
  current: Snapshot,
  previous: Snapshot | null,
): AgentTextSection[] {
  const currentByKey = new Map(
    current.hooks.map((hook) => [hookKey(hook), hook]),
  );
  const previousByKey = new Map(
    (previous?.hooks ?? []).map((hook) => [hookKey(hook), hook]),
  );
  const keys = [
    ...new Set([...currentByKey.keys(), ...previousByKey.keys()]),
  ].sort((a, b) => a.localeCompare(b));

  return keys.map((key) => {
    const after = currentByKey.get(key) ?? null;
    const before = previousByKey.get(key) ?? null;
    // One side is always present, so either carries the hook's identity.
    const { event, fileName } = (after ?? before) as SnapshotHook;
    const hasBaseline = previous !== null;
    const fields = HOOK_FIELDS.map(({ label, render }) =>
      fieldDiff(
        label,
        after ? render(after) : null,
        before ? render(before) : null,
        { hasBaseline },
      ),
    );
    return {
      id: `hook:${key}`,
      label: `${fileName} (${event})`,
      kind: "text" as const,
      language: languageForFileName(fileName),
      fields,
      current: after?.content ?? null,
      previous: before?.content ?? null,
      group: "Hooks",
      change: !hasBaseline
        ? null
        : !before
          ? "added"
          : !after
            ? "removed"
            : before.content !== after.content ||
                fields.some((field) => field.change === "changed")
              ? "changed"
              : "unchanged",
    };
  });
}

function fieldDiff(
  label: string,
  current: string | null,
  previous: string | null,
  { hasBaseline }: { hasBaseline: boolean },
): AgentFieldDiff {
  return {
    label,
    current,
    previous,
    change: !hasBaseline
      ? null
      : (previous ?? "") === (current ?? "")
        ? "unchanged"
        : "changed",
  };
}

function sectionChange(
  hasBaseline: boolean,
  fields: AgentFieldDiff[],
): AgentConfigChange | null {
  if (!hasBaseline) return null;
  return fields.some((field) => field.change === "changed")
    ? "changed"
    : "unchanged";
}

function renderBoolean(value: boolean): string {
  return value ? "Yes" : "No";
}

/**
 * The scalar settings a snapshot carries, in the order the configuration pane
 * reads them. Each renders to a display string so comparing and showing are
 * the same representation. `when` limits a setting to the agent types that
 * edit it; absent means every type. `builtInAgentConfig` is deliberately
 * absent: it is an opaque managed blob, not a setting anyone edits.
 */
const CONFIGURATION_FIELDS: {
  label: string;
  render: (snapshot: Snapshot) => string | null;
  when?: (agentType: string) => boolean;
}[] = [
  { label: "Name", render: (s) => s.name },
  { label: "Description", render: (s) => s.description },
  { label: "Icon", render: (s) => s.icon },
  { label: "Type", render: (s) => s.agentType },
  {
    label: "Model",
    when: isInternalAgent,
    render: (s) => s.model?.externalId ?? null,
  },
  {
    label: "LLM API key",
    when: isInternalAgent,
    render: (s) =>
      s.llmApiKey ? `${s.llmApiKey.name} (${s.llmApiKey.provider})` : null,
  },
  {
    label: "Tool exposure",
    when: assignsTools,
    render: (s) => s.toolExposureMode,
  },
  {
    label: "Access all tools",
    when: assignsTools,
    render: (s) => renderBoolean(s.accessAllTools),
  },
  {
    label: "Access all subagents",
    when: assignsTools,
    render: (s) => renderBoolean(s.accessAllSubagents),
  },
  {
    label: "Treat context as untrusted",
    when: (t) => t === "llm_proxy" || isInternalAgent(t),
    render: (s) => renderBoolean(s.considerContextUntrusted),
  },
  {
    label: "Passthrough headers",
    when: (t) => t === "mcp_gateway",
    render: (s) =>
      s.passthroughHeaders.length > 0 ? s.passthroughHeaders.join(", ") : null,
  },
  {
    label: "Incoming email",
    when: isInternalAgent,
    render: (s) => renderBoolean(s.incomingEmailEnabled),
  },
  {
    label: "Email security mode",
    when: isInternalAgent,
    render: (s) => s.incomingEmailSecurityMode,
  },
  {
    label: "Email allowed domain",
    when: isInternalAgent,
    render: (s) => s.incomingEmailAllowedDomain,
  },
  {
    label: "Identity provider",
    when: (t) => t !== "profile",
    render: (s) => s.identityProviderId,
  },
  {
    label: "Environment",
    when: (t) => t !== "profile",
    render: (s) => s.environmentId,
  },
];

type SnapshotHook = Snapshot["hooks"][number];

/** What makes a hook unique on an agent, matching the database's constraint. */
function hookKey(hook: SnapshotHook): string {
  return `${hook.event}/${hook.fileName}`;
}

const HOOK_FIELDS: {
  label: string;
  render: (hook: SnapshotHook) => string | null;
}[] = [
  { label: "Event", render: (hook) => hook.event },
  { label: "Enabled", render: (hook) => renderBoolean(hook.enabled) },
  {
    label: "Requirements",
    render: (hook) =>
      hook.requirements.length > 0 ? hook.requirements.join(", ") : null,
  },
];

function languageForFileName(fileName: string): string {
  const extension = fileName.slice(fileName.lastIndexOf(".") + 1).toLowerCase();
  return LANGUAGES_BY_EXTENSION[extension] ?? "plaintext";
}

const LANGUAGES_BY_EXTENSION: Record<string, string> = {
  js: "javascript",
  mjs: "javascript",
  py: "python",
  sh: "shell",
  ts: "typescript",
};
