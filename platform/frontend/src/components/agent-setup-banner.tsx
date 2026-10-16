"use client";

import { Check, Github, KeyRound, Lock, Play, X } from "lucide-react";
import {
  type ReactNode,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from "react";
import { CatalogAgentIcon } from "@/components/agent-pages/agent-catalog";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import { cn } from "@/lib/utils/tailwind";

export interface AgentSetupItem {
  id: string;
  label: string;
  /** Extra context shown on hover, or inline when there is no action. */
  description?: string;
  status: "now" | "done";
  action?: ReactNode;
}

/**
 * What a saved agent still needs before it can run: a segmented track (one
 * segment per requirement, ending at Run) over a compact grid of
 * requirements, each with the one action that settles it. Rows resolved while
 * the page is open stay, ticked, so the reader sees progress rather than rows
 * vanishing under them. Two grid rows show at most; the rest sit behind
 * "Show N more".
 */
export function AgentSetupBanner({
  items,
  showReady = false,
  resetKey,
}: {
  items: AgentSetupItem[];
  showReady?: boolean;
  resetKey?: string;
}) {
  const [dismissed, setDismissed] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [history, setHistory] = useState({
    resetKey,
    seen: items.map(({ id, label, description }) => ({
      id,
      label,
      description,
    })),
  });
  const seen = history.resetKey === resetKey ? history.seen : [];
  const nextSeen = [
    ...seen.map((previous) => {
      const current = items.find(({ id }) => id === previous.id);
      return current
        ? {
            id: current.id,
            label: current.label,
            description: current.description,
          }
        : previous;
    }),
    ...items
      .filter(({ id }) => !seen.some((previous) => previous.id === id))
      .map(({ id, label, description }) => ({ id, label, description })),
  ];
  if (
    history.resetKey !== resetKey ||
    JSON.stringify(nextSeen) !== JSON.stringify(history.seen)
  ) {
    setHistory({ resetKey, seen: nextSeen });
  }
  const visibleItems: AgentSetupItem[] = nextSeen.map(
    (previous) =>
      items.find(({ id }) => id === previous.id) ?? {
        ...previous,
        status: "done",
      },
  );
  const doneCount = visibleItems.filter(
    ({ status }) => status === "done",
  ).length;
  const needsAction = doneCount < visibleItems.length;
  const gridRef = useRef<HTMLUListElement>(null);
  const columns = useGridColumns(gridRef, needsAction);

  if (!visibleItems.length && !showReady) return null;
  // Outstanding work is the reason the section exists, so only the settled
  // state can be dismissed.
  if (!needsAction && dismissed) return null;

  if (!needsAction) {
    return (
      <output
        aria-live="polite"
        aria-label="Agent setup"
        className="flex items-center gap-2 text-sm"
      >
        <span className="inline-flex size-4 items-center justify-center rounded-full bg-foreground text-background">
          <Check className="size-2.5" strokeWidth={3} aria-hidden />
        </span>
        <span className="font-medium">Ready to run</span>
        {visibleItems.length > 0 && (
          <ul className="sr-only">
            {visibleItems.map((item) => (
              <li key={item.id}>
                <span>{item.label}</span> <span>Done</span>
              </li>
            ))}
          </ul>
        )}
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="ml-auto"
          onClick={() => setDismissed(true)}
          aria-label="Dismiss"
        >
          <X />
        </Button>
      </output>
    );
  }

  // Open work first (actionable, then held by someone else), settled last.
  const ordered = [
    ...visibleItems.filter((item) => item.status !== "done" && item.action),
    ...visibleItems.filter((item) => item.status !== "done" && !item.action),
    ...visibleItems.filter((item) => item.status === "done"),
  ];
  const cap = Math.max(columns * 2, 3);
  const collapsed = !expanded && ordered.length > cap;
  const shown = collapsed ? ordered.slice(0, cap - 1) : ordered;

  return (
    <output
      aria-live="polite"
      aria-label="Agent setup"
      className="block space-y-2"
    >
      <div className="flex items-center gap-3">
        <p className="shrink-0 text-xs font-medium text-muted-foreground">
          <span>Before it runs</span>
          <span className="ml-1.5 tabular-nums text-foreground">
            {`${doneCount}/${visibleItems.length}`}
          </span>
        </p>
        <div
          role="progressbar"
          aria-label="Setup done"
          aria-valuemin={0}
          aria-valuemax={visibleItems.length}
          aria-valuenow={doneCount}
          className="flex h-1 min-w-0 flex-1 items-center gap-0.5"
        >
          {ordered.map((item, index) => (
            <span
              key={item.id}
              className={cn(
                "h-full flex-1 rounded-full transition-colors",
                index < doneCount ? "bg-foreground/70" : "bg-muted",
              )}
            />
          ))}
        </div>
        <span
          aria-hidden
          className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground"
        >
          <span className="inline-flex size-4 items-center justify-center rounded-full border border-dashed border-muted-foreground/50">
            <Play className="size-2 translate-x-px" strokeWidth={2.5} />
          </span>
          <span>Run</span>
        </span>
      </div>

      <ul
        ref={gridRef}
        className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-x-5 gap-y-1"
      >
        {shown.map((item) => (
          <SetupEntry key={item.id} item={item} />
        ))}
        {ordered.length > cap && (
          <li className="flex h-8 items-center">
            <UnstyledButton
              onClick={() => setExpanded((value) => !value)}
              className="rounded-sm text-xs font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              {expanded ? (
                <span>Show less</span>
              ) : (
                <span>{`Show ${ordered.length - shown.length} more`}</span>
              )}
            </UnstyledButton>
          </li>
        )}
      </ul>
    </output>
  );
}

