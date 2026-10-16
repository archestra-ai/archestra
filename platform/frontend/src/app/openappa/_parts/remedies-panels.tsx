"use client";

import { ArrowRight } from "lucide-react";
import { useState } from "react";
import { QueryLoadError } from "@/components/query-load-error";
import { Skeleton } from "@/components/ui/skeleton";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import { type Remedy, useRemedies } from "@/lib/openappa-remedies.query";
import { RemediesDialog, type RemedyFilter } from "./remedies-dialog";
import { StepCard } from "./step-card";

/**
 * Step three of "How your policy decides": the authorities that can approve a
 * blocked call and the sanitizers that can clean its data, each opening the
 * list of them.
 */
export function RemediesCard() {
  const view = useRemedies();
  const [open, setOpen] = useState<RemedyFilter | null>(null);

  return (
    <StepCard
      step={3}
      title="A blocked call can be unblocked"
      description="An authority approves it, or a sanitizer cleans the data. Otherwise it stays blocked."
    >
      {view.isLoadingError ? (
        <QueryLoadError
          title="Could not load authorities and sanitizers"
          error={view.error}
          onRetry={() => view.refetch()}
        />
      ) : !view.data ? (
        <div className="space-y-2.5">
          <Skeleton className="h-15 w-full" />
          <Skeleton className="h-15 w-full" />
        </div>
      ) : (
        <div className="space-y-2.5">
          <RemedyRow
            remedies={view.data.authorities}
            one="authority"
            many="authorities"
            detail="approves a blocked call"
            empty="nobody can approve a blocked call"
            onOpen={() => setOpen("authority")}
          />
          <RemedyRow
            remedies={view.data.sanitizers}
            one="sanitizer"
            many="sanitizers"
            detail="cleans data so the call can go through"
            empty="nothing cleans data"
            onOpen={() => setOpen("sanitizer")}
          />
          <RemediesDialog
            view={view.data}
            filter={open}
            onClose={() => setOpen(null)}
          />
        </div>
      )}
    </StepCard>
  );
}

// =============================================================================
// Internal components
// =============================================================================

function RemedyRow({
  remedies,
  one,
  many,
  detail,
  empty,
  onOpen,
}: {
  remedies: Remedy[];
  one: string;
  many: string;
  detail: string;
  empty: string;
  onOpen: () => void;
}) {
  const count = remedies.length;
  return (
    <UnstyledButton
      onClick={onOpen}
      disabled={count === 0}
      className="hover:bg-muted/50 flex w-full items-center justify-between gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors disabled:hover:bg-transparent"
    >
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-sm font-medium">
          {`${count} ${count === 1 ? one : many}`}
        </span>
        <span className="text-muted-foreground text-xs">
          {count === 0 ? empty : detail}
        </span>
      </span>
      {count > 0 && (
        <ArrowRight aria-hidden className="text-muted-foreground size-4" />
      )}
    </UnstyledButton>
  );
}
