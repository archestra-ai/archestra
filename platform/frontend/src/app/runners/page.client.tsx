"use client";

import { formatDistanceToNow } from "date-fns";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { useFeature } from "@/lib/config/config.query";
import { useRunners } from "@/lib/runners.query";
import { RunnerStateBadge } from "./_parts/runner-state-badge";

export function RunnersPageClient() {
  const runnersEnabled = useFeature("runners");
  const { data: runners, isLoading } = useRunners();

  // Three-state flag: render nothing while it is still loading, or the page
  // flashes a disabled notice at every reader on the way in.
  if (runnersEnabled === undefined) return null;
  if (!runnersEnabled) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-semibold">Runners</h1>
        <p className="text-muted-foreground mt-2 max-w-prose">
          Runners are not enabled on this deployment. They need
          ARCHESTRA_RUNNERS_ENABLED and a configured Kubernetes runtime.
        </p>
      </div>
    );
  }

  return (
    <div className="p-6 flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold">Runners</h1>
        <p className="text-muted-foreground mt-1 max-w-prose">
          Long-running agent sessions, each in its own container. Attach to one
          to watch it work, or send it a message to change what it is doing.
        </p>
      </div>

      {isLoading && <p className="text-muted-foreground">Loading...</p>}

      {!isLoading && (runners?.length ?? 0) === 0 && (
        <Card className="p-6 text-muted-foreground">
          No runners yet. An agent with runner configuration can start one — ask
          it to, or use the API.
        </Card>
      )}

      <div className="flex flex-col gap-2">
        {runners?.map((runner) => (
          <Link key={runner.id} href={`/runners/${runner.id}`}>
            <Card className="p-4 flex items-center justify-between hover:bg-accent/50 transition-colors">
              <div className="flex flex-col gap-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium truncate">{runner.name}</span>
                  <RunnerStateBadge
                    state={runner.state}
                    statusReason={runner.statusReason}
                  />
                </div>
                <span className="text-xs text-muted-foreground font-mono truncate">
                  {runner.image}
                </span>
              </div>
              <div className="flex items-center gap-3 flex-shrink-0">
                <Badge variant="outline" className="font-mono text-xs">
                  {formatDistanceToNow(new Date(runner.createdAt), {
                    addSuffix: true,
                  })}
                </Badge>
              </div>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
