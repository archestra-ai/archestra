"use client";

import {
  AUTO_ROUTING_BACKFILL_MAX_COST_USD,
  AUTO_ROUTING_BACKFILL_SCORER_CALLS,
  clientForExternalAgentIds,
} from "@archestra/shared";
import { AlertTriangle } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  type AutoRoutingBackfillState,
  useAutoRoutingBackfill,
  useCancelAutoRoutingBackfill,
  useScanAutoRoutingBackfill,
  useScoreAutoRoutingBackfill,
} from "@/lib/auto-routing.query";
import { formatDate } from "@/lib/utils/date-time";
import { formatCurrency } from "@/lib/utils/format-currency";

type Backfill = NonNullable<AutoRoutingBackfillState["backfill"]>;
type ScoreOffer = NonNullable<AutoRoutingBackfillState["scoreOffer"]>;

const API_SHAPES: Record<Backfill["breakdown"][number]["apiShape"], string> = {
  chat_completions: "Chat Completions",
  responses: "Responses",
  messages: "Messages",
};

/**
 * Past sessions from the interaction log the plan can learn from: a free scan
 * counts them, then an explicit, capped scoring run reads a sample with the
 * session scorer. Beside an active plan it folds into one line until opened.
 */
export function PastSessions({
  required,
  hasActivePlan,
  canUpdate,
}: {
  required: number;
  hasActivePlan: boolean;
  canUpdate: boolean;
}) {
  const { data } = useAutoRoutingBackfill();
  const scan = useScanAutoRoutingBackfill();
  const cancel = useCancelAutoRoutingBackfill();
  const [opened, setOpened] = useState(false);
  if (!data) return null;
  const { backfill, scoreOffer } = data;
  const running = backfill?.status === "running";
  if (hasActivePlan && !running && !opened) {
    return (
      <p
        className="flex items-center gap-2 text-sm text-muted-foreground"
        data-testid="auto-routing-past-traffic"
      >
        <span className="tabular-nums">
          Past traffic:{" "}
          {(backfill?.progress?.scored ?? 0).toLocaleString("en-US")} scored
        </span>
        {canUpdate && (
          <>
            <span aria-hidden>·</span>
            <Button
              size="xs"
              variant="link"
              className="h-auto p-0 text-sm"
              disabled={scan.isPending}
              onClick={() => (scoreOffer ? setOpened(true) : scan.mutate())}
            >
              {scoreOffer
                ? scoreOffer.rescore
                  ? "Re-score"
                  : "Score"
                : backfill
                  ? "Scan again"
                  : "Scan"}
            </Button>
          </>
        )}
      </p>
    );
  }

  return (
    <section
      className="space-y-3 rounded-md border p-4"
      data-testid="auto-routing-past-sessions"
    >
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="text-sm font-medium">Past sessions</h3>
        {canUpdate && !running && (
          <Button
            size="sm"
            variant="outline"
            className="ml-auto"
            disabled={scan.isPending}
            onClick={() => scan.mutate()}
          >
            {backfill ? "Scan again" : "Scan past sessions"}
          </Button>
        )}
        {canUpdate && running && (
          <Button
            size="sm"
            variant="outline"
            className="ml-auto"
            disabled={cancel.isPending}
            onClick={() => cancel.mutate()}
          >
            Cancel
          </Button>
        )}
      </div>
      {backfill ? (
        <BackfillStatus backfill={backfill} required={required} />
      ) : (
        <p className="text-sm text-muted-foreground">
          Scanning counts the past sessions in the interaction log the plan
          could learn from. It reads the database only and costs nothing.
        </p>
      )}
      {backfill && scoreOffer && canUpdate && (
        <ScoreAction offer={scoreOffer} />
      )}
    </section>
  );
}

function BackfillStatus({
  backfill,
  required,
}: {
  backfill: Backfill;
  required: number;
}) {
  if (backfill.status === "running" && backfill.phase === "scan") {
    return <p className="text-sm">Scanning past sessions…</p>;
  }
  const eligible = backfill.eligibleSessions;
  return (
    <div className="space-y-2 text-sm">
      <p data-testid="auto-routing-past-sessions-eligible">
        {eligible.toLocaleString("en-US")} eligible sessions since{" "}
        {formatDate({ date: backfill.windowStart })}.{" "}
        {eligible < required
          ? `The plan needs ${required.toLocaleString("en-US")}; live auto traffic fills the rest.`
          : "Enough for a first plan."}
      </p>
      {backfill.breakdown.length > 0 && (
        <ul className="text-muted-foreground">
          {backfill.breakdown.map((row) => (
            <li key={`${row.apiShape}-${row.client}`}>
              {API_SHAPES[row.apiShape]},{" "}
              {clientForExternalAgentIds([row.client])?.label ?? row.client}:{" "}
              {row.sessions.toLocaleString("en-US")}
            </li>
          ))}
        </ul>
      )}
      {backfill.progress && (
        <p data-testid="auto-routing-past-sessions-progress">
          {backfill.status === "running" ? "Scoring: " : "Scored "}
          {backfill.progress.scored.toLocaleString("en-US")} of{" "}
          {backfill.progress.sample.toLocaleString("en-US")} sessions, spent{" "}
          {formatCurrency(backfill.spentCostUsd)}
          {backfill.maxCostUsd !== null && (
            <span> of {formatCurrency(backfill.maxCostUsd)}</span>
          )}
          .
        </p>
      )}
      {backfill.error && (
        <InlineNotice variant={backfill.status === "failed" ? "error" : "info"}>
          <AlertTriangle />
          <InlineNoticeText>{backfill.error}</InlineNoticeText>
        </InlineNotice>
      )}
      {backfill.fitBlockedReason && (
        <InlineNotice>
          <AlertTriangle />
          <span className="font-medium">
            No plan is fitted on these sessions
          </span>
          <InlineNoticeText>{backfill.fitBlockedReason}</InlineNoticeText>
        </InlineNotice>
      )}
    </div>
  );
}

