"use client";

import {
  ARCHESTRA_MCP_CATALOG_ID,
  TOOL_ASK_USER_SHORT_NAME,
  TOOL_EXECUTE_REMEDY_PLAN_SHORT_NAME,
} from "@archestra/shared";
import {
  ArrowDown,
  ArrowRight,
  FileInput,
  Hand,
  History,
  ShieldAlert,
  ShieldCheck,
  Users,
  Wrench,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import { SearchableSelect } from "@/components/ui/searchable-select";
import {
  type CoverageTool,
  useAllCoverageToolsForCatalogs,
} from "@/lib/openappa-coverage.query";
import { cn } from "@/lib/utils/tailwind";
import { hasSource, type SetupShape } from "./setup-rule";

/** A tool picked in the flow, with what the stations and summary show. */
export interface PickedTool {
  toolId: string;
  fullName: string;
  /** The rule that judges the tool today, if the policy or a battery names it. */
  rule: { source: "root" | "battery" } | null;
  /** The tool's own name, after the server prefix. */
  name: string;
  server: string;
  catalogId: string;
}

/** A tool catalog the picker lists: an MCP server or the built-in tools. */
export interface SetupCatalog {
  id: string;
  name: string;
}

/** Built-in tools OpenAPPA never checks, so a rule on them does nothing. */
const UNCHECKED_BUILT_INS = new Set<string>([
  TOOL_ASK_USER_SHORT_NAME,
  TOOL_EXECUTE_REMEDY_PLAN_SHORT_NAME,
]);

/**
 * Built-in tools that change something outside the conversation, listed first
 * where a slot asks for a tool that acts: the obvious ones to guard.
 */
const SUGGESTED_BUILT_INS = new Map<string, string>([
  ["save_file", "Writes a file"],
  ["edit_file", "Changes a file"],
  ["delete_file", "Deletes a file"],
  ["run_command", "Runs a shell command"],
  ["publish_app", "Publishes an app"],
  ["set_project_share", "Shares a project"],
  ["transfer_credential", "Hands over a credential"],
  ["update_guardrails_policy", "Changes the OpenAPPA policy"],
]);

/** What a slot asks for: a tool that brings content in, or one that acts. */
type ToolUse = "reads" | "acts";

/** Names that start with these read, for tools whose server gave no hint. */
const READ_NAME =
  /^(get|list|read|search|query|find|fetch|view|describe|show|preview|lookup|whoami|download)([_\-A-Z]|$)/;

/**
 * Whether a tool only reads: the server's `readOnlyHint` when it gave one,
 * otherwise a guess from the verb its name starts with.
 */
function toolReads(tool: { name: string; readOnly: boolean | null }) {
  return tool.readOnly ?? READ_NAME.test(tool.name);
}

const USE_COPY: Record<
  ToolUse,
  { search: string; empty: string; all: string }
> = {
  reads: {
    search: "Search tools that read…",
    empty: "No tool that reads matches.",
    all: "Also list tools that act",
  },
  acts: {
    search: "Search tools that act…",
    empty: "No tool that acts matches.",
    all: "Also list tools that only read",
  },
};

interface RuleFlowEdit {
  catalogs: SetupCatalog[];
  onSource: (tool: PickedTool) => void;
  onGuarded: (tool: PickedTool) => void;
}

/** What each station says for a shape, around the picked tools. */
const SHAPE_COPY: Record<
  SetupShape,
  {
    first: { label: string; caption: string };
    second: { label: string; caption: string };
    third: { label: string; caption: string };
  }
> = {
  flow: {
    first: {
      label: "1. Agent reads",
      caption:
        "The result holds content other people can write, such as issues, web pages or emails.",
    },
    second: {
      label: "2. OpenAPPA lowers trust",
      caption: "Trust never goes back up in this conversation.",
    },
    third: {
      label: "3. Agent tries to act",
      caption:
        "A person approves each call. Trust stays low, so the next call asks again.",
    },
  },
  audience: {
    first: {
      label: "1. Agent reads",
      caption:
        "The result is company data, such as customer records or internal documents.",
    },
    second: {
      label: "2. OpenAPPA narrows the audience",
      caption:
        "From here on, what the agent holds is for your organization only.",
    },
    third: {
      label: "3. Agent tries to share",
      caption:
        "A person approves each call. The audience stays narrow, so the next call asks again.",
    },
  },
  tool: {
    first: {
      label: "1. Agent calls",
      caption: "In any conversation, whatever the agent read before.",
    },
    second: {
      label: "2. OpenAPPA checks the rule",
      caption: "Every call needs its own approval.",
    },
    third: {
      label: "3. A person decides",
      caption:
        "The call runs once a person approves it, and not if they deny it.",
    },
  },
  repeat: {
    first: {
      label: "1. Agent calls",
      caption: "The first call in a conversation runs as usual.",
    },
    second: {
      label: "2. OpenAPPA records it",
      caption:
        "Once a call succeeds, the conversation records that the tool ran.",
    },
    third: {
      label: "3. Agent calls it again",
      caption: "Every further call in this conversation waits for a person.",
    },
  },
};

/**
 * A setup rule drawn as the path a tool call takes, left to right. With `edit`
 * the drawing is the editor: tools are picked in their stations. Without it,
 * the same picture explains the idea with placeholder tools.
 */
export function RuleFlow({
  shape,
  source,
  guarded,
  sourcePlaceholder = "A tool that reads",
  guardedPlaceholder = "A tool that acts",
  edit,
}: {
  shape: SetupShape;
  source: PickedTool | null;
  guarded: PickedTool | null;
  sourcePlaceholder?: string;
  guardedPlaceholder?: string;
  edit?: RuleFlowEdit;
}) {
  const copy = SHAPE_COPY[shape];
  const paired = hasSource(shape);
  // The first empty slot is the one to fill next.
  const nextSlot = paired && !source ? "source" : !guarded ? "guarded" : null;

  const guardedSlot = (
    <ToolSlot
      tool={guarded}
      placeholder={
        edit
          ? shape === "flow"
            ? "Pick a tool that acts"
            : shape === "audience"
              ? "Pick a tool that shares"
              : "Pick a tool that acts"
          : guardedPlaceholder
      }
      label="Tool that needs approval"
      use="acts"
      edit={edit}
      exclude={paired ? source?.fullName : undefined}
      onPick={edit?.onGuarded}
      highlight={nextSlot === "guarded"}
    />
  );
  const waits = (
    <p className="flex items-center gap-1.5 text-sm font-medium [&>svg]:size-4">
      <Hand />
      <span>Waits for a person</span>
    </p>
  );
  // What the label was and what it becomes, for the two shapes that narrow it.
  const change =
    shape === "flow"
      ? { from: "trusted", to: "suspicious" }
      : shape === "audience"
        ? { from: "public", to: "internal" }
        : null;

  return (
    <ol
      aria-label="How the rule works"
      className="grid gap-2 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_auto_minmax(0,1fr)] md:items-stretch"
    >
      <Station
        icon={paired ? <FileInput /> : <Wrench />}
        label={copy.first.label}
        caption={copy.first.caption}
      >
        {paired ? (
          <ToolSlot
            tool={source}
            placeholder={edit ? "Pick a tool that reads" : sourcePlaceholder}
            label="Tool that reads"
            use="reads"
            edit={edit}
            exclude={guarded?.fullName}
            onPick={edit?.onSource}
            highlight={nextSlot === "source"}
          />
        ) : (
          guardedSlot
        )}
      </Station>
      <Connector />
      <Station
        icon={
          shape === "flow" ? (
            <ShieldAlert />
          ) : shape === "audience" ? (
            <Users />
          ) : shape === "repeat" ? (
            <History />
          ) : (
            <ShieldCheck />
          )
        }
        label={copy.second.label}
        caption={copy.second.caption}
        tone="label"
      >
        {change ? (
          <div className="flex flex-wrap items-center gap-1.5">
            <Mark tone="muted" struck>
              {change.from}
            </Mark>
            <ArrowRight className="size-3.5 text-muted-foreground" />
            <Mark tone="warn">{change.to}</Mark>
          </div>
        ) : (
          <div>
            <Mark tone="warn">
              {shape === "repeat" ? "ran once" : "needs a person's OK"}
            </Mark>
          </div>
        )}
      </Station>
      <Connector />
      <Station
        icon={<Hand />}
        label={copy.third.label}
        caption={copy.third.caption}
        tone="ask"
      >
        {paired && guardedSlot}
        {shape === "repeat" && (
          <ToolSlot
            tool={guarded}
            placeholder="The same tool"
            label="Same tool"
            use="acts"
            highlight={false}
          />
        )}
        {change && (
          <dl className="grid grid-cols-[auto_1fr] items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <dt>Needs</dt>
            <dd>
              <Mark tone="muted">{change.from}</Mark>
            </dd>
            <dt>Has</dt>
            <dd>
              <Mark tone="warn">{change.to}</Mark>
            </dd>
          </dl>
        )}
        {waits}
      </Station>
    </ol>
  );
}

function Station({
  icon,
  label,
  caption,
  tone = "neutral",
  children,
}: {
  icon: ReactNode;
  label: string;
  caption: string;
  tone?: "neutral" | "label" | "ask";
  children: ReactNode;
}) {
  return (
    <li
      className={cn(
        "flex min-w-0 flex-col gap-3 rounded-lg border bg-card p-3",
        tone === "label" && "border-dashed bg-muted/40",
      )}
    >
      <div
        className={cn(
          "flex items-center gap-1.5 text-xs font-medium text-muted-foreground [&>svg]:size-3.5 [&>svg]:shrink-0",
          tone === "ask" &&
            "[&>svg]:text-amber-600 dark:[&>svg]:text-amber-400",
        )}
      >
        {icon}
        <span>{label}</span>
      </div>
      {children}
      <p className="mt-auto text-xs leading-relaxed text-muted-foreground">
        {caption}
      </p>
    </li>
  );
}

function Connector() {
  return (
    <li
      aria-hidden="true"
      className="flex items-center justify-center text-muted-foreground [&>svg]:size-4"
    >
      <ArrowDown className="md:hidden" />
      <ArrowRight className="hidden md:block" />
    </li>
  );
}

/** A trust level or rule mark, as the policy text names it. */
function Mark({
  tone,
  struck = false,
  children,
}: {
  tone: "muted" | "warn";
  struck?: boolean;
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex rounded-full border px-2 py-0.5 font-mono text-xs",
        tone === "muted" && "text-muted-foreground",
        tone === "warn" &&
          "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300",
        struck && "line-through",
      )}
    >
      {children}
    </span>
  );
}

