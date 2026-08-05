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

type AgentConfigChange = "added" | "removed" | "changed" | "unchanged";

/**
 * One scalar setting, rendered for display on both sides. `change` is null
 * when there is no baseline — the oldest retained version, or a predecessor
 * that could not be read — since nothing about the row is then a comparison.
 */
interface AgentFieldDiff {
  label: string;
  /** Rendered value in the viewed version; null when unset. */
  current: string | null;
  /** Rendered value in the baseline; null when unset or without a baseline. */
  previous: string | null;
  change: AgentConfigChange | null;
}

/** One row of an assignment collection (a tool, a knowledge base, ...). */
interface AgentListItemDiff {
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
interface AgentFieldsSection extends SectionBase {
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
 * Every section is compared for every agent type. What a section is dropped
 * for is emptiness, never the agent's type: a snapshot carries the whole
 * config surface whatever the type is, and `agent-version-restore.ts` replays
 * all of it, so hiding a section by type would let a restore rewrite settings
 * this comparison never looked at. An LLM proxy loses its tools section
 * because it assigns no tools, not because of what its type may edit — and a
 * gateway that does carry a prompt gets one.
 */
export function compareAgentSnapshots(
  current: AgentConfigSnapshot,
  previous: AgentConfigSnapshot | null,
): AgentSnapshotSection[] {
  return [
    configurationSection(current, previous),
    systemPromptSection(current, previous),
    ...toolsSections(current, previous),
    suggestedPromptsSection(current, previous),
    ...knowledgeSections(current, previous),
    ...hookSections(current, previous),
  ].filter(sectionCarriesContent);
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
      current: current.tools.map(toolItem),
      previous: previous?.tools.map(toolItem),
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

function toolItem(tool: Snapshot["tools"][number]): ListInput {
  return {
    key: tool.toolId,
    label: tool.name,
    detail: tool.credentialResolutionMode,
    // `agent-version-restore.ts` reads a tool's identity as the whole
    // (toolId, mcpServerId, credentialResolutionMode) tuple, so re-pinning a
    // tool to another installation of its server — a different credential — is
    // a write. Compared rather than shown: the snapshot carries the server as
    // a bare id, with nothing readable to put in the row.
    identity: tool.mcpServerId ?? "",
  };
}

/**
 * Suggested prompts carry no id, and nothing stops two from sharing a title —
 * `normalizeSuggestedPrompts` only trims and drops empties. The title alone
 * would collapse duplicates into one row, so deleting one of them would read
 * as an edit of the one that stays. Numbering repeats keeps them apart, while
 * a title that appears once still pairs across versions and reads as an edit.
 */
function suggestedPromptsSection(
  current: Snapshot,
  previous: Snapshot | null,
): AgentListSection {
  return listSection({
    id: "suggested-prompts",
    label: "Suggested prompts",
    current: suggestedPromptItems(current.suggestedPrompts),
    previous: previous
      ? suggestedPromptItems(previous.suggestedPrompts)
      : undefined,
  });
}

function suggestedPromptItems(
  prompts: Snapshot["suggestedPrompts"],
): ListInput[] {
  const seen = new Map<string, number>();
  return prompts.map((prompt) => {
    const occurrence = seen.get(prompt.summaryTitle) ?? 0;
    seen.set(prompt.summaryTitle, occurrence + 1);
    return {
      key: `${prompt.summaryTitle}#${occurrence}`,
      label: prompt.summaryTitle,
      detail: prompt.prompt,
    };
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

/**
 * Whether either side carries anything in this section. Emptiness is a fact
 * about the two snapshots, so a section can only be dropped when there was
 * nothing in it to compare — which means anything that moved survives the
 * filter, and an empty change set really does mean the two versions agree.
 */
function sectionCarriesContent(section: AgentSnapshotSection): boolean {
  switch (section.kind) {
    case "fields":
      return section.fields.length > 0;
    case "list":
      return section.items.length > 0;
    case "text":
      return Boolean(section.current) || Boolean(section.previous);
  }
}

function configurationSection(
  current: Snapshot,
  previous: Snapshot | null,
): AgentFieldsSection {
  const fields = CONFIGURATION_FIELDS.map(
    ({ label, render, identity }) =>
      fieldDiff({
        label,
        current: render(current),
        previous: previous ? render(previous) : null,
        currentIdentity: identity?.(current),
        previousIdentity: previous ? identity?.(previous) : null,
        hasBaseline: previous !== null,
      }),
    // A setting neither side sets says nothing about either version — a
    // gateway has no model, and a row reading "Not set" forever is noise. A
    // setting only one side carries is a change, so it stays.
  ).filter((field) => field.current !== null || field.previous !== null);
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
  /**
   * What "changed" is decided from, when a row is compared on more than it
   * shows. Defaults to `detail`.
   */
  identity?: string;
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
          : sameListItem(before, item)
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

/** Two rows of a collection agree when everything compared about them does. */
function sameListItem(before: ListInput, after: ListInput): boolean {
  return (
    before.label === after.label &&
    before.detail === after.detail &&
    (before.identity ?? "") === (after.identity ?? "")
  );
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
      fieldDiff({
        label,
        current: after ? render(after) : null,
        previous: before ? render(before) : null,
        hasBaseline,
      }),
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

function fieldDiff(params: {
  label: string;
  current: string | null;
  previous: string | null;
  /**
   * Compared in place of the rendered values when given, so a field whose
   * display string is not unique is decided on the id a restore writes.
   * Supplied by a field's `identity`, which is null exactly where `render` is.
   */
  currentIdentity?: string | null;
  previousIdentity?: string | null;
  hasBaseline: boolean;
}): AgentFieldDiff {
  const { label, current, previous, hasBaseline } = params;
  const after = params.currentIdentity ?? current;
  const before = params.previousIdentity ?? previous;
  return {
    label,
    current,
    previous,
    change: !hasBaseline
      ? null
      : (before ?? "") === (after ?? "")
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
 * Every scalar setting a snapshot carries, in the order the configuration pane
 * reads them. Each renders to a display string, and a setting neither side
 * sets drops out of the section rather than being hidden by agent type. Where
 * that string is not unique, `identity` supplies what the row is compared on
 * instead, so the reading matches the one a restore makes.
 *
 * This list is exhaustive against `AgentConfigSnapshotSchema` on purpose: the
 * scalars here plus the sections around them cover the whole snapshot, which
 * is what lets an empty change set be read as "these two versions agree".
 * A field added to the snapshot and not to this table would be restored
 * silently, so add both together.
 *
 * Exhaustive against the snapshot, not against what a restore replays: `Type`,
 * `Identity provider`, and `Built-in configuration` are captured but never
 * written back — `agent-version-restore.ts` refuses the identity provider
 * outright, and never plans the other two. They stay because over-reporting a
 * change is the safe direction; under-reporting is the failure this table
 * exists to prevent.
 */
const CONFIGURATION_FIELDS: {
  label: string;
  render: (snapshot: Snapshot) => string | null;
  /**
   * What "changed" is decided from, when the rendered value is not unique.
   * Defaults to `render`, and must be null exactly where `render` is.
   */
  identity?: (snapshot: Snapshot) => string | null;
}[] = [
  { label: "Name", render: (s) => s.name },
  { label: "Description", render: (s) => s.description },
  { label: "Icon", render: (s) => s.icon },
  { label: "Type", render: (s) => s.agentType },
  {
    label: "Model",
    render: (s) => s.model?.externalId ?? null,
    // `models.external_id` is indexed but not unique — only (provider,
    // model_id) is — so two rows can render the same. A restore compares the
    // id and writes the pair on any difference.
    identity: (s) => s.model?.id ?? null,
  },
  {
    label: "LLM API key",
    render: (s) =>
      s.llmApiKey ? `${s.llmApiKey.name} (${s.llmApiKey.provider})` : null,
    // Key names carry no uniqueness constraint at all, and rotating a key is
    // exactly how two same-named keys on one provider come about.
    identity: (s) => s.llmApiKey?.id ?? null,
  },
  { label: "Tool exposure", render: (s) => s.toolExposureMode },
  { label: "Access all tools", render: (s) => renderBoolean(s.accessAllTools) },
  {
    label: "Access all subagents",
    render: (s) => renderBoolean(s.accessAllSubagents),
  },
  {
    label: "Treat context as untrusted",
    render: (s) => renderBoolean(s.considerContextUntrusted),
  },
  {
    label: "Passthrough headers",
    render: (s) =>
      s.passthroughHeaders.length > 0 ? s.passthroughHeaders.join(", ") : null,
  },
  {
    label: "Incoming email",
    render: (s) => renderBoolean(s.incomingEmailEnabled),
  },
  { label: "Email security mode", render: (s) => s.incomingEmailSecurityMode },
  {
    label: "Email allowed domain",
    render: (s) => s.incomingEmailAllowedDomain,
  },
  { label: "Identity provider", render: (s) => s.identityProviderId },
  { label: "Environment", render: (s) => s.environmentId },
  {
    // A managed blob rather than a setting anyone edits, and one a restore
    // does not replay — captured, so shown rather than hidden. Rendered as
    // JSON so a change to it is visible instead of silent; key order could
    // differ between two equal blobs, which over-reports a change — the safe
    // direction for a restore preview.
    label: "Built-in configuration",
    render: (s) =>
      s.builtInAgentConfig == null
        ? null
        : JSON.stringify(s.builtInAgentConfig),
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