function ScoreAction({ offer }: { offer: ScoreOffer }) {
  // What the admin confirms, frozen while the dialog is open.
  const [confirming, setConfirming] = useState<{
    offer: ScoreOffer;
    maxCostUsd: number;
  } | null>(null);
  const [ceiling, setCeiling] = useState(String(offer.suggestedMaxCostUsd));
  const score = useScoreAutoRoutingBackfill();
  const maxCostUsd = Number(ceiling);
  const ceilingError =
    !Number.isFinite(maxCostUsd) || maxCostUsd <= 0
      ? "Enter a positive amount."
      : maxCostUsd > AUTO_ROUTING_BACKFILL_MAX_COST_USD
        ? `At most ${formatCurrency(AUTO_ROUTING_BACKFILL_MAX_COST_USD)}.`
        : null;
  const verb = offer.rescore ? "Re-score" : "Score";

  return (
    <div className="space-y-2">
      {offer.rescore && (
        <p className="text-sm text-muted-foreground">
          The session scorer changed since these sessions were scored.
        </p>
      )}
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label htmlFor="auto-routing-backfill-ceiling">
            Spending limit (USD)
          </Label>
          <Input
            id="auto-routing-backfill-ceiling"
            type="number"
            min={0}
            max={AUTO_ROUTING_BACKFILL_MAX_COST_USD}
            step="0.01"
            value={ceiling}
            aria-invalid={ceilingError !== null}
            aria-describedby="auto-routing-backfill-ceiling-hint"
            onChange={(event) => setCeiling(event.target.value)}
            className="w-32"
          />
        </div>
        <Button
          size="sm"
          disabled={ceilingError !== null}
          onClick={() => setConfirming({ offer, maxCostUsd })}
        >
          {verb} {offer.remaining.toLocaleString("en-US")} sessions (≤{" "}
          {ceilingError === null ? formatCurrency(maxCostUsd) : "?"})
        </Button>
        <span className="text-sm text-muted-foreground">
          Estimated {formatCurrency(offer.estimatedCostUsd)}
        </span>
      </div>
      <p
        id="auto-routing-backfill-ceiling-hint"
        className={
          ceilingError
            ? "text-sm text-destructive"
            : "text-sm text-muted-foreground"
        }
      >
        {ceilingError ??
          `May be exceeded by at most ${AUTO_ROUTING_BACKFILL_SCORER_CALLS} × the per-call cost of calls in flight.`}
      </p>
      <Dialog
        open={confirming !== null}
        onOpenChange={(open) => !open && setConfirming(null)}
      >
        {confirming && (
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{verb} past sessions?</DialogTitle>
              <DialogDescription>
                The opening prompts of these sessions are sent to the Jev
                session scorer.
              </DialogDescription>
            </DialogHeader>
            <DialogBody>
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                <dt className="text-muted-foreground">Window</dt>
                <dd>
                  {formatDate({ date: confirming.offer.windowStart })} to{" "}
                  {formatDate({ date: confirming.offer.cutoff })}
                </dd>
                <dt className="text-muted-foreground">Sessions</dt>
                <dd>{confirming.offer.remaining.toLocaleString("en-US")}</dd>
                <dt className="text-muted-foreground">Spending limit</dt>
                <dd>{formatCurrency(confirming.maxCostUsd)}</dd>
              </dl>
            </DialogBody>
            <DialogFooter>
              <Button variant="outline" onClick={() => setConfirming(null)}>
                Cancel
              </Button>
              <Button
                disabled={score.isPending}
                onClick={() =>
                  score.mutate(
                    {
                      backfillId: confirming.offer.backfillId,
                      scorerVersionId: confirming.offer.scorerVersionId,
                      maxSessions: confirming.offer.sessions,
                      maxCostUsd: confirming.maxCostUsd,
                    },
                    { onSettled: () => setConfirming(null) },
                  )
                }
              >
                {verb} sessions
              </Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
    </div>
  );
}
