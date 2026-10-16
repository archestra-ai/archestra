"use client";

import { formatDistanceToNow } from "date-fns";
import { Info, Search, Share2, TerminalSquare } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { AgentRunLiveness } from "@/components/agent-run-liveness";
import { AgentRunLogs } from "@/components/agent-run-logs";
import { AgentRunState } from "@/components/agent-run-state";
import { AgentRunTerminal } from "@/components/agent-run-terminal";
import { ShareAgentRunDialog } from "@/components/chat/share-agent-run-dialog";
import { EmptyState } from "@/components/empty-state";
import { QueryLoadError } from "@/components/query-load-error";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { type AgentRunListItem, useAgentRuns } from "@/lib/agent-runtime.query";
import { useScopedCapabilities, useSession } from "@/lib/auth/auth.query";
import { cn } from "@/lib/utils/tailwind";

export function AgentRuns({ agentId }: { agentId: string }) {
  const { data: session } = useSession();
  const {
    data: runs = [],
    isPending,
    isError,
    error,
    refetch,
  } = useAgentRuns(agentId);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [starter, setStarter] = useState(ANYONE);
  const userId = session?.user.id;
  // Everyone who started a run here, so the filter offers only real choices.
  const starters = useMemo(() => {
    const names = new Map<string, string>();
    for (const run of runs) {
      const key = starterKey(run);
      if (key !== userId && !names.has(key)) {
        names.set(key, initiatorLabel(run));
      }
    }
    return [...names].sort(([, a], [, b]) => a.localeCompare(b));
  }, [runs, userId]);
  const query = search.trim().toLowerCase();
  const visibleRuns = runs.filter(
    (run) =>
      (starter === ANYONE ||
        starterKey(run) === (starter === ME ? userId : starter)) &&
      (!query ||
        run.title.toLowerCase().includes(query) ||
        run.taskId.startsWith(query) ||
        initiatorLabel(run).toLowerCase().includes(query)),
  );
  const filtered = visibleRuns.length !== runs.length;
  const selected =
    visibleRuns.find((run) => run.taskId === selectedTaskId) ?? visibleRuns[0];
  const runCount = filtered
    ? `${visibleRuns.length} of ${runs.length}`
    : `${runs.length} run${runs.length === 1 ? "" : "s"}`;

  if (isPending) {
    return <div className="h-48 animate-pulse rounded-lg border bg-muted/30" />;
  }
  if (isError) {
    return (
      <QueryLoadError
        className="border"
        title="Couldn't load runs"
        error={error}
        onRetry={() => refetch()}
      />
    );
  }
  if (runs.length === 0) {
    return (
      <EmptyState
        icon={TerminalSquare}
        title="No runs yet"
        description={
          <>
            Start a run from{" "}
            <Link
              href={`/chat/new?agent_id=${encodeURIComponent(agentId)}`}
              className="underline underline-offset-4 hover:text-foreground"
            >
              Chat
            </Link>
            .
          </>
        }
      />
    );
  }

  return (
    <div className="grid min-h-[520px] grid-cols-1 overflow-hidden rounded-xl border bg-card/30 lg:h-[calc(100dvh-16rem)] lg:grid-cols-[15.5rem_minmax(0,1fr)]">
      <aside className="flex min-h-0 flex-col border-b bg-muted/10 lg:border-b-0 lg:border-r">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <h2 className="text-sm font-medium">History</h2>
          <span className="text-xs tabular-nums text-muted-foreground">
            {runCount}
          </span>
        </div>
        <div className="flex flex-col gap-2 border-b p-2">
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search runs"
              aria-label="Search runs"
              className="h-8 pl-8 text-sm"
            />
          </div>
          <Select value={starter} onValueChange={setStarter}>
            <SelectTrigger size="sm" className="w-full" aria-label="Started by">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANYONE}>Started by anyone</SelectItem>
              <SelectItem value={ME}>Started by me</SelectItem>
              {starters.map(([key, name]) => (
                <SelectItem key={key} value={key}>
                  {name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <ScrollArea className="min-h-0 flex-1">
          <div className="space-y-0.5 p-2">
            {visibleRuns.length === 0 && (
              <p className="px-3 py-6 text-center text-xs text-muted-foreground">
                No runs match these filters.
              </p>
            )}
            {visibleRuns.map((run) => {
              const isSelected = run.taskId === selected?.taskId;
              return (
                <Button
                  key={run.id}
                  type="button"
                  variant="ghost"
                  className={cn(
                    "h-auto w-full min-w-0 justify-start overflow-hidden rounded-lg px-3 py-2.5 text-left hover:bg-muted/70",
                    isSelected &&
                      "bg-muted text-foreground ring-1 ring-inset ring-border hover:bg-muted",
                  )}
                  onClick={() => setSelectedTaskId(run.taskId)}
                >
                  <span className="flex min-w-0 flex-1 flex-col gap-1 overflow-hidden">
                    <span className="grid min-w-0 grid-cols-[minmax(0,1fr)_1.25rem] items-center gap-1.5">
                      <span
                        className="truncate text-sm font-medium"
                        title={run.title}
                      >
                        {run.title}
                      </span>
                      <AgentRunState
                        state={run.state}
                        attentionState={run.attentionState}
                        lastModelActivityAt={run.lastModelActivityAt}
                        startedAt={run.startedAt}
                        endedAt={run.endedAt}
                        hardDeadlineAt={run.hardDeadlineAt}
                        compact
                        iconOnly
                      />
                    </span>
                    <span className="flex min-w-0 items-center gap-1.5 text-[11px] font-normal text-muted-foreground">
                      <span className="min-w-0 truncate">
                        {starterKey(run) === userId
                          ? "You"
                          : initiatorLabel(run)}
                      </span>
                      <span aria-hidden>·</span>
                      <span className="shrink-0">
                        {formatDistanceToNow(new Date(run.startedAt), {
                          addSuffix: true,
                        })}
                      </span>
                    </span>
                  </span>
                </Button>
              );
            })}
          </div>
        </ScrollArea>
      </aside>

      {selected && (
        <RunDetails
          key={selected.taskId}
          run={selected}
          canAttach={selected.actorUserId === session?.user.id}
          onClosed={() => void refetch()}
        />
      )}
    </div>
  );
}

function RunDetails({
  run,
  canAttach,
  onClosed,
}: {
  run: AgentRunListItem;
  canAttach: boolean;
  onClosed: () => void;
}) {
  const active = !run.endedAt;
  const startedBy = `Started by ${initiatorLabel(run)}${canAttach ? " (you)" : ""}`;
  const [permissionsOpen, setPermissionsOpen] = useState(false);
  const capabilities = useScopedCapabilities();
  const canManageAccess =
    canAttach ||
    capabilities.data?.some(
      (grant) =>
        grant.resource === "agentRun" &&
        grant.action === "manage-permissions" &&
        (grant.scope === run.taskId || grant.scope === "*"),
    );

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex flex-shrink-0 items-start justify-between gap-4 border-b px-5 py-3.5">
        <div className="min-w-0 space-y-1">
          <div className="flex min-w-0 items-center gap-2">
            <h2 className="truncate text-sm font-medium">{run.title}</h2>
            <AgentRunState
              state={run.state}
              attentionState={run.attentionState}
              statusReason={run.statusReason}
              lastModelActivityAt={run.lastModelActivityAt}
              startedAt={run.startedAt}
              endedAt={run.endedAt}
              hardDeadlineAt={run.hardDeadlineAt}
              compact
            />
          </div>
          {/* One line of facts: who, when, which run, and who else can read it. */}
          <div className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
            <span className="min-w-0 break-words">{startedBy}</span>
            <span aria-hidden>·</span>
            <time dateTime={run.startedAt}>
              {new Date(run.startedAt).toLocaleString(undefined, {
                dateStyle: "medium",
                timeStyle: "short",
              })}
            </time>
            <span aria-hidden>·</span>
            <span className="font-mono">{shortTaskId(run.taskId)}</span>
            {run.projectId && (
              <>
                <span aria-hidden>·</span>
                <span>+ project access</span>
              </>
            )}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="size-5 text-muted-foreground"
                  aria-label="Who can access this run?"
                >
                  <Info className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs">
                <p>
                  The run owner and Agent administrators can read output.
                  Sharing grants others read-only access. Only the run owner can
                  use the live terminal.
                </p>
                {run.projectId && (
                  <p className="mt-1">
                    People with access to its project and permission to read all
                    project sessions can also read this run.
                  </p>
                )}
              </TooltipContent>
            </Tooltip>
          </div>
        </div>
        {canManageAccess && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="shrink-0"
            onClick={() => setPermissionsOpen(true)}
          >
            <Share2 className="size-4" />
            Share
          </Button>
        )}
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
        {active && !canAttach && <AgentRunLiveness run={run} />}
        {active && canAttach ? (
          <AgentRunTerminal
            taskId={run.taskId}
            active
            title=""
            // The run's status shares the terminal's toolbar row.
            toolbarStart={<AgentRunLiveness run={run} />}
            showDisconnectedStatus={false}
            onError={onClosed}
            onClosed={onClosed}
          />
        ) : (
          <AgentRunLogs run={run} title="" />
        )}
      </div>
      <ShareAgentRunDialog
        taskId={run.taskId}
        open={permissionsOpen}
        onOpenChange={setPermissionsOpen}
      />
    </section>
  );
}

const ANYONE = "__anyone";
const ME = "__me";

/** Groups runs by who started them: the user, else the kind of actor. */
function starterKey(run: AgentRunListItem): string {
  return run.actorUserId ?? `kind:${run.actorKind}`;
}

function shortTaskId(taskId: string): string {
  return taskId.slice(0, 8);
}

function initiatorLabel(run: AgentRunListItem): string {
  if (run.initiatorName) return run.initiatorName;
  if (run.actorKind === "organization") return "the organization";
  if (run.actorKind === "team") return "a team";
  if (run.actorKind === "system") return "automation";
  return "an unknown user";
}
