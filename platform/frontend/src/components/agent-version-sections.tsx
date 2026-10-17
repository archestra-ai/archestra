"use client";

import type {
  AgentListSection,
  AgentSnapshotSection,
  AgentTextSection,
} from "@/components/agent-version-diff";
import { DiffStatTable } from "@/components/version-history/diff-stat-table";
import type {
  ChangePhrase,
  VersionViewMode,
} from "@/components/version-history/diff-summary-strip";
import {
  DiffLine,
  HunkBlock,
  HunkEditor,
  HunkNote,
  HunkStat,
} from "@/components/version-history/hunk-block";
import { lineCount, lineDelta } from "@/components/version-history/line-delta";
import { cn } from "@/lib/utils/tailwind";

/**
 * An agent version's sections as diff hunks: under "Changes", a
 * `git diff --stat` of what moved and a hunk per moved section read as
 * comparisons; under "All settings", a hunk per section the version carries,
 * read whole. Hooks keep their group as a lead-in on the hunk's name.
 */
export function AgentVersionSections({
  entries,
  mode,
}: {
  entries: AgentSnapshotSection[];
  mode: VersionViewMode;
}) {
  return (
    <div className="flex flex-col gap-3">
      {mode === "changes" ? (
        <DiffStatTable
          unit="section"
          rows={entries.map((section) => ({
            id: section.id,
            path: sectionPath(section),
            ...sectionDelta(section),
          }))}
        />
      ) : null}
      {entries.map((section) => (
        <HunkBlock
          key={section.id}
          id={section.id}
          label={section.label}
          prefix={
            section.kind === "text" ? (section.group ?? undefined) : undefined
          }
          stat={<SectionStat section={section} mode={mode} />}
          change={
            section.change === null || section.change === "unchanged"
              ? null
              : section.change
          }
        >
          <SectionBody section={section} mode={mode} />
        </HunkBlock>
      ))}
    </div>
  );
}

/**
 * The commit-message-ish one-liner for the strip ("+2 tools, system prompt
 * edited") and the +/− totals behind its diffstat.
 */
export function summarizeAgentChanges(moved: AgentSnapshotSection[]): {
  phrases: ChangePhrase[];
  added: number;
  removed: number;
} {
  const phrases: ChangePhrase[] = [];
  let added = 0;
  let removed = 0;
  let hooksChanged = 0;
  for (const section of moved) {
    const delta = sectionDelta(section);
    added += delta.added;
    removed += delta.removed;
    if (section.kind === "fields") {
      phrases.push({
        text: countOf(delta.added, "setting", "settings", "changed"),
        tone: "changed",
      });
    } else if (section.kind === "list") {
      const fallback = section.label.toLowerCase();
      const [one, many] = LIST_NOUNS[section.id] ?? [fallback, fallback];
      if (section.addedCount) {
        phrases.push({
          text: `+${countOf(section.addedCount, one, many)}`,
          tone: "added",
        });
      }
      if (section.removedCount) {
        phrases.push({
          text: `−${countOf(section.removedCount, one, many)}`,
          tone: "removed",
        });
      }
      if (section.changedCount) {
        phrases.push({
          text: countOf(section.changedCount, one, many, "edited"),
          tone: "changed",
        });
      }
    } else if (section.group) {
      hooksChanged += 1;
    } else {
      phrases.push(
        section.change === "added"
          ? { text: `${section.label.toLowerCase()} added`, tone: "added" }
          : section.change === "removed"
            ? {
                text: `${section.label.toLowerCase()} removed`,
                tone: "removed",
              }
            : {
                text: `${section.label.toLowerCase()} edited`,
                tone: "changed",
              },
      );
    }
  }
  if (hooksChanged) {
    phrases.push({
      text: countOf(hooksChanged, "hook", "hooks", "changed"),
      tone: "changed",
    });
  }
  return { phrases, added, removed };
}

// ============================================================================
// Internal helpers
// ============================================================================

type FieldDiff = Extract<
  AgentSnapshotSection,
  { kind: "fields" }
