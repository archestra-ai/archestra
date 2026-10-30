"use client";
import { formatDistanceToNow } from "date-fns";
import {
  ChevronLeft,
  ChevronRight,
  Search,
  TerminalSquare,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState, useSyncExternalStore } from "react";
import {
  AgentRunList,
  initiatorLabel,
  starterKey,
} from "@/components/agent-pages/agent-run-list";
import { AgentRunChatSession } from "@/components/agent-run-session";
import { AgentRunState } from "@/components/agent-run-state";
import { EmptyState } from "@/components/empty-state";
import { QueryLoadError } from "@/components/query-load-error";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import { type AgentRunListItem, useAgentRuns } from "@/lib/agent-runtime.query";
import { useSession } from "@/lib/auth/auth.query";

/**
 * An Agent's Runs tab: the list of its runs, or the one named by `?run=`.
 * The run lives in the URL so the browser's Back returns to the list.
 */
export function AgentRuns({ agentId }: { agentId: string }) {
  const { data: session } = useSession();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const {
    data: runs = [],
    isPending,
    isError,
    error,
    refetch,
  } = useAgentRuns(agentId);
  const runHref = (taskId: string | null) => {
    const params = new URLSearchParams(searchParams.toString());
    if (taskId) params.set("run", taskId);
    else params.delete("run");
    return `${pathname}?${params}`;
  };
  if (isPending)
    return <div className="h-48 animate-pulse rounded-lg border bg-muted/30" />;
  if (isError)
    return (
      <QueryLoadError
        className="border"
        title="Couldn't load runs"
        error={error}
        onRetry={() => refetch()}
      />
    );
  if (!runs.length)
    return (
      <EmptyState
        icon={TerminalSquare}
        title="No runs yet"
        description={
          <span>
            Start a run from{" "}
            <Link
              href={`/chat/new?agent_id=${encodeURIComponent(agentId)}`}
              className="underline underline-offset-4"
            >
              Chat
            </Link>
            .
          </span>
        }
      />
    );
  // A run that is gone (deleted, or not this Agent's) falls back to the list.
  const selected = runs.find((run) => run.taskId === searchParams.get("run"));
  if (!selected)
    return (
      <AgentRunList
        runs={runs}
        viewerId={session?.user.id}
        runHref={runHref}
        onOpen={(taskId) => router.push(runHref(taskId), { scroll: false })}
      />
    );
  return (
    <AgentRunDetail
      runs={runs}
      selected={selected}
      viewerId={session?.user.id}
      // Stepping between runs replaces the entry, so Back still means the list.
      onSelect={(taskId) => router.replace(runHref(taskId), { scroll: false })}
      onBack={() => router.push(runHref(null), { scroll: false })}
      // A deleted run's entry is replaced, so Back cannot return to it.
      onDeleted={() => router.replace(runHref(null), { scroll: false })}
    />
  );
}

