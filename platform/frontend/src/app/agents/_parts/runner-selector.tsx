"use client";

import { Container, ExternalLink } from "lucide-react";
import Link from "next/link";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useFeature } from "@/lib/config/config.query";
import { useRunners } from "@/lib/runners.query";

const NO_RUNNER = "__none__";

/**
 * Which runner this agent's long-running work executes on.
 *
 * The association is optional and one-way: an agent without one simply has no
 * long-running mode, and the runner itself carries the image, credentials and
 * environment — so pointing several agents at the same runner is the norm
 * rather than a special case.
 */
export function RunnerSelector({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (runnerId: string | null) => void;
}) {
  const runnersEnabled = useFeature("runners");
  const { data } = useRunners({ limit: 100 });

  if (runnersEnabled !== true) return null;

  const runners = data?.runners ?? [];

  return (
    <div className="space-y-2">
      <Label htmlFor="agent-runner">Runner</Label>
      {runners.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No runners defined yet.{" "}
          <Link
            href="/agents/runners"
            className="inline-flex items-center gap-1 underline"
          >
            Create one
            <ExternalLink className="h-3 w-3" />
          </Link>{" "}
          to give this agent a container to do long-running work in.
        </p>
      ) : (
        <>
          <Select
            value={value ?? NO_RUNNER}
            onValueChange={(next) => onChange(next === NO_RUNNER ? null : next)}
          >
            <SelectTrigger id="agent-runner">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_RUNNER}>No runner</SelectItem>
              {runners.map((runner) => (
                <SelectItem key={runner.id} value={runner.id}>
                  <span className="flex items-center gap-2">
                    <Container className="h-4 w-4 text-muted-foreground" />
                    <span>{runner.name}</span>
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            Long-running tasks for this agent start a session on this runner.
            Without one, the agent still answers normally but has no
            long-running mode.
          </p>
        </>
      )}
    </div>
  );
}
