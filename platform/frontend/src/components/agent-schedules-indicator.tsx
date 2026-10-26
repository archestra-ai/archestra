"use client";

import { CalendarDays } from "lucide-react";
import { nextScheduleTime } from "@/components/scheduled-tasks/schedule-display.utils";
import { ScheduleLink } from "@/components/scheduled-tasks/schedule-link";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useAgentSchedules } from "@/lib/schedule-trigger.query";
import { cn } from "@/lib/utils/tailwind";

export function AgentScheduleIndicator({
  agentId,
  agentName,
}: {
  agentId: string;
  agentName: string;
}) {
  const { data: canRead } = useHasPermissions({ project: ["read"] });
  const query = useAgentSchedules(canRead ? agentId : null);
  const schedules = query.data?.pages.flatMap((page) => page.data) ?? [];
  if (schedules.length === 0) return null;

  const count = query.data?.pages[0]?.pagination.total ?? schedules.length;
  const activeCount = schedules.filter((schedule) => schedule.enabled).length;
  const pausedCount = schedules.length - activeCount;
  const summary = `${count} ${count === 1 ? "schedule" : "schedules"} for ${agentName}${query.hasNextPage ? "" : `, ${activeCount} active, ${pausedCount} paused`}`;
  const dotMeaning = activeCount
    ? "Green dot: at least one schedule is enabled."
    : "Gray dot: the listed schedules are paused.";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Badge
          asChild
          variant="outline"
          className="h-5 min-w-10 gap-1 px-1.5 py-0 text-xs text-muted-foreground hover:bg-accent hover:text-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground"
        >
          <UnstyledButton
            aria-label={`${summary}. View schedules`}
            title={`${summary}. ${dotMeaning}`}
            onClick={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
          >
            <span className="relative inline-flex size-3.5 shrink-0">
              <CalendarDays className="size-3.5" aria-hidden />
              <span
                className={cn(
                  "absolute bottom-0 right-0 size-1 rounded-full ring-1 ring-background",
                  activeCount
                    ? "bg-emerald-600 dark:bg-emerald-400"
                    : "bg-muted-foreground/70",
                )}
                aria-hidden
              />
            </span>
            <span className="tabular-nums">{count}</span>
          </UnstyledButton>
        </Badge>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        sideOffset={6}
        className="w-80 max-h-64 max-w-[calc(100vw-2rem)] overflow-y-auto p-1"
        onClick={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
      >
        {schedules.map((schedule) => (
          <DropdownMenuItem key={schedule.id} asChild>
            <ScheduleLink
              schedule={schedule}
              className="flex min-w-0 items-center justify-between gap-3 px-2 py-1.5 text-xs"
              title={`${schedule.name} · ${schedule.timezone}`}
            >
              <span className="min-w-0 flex-1 truncate text-xs">
                {schedule.name}
              </span>
              <span className="shrink-0 whitespace-nowrap text-xs text-muted-foreground tabular-nums">
                {schedule.enabled ? nextScheduleTime(schedule) : "Paused"}
              </span>
            </ScheduleLink>
          </DropdownMenuItem>
        ))}
        {query.hasNextPage && (
          <DropdownMenuItem
            disabled={query.isFetchingNextPage}
            onSelect={(event) => {
              event.preventDefault();
              void query.fetchNextPage();
            }}
          >
            <span className="text-xs">
              {query.isFetchingNextPage ? "Loading…" : "More schedules"}
            </span>
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