function AgentRunDetail({
  runs,
  selected,
  viewerId,
  onSelect,
  onBack,
  onDeleted,
}: {
  runs: AgentRunListItem[];
  selected: AgentRunListItem;
  viewerId: string | undefined;
  onSelect: (taskId: string) => void;
  onBack: () => void;
  onDeleted: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [starter, setStarter] = useState("anyone");
  const [highlighted, setHighlighted] = useState(0);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (
        (event.metaKey || event.ctrlKey) &&
        event.key.toLowerCase() === "k" &&
        event.shiftKey &&
        !event.altKey &&
        !(
          event.target instanceof HTMLElement &&
          event.target.closest("input,textarea,[contenteditable=true]")
        )
      ) {
        event.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const index = runs.findIndex((run) => run.taskId === selected.taskId);
  const filtered = runs.filter(
    (run) =>
      (starter === "anyone" || starterKey(run) === starter) &&
      `${run.title} ${run.taskId} ${initiatorLabel(run)}`
        .toLowerCase()
        .includes(search.trim().toLowerCase()),
  );
  const starters = Array.from(
    new Map(
      runs.map((run) => [starterKey(run), initiatorLabel(run)]),
    ).entries(),
  );
  const choose = (id: string) => {
    onSelect(id);
    setOpen(false);
  };
  return (
    <div className="flex h-[calc(100dvh-16rem)] min-h-[520px] min-w-0 flex-col overflow-hidden rounded-xl border bg-card/30">
      <AgentRunChatSession
        key={selected.taskId}
        detailsOpen={detailsOpen}
        onDetailsOpenChange={setDetailsOpen}
        taskId={selected.taskId}
        embedded
        onDeleted={onDeleted}
        initiatorName={
          selected.actorUserId === viewerId ? "You" : initiatorLabel(selected)
        }
        headerLeading={
          <div className="flex w-full items-center gap-1.5 @3xl:w-auto">
            <Button variant="ghost" size="sm" onClick={onBack}>
              <ChevronLeft />
              <span>All runs</span>
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="min-w-0 justify-start @md:flex-1 @3xl:flex-none"
              aria-label="Switch run"
              onClick={() => setOpen(true)}
            >
              <Search />
              {/* Beside "All runs" a phone has room for the icon only. */}
              <span className="@max-md:sr-only">Switch run</span>
              <RunSwitcherShortcut />
            </Button>
          </div>
        }
        drawerFooter={
          <div className="flex items-center justify-between">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Previous run"
              disabled={index === 0}
              onClick={() => onSelect(runs[index - 1].taskId)}
            >
              <ChevronLeft />
            </Button>
            <span className="text-xs text-muted-foreground">
              {index + 1} of {runs.length}
            </span>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Next run"
              disabled={index === runs.length - 1}
              onClick={() => onSelect(runs[index + 1].taskId)}
            >
              <ChevronRight />
            </Button>
          </div>
        }
      />
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Switch run</DialogTitle>
            <DialogDescription>
              Find a run by title, ID, or who started it.
            </DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-1 gap-2 border-b p-3 sm:grid-cols-[minmax(0,1fr)_11rem]">
            <Input
              autoFocus
              aria-label="Search all runs"
              placeholder="Search all runs…"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setHighlighted(0);
              }}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  setHighlighted((v) =>
                    Math.max(0, Math.min(filtered.length - 1, v + 1)),
                  );
                }
                if (event.key === "ArrowUp") {
                  event.preventDefault();
                  setHighlighted((v) => Math.max(0, v - 1));
                }
                if (event.key === "Enter" && filtered[highlighted])
                  choose(filtered[highlighted].taskId);
              }}
            />
            <Select
              value={starter}
              onValueChange={(value) => {
                setStarter(value);
                setHighlighted(0);
              }}
            >
              <SelectTrigger className="w-full" aria-label="Started by">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="anyone">Started by anyone</SelectItem>
                {starters.map(([id, name]) => (
                  <SelectItem key={id} value={id}>
                    {id === `user:${viewerId}` ? "Started by me" : name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="max-h-80 overflow-y-auto p-2">
            {filtered.map((run, i) => (
              <UnstyledButton
                key={run.taskId}
                onClick={() => choose(run.taskId)}
                className={`mb-1 flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left hover:bg-muted ${i === highlighted ? "bg-muted" : ""}`}
              >
                <TerminalSquare className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">
                    {run.title}
                  </span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    {run.actorUserId === viewerId ? "You" : initiatorLabel(run)}{" "}
                    ·{" "}
                    {formatDistanceToNow(new Date(run.startedAt), {
                      addSuffix: true,
                    })}
                  </span>
                </span>
                <AgentRunState state={run.state} compact />
              </UnstyledButton>
            ))}
            {!filtered.length && (
              <p className="p-4 text-sm text-muted-foreground">
                No matching runs.
              </p>
            )}
          </div>
          <div className="border-t px-4 py-2 text-xs text-muted-foreground">
            {filtered.length} matching {filtered.length === 1 ? "run" : "runs"}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function RunSwitcherShortcut() {
  const modifier = useSyncExternalStore(
    subscribeToPlatform,
    () =>
      navigator.platform.toUpperCase().includes("MAC") ? "⇧⌘" : "Ctrl+Shift+",
    () => null,
  );
  return modifier ? (
    <kbd className="hidden rounded border px-1 text-[10px] lg:inline">
      {modifier}K
    </kbd>
  ) : null;
}
function subscribeToPlatform() {
  return () => {};
}
