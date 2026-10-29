"use client";
import { formatDistanceToNow } from "date-fns";
import {
  ChevronLeft,
  ChevronRight,
  Search,
  TerminalSquare,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useState, useSyncExternalStore } from "react";
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

export function AgentRuns({ agentId }: { agentId: string }) {
  const { data: session } = useSession();
  const {
    data: runs = [],
    isPending,
    isError,
    error,
    refetch,
  } = useAgentRuns(agentId);
  const [selectedId, setSelectedId] = useState<string | null>(null);
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
  const selected = runs.find((run) => run.taskId === selectedId) ?? runs[0];
  const index = runs.findIndex((run) => run.taskId === selected?.taskId);
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
    setSelectedId(id);
    setOpen(false);
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
  if (!selected)
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
  return (
    <div className="flex h-[calc(100dvh-16rem)] min-h-[520px] min-w-0 flex-col overflow-hidden rounded-xl border bg-card/30">
      <AgentRunChatSession
        key={selected.taskId}
        detailsOpen={detailsOpen}
        onDetailsOpenChange={setDetailsOpen}
        taskId={selected.taskId}
        embedded
        initiatorName={
          selected.actorUserId === session?.user.id
            ? "You"
            : initiatorLabel(selected)
        }
        headerLeading={
          <Button
            variant="outline"
            size="sm"
            className="w-full justify-start @3xl:w-auto"
            aria-label="Switch run"
            onClick={() => setOpen(true)}
          >
            <Search />
            <span>Switch run</span>
            <RunSwitcherShortcut />
          </Button>
        }
        drawerFooter={
          <div className="flex items-center justify-between">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Previous run"
              disabled={index === 0}
              onClick={() => setSelectedId(runs[index - 1].taskId)}
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
              onClick={() => setSelectedId(runs[index + 1].taskId)}
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
                    {id === `user:${session?.user.id}` ? "Started by me" : name}
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
                    {run.actorUserId === session?.user.id
                      ? "You"
                      : initiatorLabel(run)}{" "}
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

function starterKey(run: AgentRunListItem): string {
  return `${run.actorKind}:${run.actorId}`;
}
function initiatorLabel(run: AgentRunListItem): string {
  if (run.initiatorName) return run.initiatorName;
  if (run.actorKind === "serviceAccount") return "a service account";
  if (run.actorKind === "organization") return "the organization";
  if (run.actorKind === "team") return "a team";
  if (run.actorKind === "system") return "automation";
  return "an unknown user";
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
