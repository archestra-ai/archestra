"use client";

import {
  ARCHESTRA_MCP_CATALOG_ID,
  TOOL_ASK_USER_SHORT_NAME,
  TOOL_EXECUTE_REMEDY_PLAN_SHORT_NAME,
} from "@archestra/shared";
import {
  ArrowDown,
  ArrowRight,
  ChevronDown,
  FileInput,
  Hand,
  History,
  Plus,
  ShieldAlert,
  ShieldCheck,
  Users,
  Wrench,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  type CoverageTool,
  useAllCoverageTools,
} from "@/lib/openappa-coverage.query";
import { matchesSearchTokens } from "@/lib/search-tokens";
import { cn } from "@/lib/utils";
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
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  // Guessed from names, the split can be wrong; every tool stays one click away.
  const [showAll, setShowAll] = useState(false);
  const copy = USE_COPY[use];
  // Keyed by the pick so a new choice fades in rather than swapping text in place.
  const name = (
    <span
      key={tool?.fullName ?? "placeholder"}
      className="grid min-w-0 text-left motion-safe:animate-in motion-safe:fade-in motion-safe:duration-300"
    >
      {tool ? (
        <>
          <span className="truncate text-xs font-normal text-muted-foreground">
            {tool.server}
          </span>
          <span className="truncate font-mono text-sm font-medium">
            {tool.name}
          </span>
        </>
      ) : (
        <span className="text-sm font-medium">{placeholder}</span>
      )}
    </span>
  );

  if (!edit || !onPick) return name;
  const pick = (picked: PickedTool) => {
    onPick(picked);
    setOpen(false);
  };
  const suggest =
    use === "acts"
      ? edit.catalogs.find((catalog) => catalog.id === ARCHESTRA_MCP_CATALOG_ID)
      : undefined;

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setSearch("");
          setShowAll(false);
        }
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          aria-label={
            tool ? `${label}: ${tool.name}. Change` : `${label}: pick a tool`
          }
          className={cn(
            "h-auto min-h-12 w-full justify-between gap-2 px-3 py-2 active:scale-[0.99]",
            !tool && "border-dashed text-muted-foreground",
            highlight && "border-primary text-foreground",
          )}
        >
          {tool ? name : <span className="text-sm">{placeholder}</span>}
          {tool ? <ChevronDown /> : <Plus />}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-0" align="start">
        {/* Plain token matching: cmdk's fuzzy ranking puts loose matches
            from one server above an exact name from another. */}
        <Command shouldFilter={false}>
          <CommandInput
            placeholder={showAll ? "Search tools…" : copy.search}
            value={search}
            onValueChange={setSearch}
          />
          <CommandList>
            <CommandEmpty>
              {showAll ? "No tool matches." : copy.empty}
            </CommandEmpty>
            {suggest && (
              <SuggestedTools
                catalog={suggest}
                search={search}
                selected={tool?.fullName}
                exclude={exclude}
                onPick={pick}
              />
            )}
            {edit.catalogs.map((catalog) => (
              <CatalogTools
                key={catalog.id}
                catalog={catalog}
                search={search}
                use={showAll ? null : use}
                hide={catalog === suggest ? SUGGESTED_BUILT_INS : undefined}
                selected={tool?.fullName}
                exclude={exclude}
                onPick={pick}
              />
            ))}
          </CommandList>
          {!showAll && (
            <div className="border-t p-1">
              <Button
                variant="ghost"
                size="sm"
                className="w-full justify-start font-normal text-muted-foreground"
                onClick={() => setShowAll(true)}
              >
                {copy.all}
              </Button>
            </div>
          )}
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/** One catalog's tools in the picker, fetched by the group itself. */
function CatalogTools({
  catalog,
  search,
  use,
  hide,
  selected,
  exclude,
  onPick,
}: {
  catalog: SetupCatalog;
  search: string;
  /** Null lists every tool. */
  use: ToolUse | null;
  /** Short names listed elsewhere in the picker. */
  hide?: ReadonlyMap<string, string>;
  selected?: string;
  exclude?: string;
  onPick: (tool: PickedTool) => void;
}) {
  const tools = useAllCoverageTools(catalog.id);
  // Selector rules add extra rows for one tool; the picker lists each tool once.
  const rows = [
    ...new Map(
      (tools.data ?? [])
        .filter(
          (tool) =>
            (catalog.id !== ARCHESTRA_MCP_CATALOG_ID ||
              !UNCHECKED_BUILT_INS.has(tool.name)) &&
            !hide?.has(tool.name) &&
            (use === null || toolReads(tool) === (use === "reads")) &&
            matchesSearchTokens(search, [tool.name, catalog.name]),
        )
        .map((tool) => [tool.fullName, tool]),
    ).values(),
  ];
  if (rows.length === 0) return null;
  return (
    <CommandGroup heading={catalog.name}>
      {rows.map((tool) => (
        <ToolItem
          key={tool.fullName}
          tool={tool}
          catalog={catalog}
          selected={selected}
          exclude={exclude}
          onPick={onPick}
        />
      ))}
    </CommandGroup>
  );
}

/** The suggested built-in tools, in the order they are suggested. */
function SuggestedTools({
  catalog,
  search,
  selected,
  exclude,
  onPick,
}: {
  catalog: SetupCatalog;
  search: string;
  selected?: string;
  exclude?: string;
  onPick: (tool: PickedTool) => void;
}) {
  const tools = useAllCoverageTools(catalog.id);
  const rows = [...SUGGESTED_BUILT_INS].flatMap(([name, reason]) => {
    const tool = tools.data?.find(
      (row) => row.name === name && !row.rule?.selector,
    );
    return tool && matchesSearchTokens(search, [tool.name, reason])
      ? [{ tool, reason }]
      : [];
  });
  if (rows.length === 0) return null;
  return (
    <CommandGroup heading="Suggested">
      {rows.map(({ tool, reason }) => (
        <ToolItem
          key={tool.fullName}
          tool={tool}
          catalog={catalog}
          reason={reason}
          selected={selected}
          exclude={exclude}
          onPick={onPick}
        />
      ))}
    </CommandGroup>
  );
}

function ToolItem({
  tool,
  catalog,
  reason,
  selected,
  exclude,
  onPick,
}: {
  tool: CoverageTool;
  catalog: SetupCatalog;
  /** Why the tool is suggested. */
  reason?: string;
  selected?: string;
  exclude?: string;
  onPick: (tool: PickedTool) => void;
}) {
  const note =
    tool.rule?.source === "battery"
      ? `Has a rule from the ${tool.rule.battery} battery`
      : tool.rule?.source === "root"
        ? "Already has a rule"
        : null;
  return (
    <CommandItem
      value={tool.fullName}
      disabled={tool.fullName === exclude}
      data-checked={tool.fullName === selected}
      className="flex-col items-start gap-0.5 data-[checked=true]:font-medium"
      onSelect={() =>
        onPick({
          toolId: tool.toolId,
          fullName: tool.fullName,
          rule:
            tool.rule && tool.rule.selector === null
              ? { source: tool.rule.source }
              : null,
          name: tool.name,
          server: catalog.name,
          catalogId: catalog.id,
        })
      }
    >
      <span className="font-mono">{tool.name}</span>
      {(reason || note) && (
        <span className="text-xs text-muted-foreground">
          {/* Suggestions sit outside their server's group, so they name it. */}
          {[reason && catalog.name, reason, note].filter(Boolean).join(" · ")}
        </span>
      )}
    </CommandItem>
  );
}