// ===

function SetupEntry({ item }: { item: AgentSetupItem }) {
  const isDone = item.status === "done";
  const kind = kindOf(item);
  // Nothing to click, so the reason is the content: it reads inline, across
  // the grid, instead of behind a hover.
  const explainInline = !isDone && !item.action && !!item.description;

  return (
    <li
      className={cn(
        "flex min-w-0 gap-2",
        explainInline ? "col-span-full items-start py-1.5" : "h-8 items-center",
      )}
    >
      <span
        className={cn(
          "relative inline-flex size-6 shrink-0 items-center justify-center rounded-md",
          isDone
            ? BRAND_FILL[kind]
            : "border border-dashed border-muted-foreground/40 bg-background",
        )}
      >
        <BrandMark item={item} kind={kind} filled={isDone} />
        {isDone && (
          <span className="absolute -right-1 -bottom-1 inline-flex size-3 items-center justify-center rounded-full bg-primary text-primary-foreground ring-[1.5px] ring-background">
            <Check className="size-2" strokeWidth={3.5} aria-hidden />
          </span>
        )}
      </span>

      {explainInline ? (
        <div className="min-w-0 text-sm">
          <p className="font-medium">{item.label}</p>
          <p className="text-muted-foreground">{item.description}</p>
        </div>
      ) : (
        <SetupLabel item={item} isDone={isDone} />
      )}

      {!isDone && item.action && (
        <span className="ml-auto flex shrink-0 [&_[data-slot=button]]:h-7 [&_[data-slot=button]]:gap-1 [&_[data-slot=button]]:px-2.5 [&_[data-slot=button]]:text-xs [&_[data-slot=button]_svg]:size-3.5">
          {item.action}
        </span>
      )}
    </li>
  );
}

function SetupLabel({
  item,
  isDone,
}: {
  item: AgentSetupItem;
  isDone: boolean;
}) {
  const className = cn(
    "min-w-0 truncate text-sm",
    isDone ? "text-muted-foreground" : "font-medium",
  );
  const status = isDone && <span className="sr-only"> Done</span>;

  if (isDone || !item.description) {
    return (
      <span className={className}>
        <span>{item.label}</span>
        {status}
      </span>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <UnstyledButton
          aria-label={`About ${item.label}`}
          className={cn(
            className,
            "cursor-help rounded-sm text-left focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
          )}
        >
          {item.label}
        </UnstyledButton>
      </TooltipTrigger>
      <TooltipContent side="top" align="start" className="max-w-72">
        {item.description}
      </TooltipContent>
    </Tooltip>
  );
}

function BrandMark({
  item,
  kind,
  filled,
}: {
  item: AgentSetupItem;
  kind: Kind;
  filled: boolean;
}) {
  if (kind === "claude") {
    return (
      <span className={cn("inline-flex", !filled && "opacity-80")} aria-hidden>
        <CatalogAgentIcon id="claude-code" size={13} />
      </span>
    );
  }
  // A lock marks a requirement this person cannot settle themselves.
  const Icon =
    kind === "github" ? Github : item.action || filled ? KeyRound : Lock;
  return (
    <Icon
      aria-hidden
      strokeWidth={1.75}
      className={cn("size-[13px]", !filled && "text-foreground/70")}
    />
  );
}

/** Columns the auto-fill grid lays out now, so "two rows" stays exact. */
function useGridColumns(
  ref: RefObject<HTMLUListElement | null>,
  active: boolean,
) {
  const [columns, setColumns] = useState(3);
  useEffect(() => {
    const element = ref.current;
    if (!active || !element || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const count = getComputedStyle(element)
        .gridTemplateColumns.split(" ")
        .filter(Boolean).length;
      if (count > 0) setColumns(count);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, active]);
  return columns;
}

type Kind = "claude" | "github" | "other";

function kindOf(item: AgentSetupItem): Kind {
  const key = `${item.id} ${item.label}`;
  if (/CLAUDE_CODE_ACCOUNT|claude/i.test(key)) return "claude";
  if (/github/i.test(key)) return "github";
  return "other";
}

// A settled requirement fills with its provider's own colour: Claude's clay,
// GitHub's ink, the brand colour for anything else.
const BRAND_FILL: Record<Kind, string> = {
  claude: "bg-[#D97757]",
  github: "bg-foreground text-background",
  other: "bg-primary text-primary-foreground",
};
