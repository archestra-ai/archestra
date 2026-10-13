"use client";

import { ArrowRight, Info } from "lucide-react";
import { Fragment, type ReactNode } from "react";
import { QueryLoadError } from "@/components/query-load-error";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import { useTrustAudience } from "@/lib/openappa-trust-audience.query";
import { cn } from "@/lib/utils/tailwind";
import { StepCard } from "./step-card";

/**
 * Step one of "How your policy decides": the trust levels and audiences a
 * session's label moves through as it reads data, each in the order it falls.
 */
export function LabelCard() {
  const view = useTrustAudience();
  const audiences = view.data?.audiences ?? [];

  return (
    <StepCard
      step={1}
      title="Data sets the label"
      description="Reading data can only lower trust or narrow who may see the result. It never goes back up on its own."
    >
      {view.isLoadingError ? (
        <QueryLoadError
          title="Could not load trust and audience"
          onRetry={() => view.refetch()}
        />
      ) : !view.data ? (
        <Skeleton className="h-28 w-full" />
      ) : (
        <dl className="space-y-4">
          <div className="space-y-2">
            <Term hint="Text written by an outsider, such as a web page, lowers it, and it never rises again in the session.">
              Trust
            </Term>
            <dd>
              {/* Most trusted first, so the chain reads the way trust falls. */}
              <Chain
                levels={[...view.data.trust].reverse()}
                tone={(index, count) =>
                  index === 0
                    ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                    : index === count - 1
                      ? "bg-red-500/10 text-red-700 dark:text-red-300"
                      : undefined
                }
              />
            </dd>
          </div>
          <div className="space-y-2">
            <Term hint="Reading something private limits where the agent can send it.">
              Audience
            </Term>
            <dd>
              <Chain
                levels={AUDIENCE_ORDER.filter((name) =>
                  audiences.some((level) => level.name === name),
                )}
              />
            </dd>
          </div>
        </dl>
      )}
    </StepCard>
  );
}

// =============================================================================
// Internal components
// =============================================================================

/** The built-in audiences, widest first: each one sits inside the one before. */
const AUDIENCE_ORDER = ["public", "internal", "self"];

function Term({ hint, children }: { hint: string; children: ReactNode }) {
  return (
    <dt className="text-muted-foreground flex items-center gap-1 text-xs font-medium">
      <span>{children}</span>
      <Tooltip>
        <TooltipTrigger asChild>
          <UnstyledButton
            aria-label={`About ${String(children).toLowerCase()}`}
            className="hover:text-foreground"
          >
            <Info className="size-3.5" />
          </UnstyledButton>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">{hint}</TooltipContent>
      </Tooltip>
    </dt>
  );
}

/** Levels as tags joined by arrows, in the order a label moves through them. */
function Chain({
  levels,
  tone,
}: {
  levels: string[];
  tone?: (index: number, count: number) => string | undefined;
}) {
  return (
    <span className="flex flex-wrap items-center gap-2">
      {levels.map((name, index) => (
        <Fragment key={name}>
          {index > 0 && (
            <ArrowRight
              aria-hidden
              className="text-muted-foreground size-3.5"
            />
          )}
          <span
            className={cn(
              "bg-muted rounded-md px-2 py-0.5 font-mono text-xs font-medium",
              tone?.(index, levels.length),
            )}
          >
            {name}
          </span>
        </Fragment>
      ))}
    </span>
  );
}