>["fields"][number];

/** Singular and plural for each collection, as the change summary counts them. */
const LIST_NOUNS: Record<string, [string, string]> = {
  tools: ["tool", "tools"],
  "excluded-tools": ["excluded tool", "excluded tools"],
  "excluded-subagents": ["excluded subagent", "excluded subagents"],
  "suggested-prompts": ["suggested prompt", "suggested prompts"],
  "knowledge-bases": ["knowledge base", "knowledge bases"],
  connectors: ["connector", "connectors"],
  "excluded-knowledge-sources": ["excluded source", "excluded sources"],
};

function countOf(n: number, one: string, many: string, verb?: string): string {
  return `${n} ${n === 1 ? one : many}${verb ? ` ${verb}` : ""}`;
}

/** A section's +/− weight: an edited row counts as one of each, as in git. */
function sectionDelta(section: AgentSnapshotSection): {
  added: number;
  removed: number;
} {
  switch (section.kind) {
    case "fields": {
      const edited = section.fields.filter(
        (f) => f.change === "changed",
      ).length;
      return { added: edited, removed: edited };
    }
    case "list":
      return {
        added: section.addedCount + section.changedCount,
        removed: section.removedCount + section.changedCount,
      };
    case "text":
      return lineDelta(section.previous, section.current);
  }
}

function sectionPath(section: AgentSnapshotSection): string {
  return section.kind === "text" && section.group
    ? `${section.group} / ${section.label}`
    : section.label;
}

function SectionStat({
  section,
  mode,
}: {
  section: AgentSnapshotSection;
  mode: VersionViewMode;
}) {
  if (mode === "changes") {
    if (section.kind === "list") {
      return (
        <HunkStat
          added={section.addedCount}
          removed={section.removedCount}
          edited={section.changedCount}
        />
      );
    }
    if (section.kind === "fields") {
      return <HunkStat edited={sectionDelta(section).added} />;
    }
    return <HunkStat {...lineDelta(section.previous, section.current)} />;
  }
  switch (section.kind) {
    case "list":
      return (
        <HunkStat
          summary={countOf(
            section.items.filter((item) => item.change !== "removed").length,
            "item",
            "items",
          )}
        />
      );
    case "fields":
      return (
        <HunkStat
          summary={countOf(section.fields.length, "setting", "settings")}
        />
      );
    case "text":
      return (
        <HunkStat
          summary={countOf(lineCount(section.current), "line", "lines")}
        />
      );
  }
}

function SectionBody({
  section,
  mode,
}: {
  section: AgentSnapshotSection;
  mode: VersionViewMode;
}) {
  switch (section.kind) {
    case "fields":
      return <FieldRows fields={section.fields} mode={mode} />;
    case "list":
      return <ListRows section={section} mode={mode} />;
    case "text":
      return <TextBody section={section} mode={mode} />;
  }
}

/**
 * Settings as diff lines: under "Changes", each moved setting as a `−` line
 * and a `+` line; read whole, every setting with a `*` on the ones that moved.
 */
function FieldRows({
  fields,
  mode,
}: {
  fields: FieldDiff[];
  mode: VersionViewMode;
}) {
  if (mode === "changes") {
    return (
      <div className="divide-y divide-border/60">
        {fields
          .filter((field) => field.change === "changed")
          .map((field) => (
            <div key={field.label}>
              <DiffLine sign="-" label={field.label}>
                {fieldValueText(field.previous)}
              </DiffLine>
              <DiffLine sign="+" label={field.label}>
                {fieldValueText(field.current)}
              </DiffLine>
            </div>
          ))}
      </div>
    );
  }
  return (
    <div className="py-1">
      {fields.map((field) => (
        <DiffLine
          key={field.label}
          sign={field.change === "changed" ? "*" : " "}
          label={field.label}
          muted={!field.current}
        >
          {fieldValueText(field.current)}
        </DiffLine>
      ))}
    </div>
  );
}