// === Tool slot

function ToolSlot({
  tool,
  placeholder,
  label,
  use,
  edit,
  exclude,
  onPick,
  highlight,
}: {
  tool: PickedTool | null;
  placeholder: string;
  label: string;
  use: ToolUse;
  edit?: RuleFlowEdit;
  exclude?: string;
  onPick?: (tool: PickedTool) => void;
  highlight: boolean;
}) {
  if (edit && onPick)
    return (
      <ToolPicker
        tool={tool}
        placeholder={placeholder}
        label={label}
        use={use}
        catalogs={edit.catalogs}
        exclude={exclude}
        onPick={onPick}
        highlight={highlight}
      />
    );

  return tool ? (
    <SelectedToolName name={tool.name} server={tool.server} />
  ) : (
    <span className="text-sm font-medium">{placeholder}</span>
  );
}

function ToolPicker({
  tool,
  placeholder,
  label,
  use,
  catalogs,
  exclude,
  onPick,
  highlight,
}: {
  tool: PickedTool | null;
  placeholder: string;
  label: string;
  use: ToolUse;
  catalogs: SetupCatalog[];
  exclude?: string;
  onPick: (tool: PickedTool) => void;
  highlight: boolean;
}) {
  // The hint or name guess can be wrong; reveal tools outside the suggested category.
  const [showAll, setShowAll] = useState(false);
  const [open, setOpen] = useState(false);
  const query = useAllCoverageToolsForCatalogs(
    catalogs.map((catalog) => catalog.id),
    { enabled: open },
  );
  const catalogNames = new Map(
    catalogs.map((catalog) => [catalog.id, catalog.name]),
  );
  // Selector rules add extra coverage rows for one tool. Prefer its base row.
  const rows = new Map<string, CoverageTool>();
  for (const row of query.tools) {
    const previous = rows.get(row.fullName);
    if (!previous || (previous.rule?.selector && !row.rule?.selector))
      rows.set(row.fullName, row);
  }
  const builtIns = [...rows.values()].filter(
    (row) => row.catalogId === ARCHESTRA_MCP_CATALOG_ID,
  );
  const suggested =
    use === "acts"
      ? [...SUGGESTED_BUILT_INS].flatMap(([name, reason]) => {
          const row = builtIns.find((candidate) => candidate.name === name);
          return row ? [{ row, reason }] : [];
        })
      : [];
  const suggestedNames = new Set(suggested.map(({ row }) => row.fullName));
  const visible = [...rows.values()].filter(
    (row) =>
      (row.catalogId !== ARCHESTRA_MCP_CATALOG_ID ||
        !UNCHECKED_BUILT_INS.has(row.name)) &&
      !suggestedNames.has(row.fullName) &&
      (showAll || toolReads(row) === (use === "reads")),
  );
  // A shape change can leave a picked tool outside the suggested category.
  // Keep its friendly name on the trigger until the user chooses another.
  const selected = tool && rows.get(tool.fullName);
  if (
    selected &&
    !visible.some((row) => row.fullName === selected.fullName) &&
    !suggestedNames.has(selected.fullName)
  )
    visible.unshift(selected);

  const option = (row: CoverageTool, reason?: string) => {
    const server = catalogNames.get(row.catalogId) ?? row.catalogName;
    const note =
      row.rule?.source === "battery"
        ? `Has a rule from the ${row.rule.battery} battery`
        : row.rule?.source === "root"
          ? "Already has a rule"
          : null;
    return {
      value: row.fullName,
      label: row.name,
      description: [
        reason ? `Suggested: ${reason}` : server,
        reason && server,
        note,
      ]
        .filter(Boolean)
        .join(" · "),
      searchText: [row.name, server, reason, note].filter(Boolean).join(" "),
      selectedContent: <SelectedToolName name={row.name} server={server} />,
      disabled: row.fullName === exclude,
    };
  };
  const options = [
    ...suggested.map(({ row, reason }) => option(row, reason)),
    ...visible.map((row) => option(row)),
  ];
  const selectedFallback =
    tool && !options.some((item) => item.value === tool.fullName)
      ? {
          value: tool.fullName,
          label: tool.name,
          description: tool.server,
          searchText: `${tool.name} ${tool.server}`,
          selectedContent: (
            <SelectedToolName name={tool.name} server={tool.server} />
          ),
          disabled: true,
        }
      : null;
  const copy = USE_COPY[use];

  return (
    <SearchableSelect
      value={tool?.fullName ?? ""}
      clearSearchOnClose
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setShowAll(false);
      }}
      onValueChange={(fullName) => {
        const row = rows.get(fullName);
        if (!row) return;
        onPick({
          toolId: row.toolId,
          fullName: row.fullName,
          rule:
            row.rule && row.rule.selector === null
              ? { source: row.rule.source }
              : null,
          name: row.name,
          server: catalogNames.get(row.catalogId) ?? row.catalogName,
          catalogId: row.catalogId,
        });
      }}
      ariaLabel={
        tool ? `${label}: ${tool.name}. Change` : `${label}: pick a tool`
      }
      placeholder={placeholder}
      searchPlaceholder={showAll ? "Search tools…" : copy.search}
      emptyMessage={
        query.isPending
          ? "Loading tools…"
          : query.isError
            ? "Could not load tools."
            : showAll
              ? "No tool matches."
              : copy.empty
      }
      items={options}
      pinnedItems={selectedFallback ? [selectedFallback] : undefined}
      className={cn(
        "h-auto min-h-12 w-full justify-between gap-2 px-3 py-2 active:scale-[0.99]",
        !tool && "border-dashed text-muted-foreground",
        highlight && "border-primary text-foreground",
      )}
      contentClassName="w-80"
      footer={
        query.isError ? (
          <Button variant="ghost" size="sm" onClick={query.refetch}>
            Retry loading tools
          </Button>
        ) : !showAll ? (
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-start font-normal text-muted-foreground"
            onClick={() => setShowAll(true)}
          >
            {copy.all}
          </Button>
        ) : null
      }
    />
  );
}

function SelectedToolName({ name, server }: { name: string; server: string }) {
  return (
    <span className="grid min-w-0 text-left">
      <span className="truncate text-xs font-normal text-muted-foreground">
        {server}
      </span>
      <span className="truncate font-mono text-sm font-medium">{name}</span>
    </span>
  );
}
