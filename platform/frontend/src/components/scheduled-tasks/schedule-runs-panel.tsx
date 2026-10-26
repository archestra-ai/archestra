"use client";
import { Loader2, Play } from "lucide-react";
import { useState } from "react";
import { QueryLoadError } from "@/components/query-load-error";
import { Button } from "@/components/ui/button";
import {
  useHasPermissions,
  useScopedCapabilities,
  useSession,
} from "@/lib/auth/auth.query";
import {
  type ScheduleTriggerRun,
  useInfiniteScheduleTriggerRuns,
  useScheduleTrigger,
  useScheduleTriggerRuns,
} from "@/lib/schedule-trigger.query";
import {
  type HistoryFilter,
  ScheduleExecutionHistory,
} from "./schedule-execution-history";
import { useStartScheduleRun } from "./use-start-schedule-run";

export function ScheduleRunsPanel({
  triggerId,
  currentRunId,
}: {
  triggerId: string;
  currentRunId?: string | null;
}) {
  const [filter, setFilter] = useState<HistoryFilter>("all");
  const trigger = useScheduleTrigger(triggerId);
  const history = useInfiniteScheduleTriggerRuns(
    triggerId,
    filter === "failed"
      ? { status: "failed" }
      : filter === "manual"
        ? { runKind: "manual" }
        : {},
  );
  const latest = useScheduleTriggerRuns(triggerId, { limit: 1 });
  const runNow = useStartScheduleRun(triggerId);
  const { data: session } = useSession();
  const { data: canCreate } = useHasPermissions({ project: ["create"] });
  const { data: grants } = useScopedCapabilities();
  const canRun =
    canCreate &&
    (trigger.data?.actorUserId === session?.user?.id ||
      grants?.some(
        (g) =>
          g.resource === "project" && g.scope === "*" && g.action === "use",
      ));
  const runs = Array.from(
    new Map(
      (history.data?.pages.flatMap((page) => page.data) ?? []).map((run) => [
        run.id,
        run,
      ]),
    ).values(),
  );
  if (trigger.isPending)
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2
          className="size-5 animate-spin"
          aria-label="Loading schedule"
        />
      </div>
    );
  if (trigger.isError || !trigger.data)
    return (
      <QueryLoadError
        title="Couldn’t load schedule"
        error={trigger.error}
        onRetry={() => void trigger.refetch()}
      />
    );
  const last: ScheduleTriggerRun | undefined = latest.data?.data[0];
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden p-3">
      <ScheduleExecutionHistory
        key={triggerId}
        schedule={trigger.data}
        runs={runs}
        filter={filter}
        onFilterChange={setFilter}
        currentRunId={currentRunId}
        lastRunAt={last?.startedAt ?? last?.createdAt}
        isLoading={history.isPending}
        isError={history.isLoadingError}
        error={history.error}
        moreError={history.isFetchNextPageError}
        loadingMore={history.isFetchingNextPage}
        hasNextPage={history.hasNextPage}
        totalRuns={history.data?.pages[0]?.pagination.total ?? 0}
        onLoadMore={() => {
          if (history.hasNextPage && !history.isFetching)
            void history.fetchNextPage();
        }}
        onRetry={() => void history.refetch()}
        actions={
          canRun && (
            <Button
              size="icon-xs"
              variant="ghost"
              title="Start new run"
              aria-label="Start new run"
              disabled={runNow.isPending}
              onClick={runNow.start}
            >
              {runNow.isPending ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Play className="size-3.5" />
              )}
            </Button>
          )
        }
      />
    </div>
  );
}

export function MobileScheduleRuns({
  triggerId,
  currentRunId,
  onClose,
}: {
  triggerId: string;
  currentRunId: string | null;
  onClose: () => void;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b px-3 py-2">
        <Button size="xs" variant="ghost" onClick={onClose}>
          Back to conversation
        </Button>
      </div>
      <ScheduleRunsPanel triggerId={triggerId} currentRunId={currentRunId} />
    </div>
  );
}