function ListRows({
  section,
  mode,
}: {
  section: AgentListSection;
  mode: VersionViewMode;
}) {
  // The whole version reads the version itself, so a removed item only has a
  // row under "Changes" — the list of what moved. No empty state: both filters
  // are the ones that decided this section had a hunk at all, so neither can
  // come back empty.
  const items =
    mode === "changes"
      ? section.items.filter(
          (item) => item.change !== null && item.change !== "unchanged",
        )
      : section.items.filter((item) => item.change !== "removed");
  return (
    <ul className={cn(mode === "all" && "py-1")}>
      {items.map((item) => {
        // A changed item's detail is the change, so both sides show.
        const showDetailDiff =
          item.change === "changed" && item.previousDetail !== item.detail;
        const detail = item.detail ?? item.previousDetail;
        return (
          <li key={item.key}>
            <DiffLine
              sign={
                mode === "all" ? " " : LIST_SIGNS[item.change ?? "unchanged"]
              }
            >
              <span className="flex min-w-0 items-baseline gap-3">
                <span className="truncate">{item.label}</span>
                {showDetailDiff ? (
                  <span className="truncate text-[11px] text-muted-foreground">
                    <span className="line-through decoration-destructive/60">
                      {item.previousDetail ?? "not set"}
                    </span>
                    <span className="px-1.5">→</span>
                    <span className="text-foreground">
                      {item.detail ?? "not set"}
                    </span>
                  </span>
                ) : detail ? (
                  // Both branches root at a span, so React reconciles this one
                  // in place when the change arrives and deletes whatever text
                  // node it holds — which page-translate has since re-parented.
                  // The inner span keeps an element there for React to move.
                  <span className="truncate text-[11px] text-muted-foreground">
                    <span>{detail}</span>
                  </span>
                ) : null}
              </span>
            </DiffLine>
          </li>
        );
      })}
    </ul>
  );
}

const LIST_SIGNS = {
  added: "+",
  removed: "-",
  changed: "~",
  unchanged: " ",
} as const;

function TextBody({
  section,
  mode,
}: {
  section: AgentTextSection;
  mode: VersionViewMode;
}) {
  const asDiff = mode === "changes";
  // Unset and cleared-to-empty are two values a version can hold, and moving
  // between them is an edit the snapshot hashes and a restore writes — but both
  // feed Monaco the same empty document, so a diff would show a reader nothing
  // at all in a section listed as changed. Say what moved instead.
  const movedBetweenUnsetAndEmpty =
    (section.current === null) !== (section.previous === null) &&
    (section.current ?? "") === (section.previous ?? "");
  const hasMeta = asDiff
    ? section.fields.some((field) => field.change === "changed")
    : section.fields.length > 0;
  return (
    <div className="flex flex-col">
      {hasMeta ? (
        <div className="border-b">
          <FieldRows fields={section.fields} mode={mode} />
        </div>
      ) : null}
      {asDiff && movedBetweenUnsetAndEmpty ? (
        <HunkNote>
          {section.current === null
            ? "Not set in this version; empty in the previous one."
            : "Empty in this version; not set in the previous one."}
        </HunkNote>
      ) : asDiff ? (
        <HunkEditor
          language={section.language}
          value={section.current ?? ""}
          original={section.previous ?? ""}
        />
      ) : section.current ? (
        <HunkEditor language={section.language} value={section.current} />
      ) : (
        // An empty body is a value this version holds, not the absence of one,
        // and it gets a line rather than an editor with nothing in it.
        <HunkNote>{section.current === null ? "Not set." : "Empty."}</HunkNote>
      )}
    </div>
  );
}

/**
 * A scalar as the pane reads it. Never set and cleared to the empty string are
 * two different values — the snapshot hashes them apart, which is why an edit
 * between them records a version, and a restore writes the difference — so
 * rendering both the same way would present that version as having changed
 * nothing.
 */
function fieldValueText(value: string | null): string {
  if (value === null) return "Not set";
  if (value === "") return "Empty";
  return value;
}
