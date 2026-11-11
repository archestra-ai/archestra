"use client";

import {
  AUTO_ROUTING_BACKFILL_MAX_COST_USD,
  clientForExternalAgentIds,
} from "@archestra/shared";
import { AlertTriangle, Loader2 } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
import {
  type AutoRoutingBackfillState,
  type AutoRoutingScorerState,
  useAutoRoutingBackfill,
  useCancelAutoRoutingBackfill,
  useScanAutoRoutingBackfill,
  useScoreAutoRoutingBackfill,
} from "@/lib/auto-routing.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import { formatDate } from "@/lib/utils/date-time";
import { formatCurrency } from "@/lib/utils/format-currency";
import { AddJevKeyLink } from "./add-jev-key";

type Backfill = NonNullable<AutoRoutingBackfillState["backfill"]>;
type ScoreOffer = NonNullable<AutoRoutingBackfillState["scoreOffer"]>;

/**
 * Past sessions from the interaction log the first plan can learn from: a
 * free scan counts them, then an explicit, capped scoring run reads a sample
 * with the session scorer. Shown until a plan is active; after that the
 * header menu opens `PastSessionsDialog` and `PastSessionsNotice` reports runs.
 */
export function PastSessions({
  routingEnabled,
  canUpdate,
  scorer,
}: {
  routingEnabled: boolean;
  canUpdate: boolean;
  scorer: AutoRoutingScorerState;
}) {
  const { data } = useAutoRoutingBackfill();
  const scan = useScanAutoRoutingBackfill();
  const cancel = useCancelAutoRoutingBackfill();
  if (!data) return null;
  const { backfill, scoreOffer } = data;
  const running = backfill?.status === "running";
  const scoreAction =
    scoreOffer &&
    (scorer === "no_jev_key" ? (
      <AddJevKeyLink />
    ) : (
      canUpdate && (
        <ScoreDialogTrigger offer={scoreOffer}>
          {(open) => (
            <Button size="sm" onClick={open}>
              {scoreLabel(scoreOffer)}
            </Button>
          )}
        </ScoreDialogTrigger>
      )
    ));
  const scanButton = (label: string) => (
    <Button
      size="sm"
      variant="outline"
      disabled={scan.isPending}
      onClick={() => scan.mutate()}
    >
      {label}
    </Button>
  );

  return (
    <Card className="gap-3 py-4" data-testid="auto-routing-past-sessions">
      <CardHeader className="px-4">
        <CardTitle className="text-sm">Past sessions</CardTitle>
        {!backfill && (
          <CardDescription>
            Scanning finds the past sessions in the interaction log the plan
            could learn from. It reads the database only and costs nothing.
          </CardDescription>
        )}
        {canUpdate && (
          <CardAction className="flex flex-wrap items-center gap-2">
            {running ? (
              <Button
                size="sm"
                variant="outline"
                disabled={cancel.isPending}
                onClick={() => cancel.mutate()}
              >
                Cancel
              </Button>
            ) : (
              <>
                {backfill && scoreAction}
                {scanButton(backfill ? "Scan again" : "Scan past sessions")}
              </>
            )}
          </CardAction>
        )}
      </CardHeader>
      {backfill && (
        <CardContent className="space-y-3 px-4">
          <BackfillStatus backfill={backfill} routingEnabled={routingEnabled} />
          {scoreOffer && !canUpdate && scorer === "no_jev_key" && (
            <AddJevKeyLink />
          )}
        </CardContent>
      )}
    </Card>
  );
}

/**
 * Beside an active plan: a past-sessions run in progress, a re-score the
 * plan needs after a scorer change, or why the last run went wrong. Nothing
 * otherwise.
 */
export function PastSessionsNotice({
  routingEnabled,
  canUpdate,
  scorer,
}: {
  routingEnabled: boolean;
  canUpdate: boolean;
  scorer: AutoRoutingScorerState;
}) {
  const { data } = useAutoRoutingBackfill();
  const cancel = useCancelAutoRoutingBackfill();
  if (!data) return null;
  const { backfill, scoreOffer } = data;

  if (backfill?.status === "running") {
    const scanning = backfill.phase === "scan";
    return (
      <InlineNotice variant="info" data-testid="auto-routing-past-sessions">
        <Loader2 className="animate-spin" />
        <span className="font-medium">
          {scanning ? "Scanning past sessions" : "Scoring past sessions"}
        </span>
        {!scanning && (
          <InlineNoticeText className="tabular-nums">
            {[
              ...funnel(backfill.eligibleSessions, backfill.progress),
              spend(backfill),
            ].join(" · ")}
          </InlineNoticeText>
        )}
        {canUpdate && (
          <Button
            size="xs"
            variant="outline"
            className="ml-auto"
            disabled={cancel.isPending}
            onClick={() => cancel.mutate()}
          >
            Cancel
          </Button>
        )}
      </InlineNotice>
    );
  }
  if (scoreOffer?.rescore) {
    return (
      <InlineNotice data-testid="auto-routing-past-sessions">
        <AlertTriangle />
        <span className="font-medium">Past sessions need re-scoring</span>
        <InlineNoticeText className="tabular-nums">
          The session scorer changed, so {count(scoreOffer.remaining)} past
          sessions no longer count toward the plan.
        </InlineNoticeText>
        <span className="ml-auto">
          {scorer === "no_jev_key" ? (
            <AddJevKeyLink />
          ) : (
            canUpdate && (
              <ScoreDialogTrigger offer={scoreOffer}>
                {(open) => (
                  <Button size="xs" variant="outline" onClick={open}>
                    {scoreLabel(scoreOffer)}
                  </Button>
                )}
              </ScoreDialogTrigger>
            )
          )}
        </span>
      </InlineNotice>
    );
  }
  if (backfill?.status === "failed" && backfill.error) {
    return (
      <InlineNotice variant="error" data-testid="auto-routing-past-sessions">
        <AlertTriangle />
        <span className="font-medium">Scoring past sessions failed</span>
        <InlineNoticeText>{backfill.error}</InlineNoticeText>
      </InlineNotice>
    );
  }
  if (routingEnabled && backfill?.fitBlockedReason) {
    return (
      <InlineNotice data-testid="auto-routing-past-sessions">
        <AlertTriangle />
        <span className="font-medium">No plan is fitted on past sessions</span>
        <InlineNoticeText>{backfill.fitBlockedReason}</InlineNoticeText>
      </InlineNotice>
    );
  }
  return null;
}

/** A scan this recent is still a fair count; an older one is redone when the dialog opens. */
const SCAN_FRESH_MS = 24 * 60 * 60 * 1000;

/**
 * Score past sessions in one step: opening the dialog scans the interaction
 * log when the last count is stale (it is free), then offers to score what it
 * found at an estimated cost under a spending limit.
 */
export function PastSessionsDialog({
  scorer,
  onClose,
}: {
  scorer: AutoRoutingScorerState;
  onClose: () => void;
}) {
  const { data } = useAutoRoutingBackfill();
  const scan = useScanAutoRoutingBackfill();
  const cancel = useCancelAutoRoutingBackfill();
  const [scanRequested, setScanRequested] = useState(false);
  const backfill = data?.backfill ?? null;
  const scoreOffer = data?.scoreOffer ?? null;
  const stale =
    data !== undefined &&
    backfill?.status !== "running" &&
    (backfill === null ||
      Date.now() - new Date(backfill.cutoff).getTime() > SCAN_FRESH_MS);

  useEffect(() => {
    if (stale && !scanRequested) {
      setScanRequested(true);
      scan.mutate();
    }
  }, [stale, scanRequested, scan]);

  const scanning =
    data === undefined ||
    scan.isPending ||
    (stale && !scan.isError) ||
    (backfill?.status === "running" && backfill.phase === "scan");

  if (scoreOffer && !scanning && backfill?.status !== "running") {
    if (scorer !== "no_jev_key") {
      return (
        <ScoreDialog
          offer={scoreOffer}
          onDone={onClose}
          details={backfill && <ScanFindings backfill={backfill} />}
        />
      );
    }
  }

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Score past sessions</DialogTitle>
        <DialogDescription>
          The plan learns from scored sessions. Scoring past sessions from the
          interaction log lets it learn from traffic that went out before
          routing.
        </DialogDescription>
      </DialogHeader>
      <DialogBody className="space-y-4 text-sm">
        {scanning ? (
          <p className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            <span>Looking for past sessions in the interaction log…</span>
          </p>
        ) : backfill?.status === "running" ? (
          <p className="tabular-nums">
            Scoring:{" "}
            {[
              ...funnel(backfill.eligibleSessions, backfill.progress),
              spend(backfill),
            ].join(" · ")}
          </p>
        ) : (
          <>
            {backfill && <ScanFindings backfill={backfill} />}
            {scoreOffer && scorer === "no_jev_key" ? (
              <AddJevKeyLink />
            ) : (
              <p>
                {backfill && backfill.eligibleSessions > 0
                  ? "Every past session the plan can use is already scored."
                  : "No past sessions the plan can learn from."}
              </p>
            )}
            {backfill?.error && (
              <InlineNotice
                variant={backfill.status === "failed" ? "error" : "info"}
              >
                <AlertTriangle />
                <InlineNoticeText>{backfill.error}</InlineNoticeText>
              </InlineNotice>
            )}
          </>
        )}
      </DialogBody>
      <DialogFooter>
        {backfill?.status === "running" && backfill.phase === "score" && (
          <Button
            variant="outline"
            disabled={cancel.isPending}
            onClick={() => cancel.mutate()}
          >
            Stop scoring
          </Button>
        )}
        <Button onClick={onClose}>Close</Button>
      </DialogFooter>
    </DialogContent>
  );
}

/** What the scan found: its window and the sessions per client. */
function ScanFindings({ backfill }: { backfill: Backfill }) {
  return (
    <div className="space-y-2 text-sm" data-testid="auto-routing-scan-findings">
      <p className="tabular-nums">
        {count(backfill.eligibleSessions)} past sessions found,{" "}
        {formatDate({ date: backfill.windowStart, dateFormat: "MMM d" })} –{" "}
        {formatDate({ date: backfill.cutoff, dateFormat: "MMM d, yyyy" })}
      </p>
      <ClientBreakdown breakdown={backfill.breakdown} />
    </div>
  );
}

function BackfillStatus({
  backfill,
  routingEnabled,
}: {
  backfill: Backfill;
  routingEnabled: boolean;
}) {
  if (backfill.status === "running" && backfill.phase === "scan") {
    return <p className="text-sm">Scanning past sessions…</p>;
  }
  const { progress } = backfill;
  const unread = progress
    ? [
        ...(progress.noText > 0 ? [`${count(progress.noText)} skipped`] : []),
        ...(progress.failed > 0 ? [`${count(progress.failed)} failed`] : []),
      ]
    : [];
  return (
    <div className="space-y-3 text-sm">
      <details>
        <summary className="cursor-pointer select-none tabular-nums">
          <span data-testid="auto-routing-past-sessions-funnel">
            {[
              ...funnel(backfill.eligibleSessions, progress),
              ...(backfill.status === "running" && backfill.phase === "score"
                ? [`scoring, ${spend(backfill)}`]
                : []),
            ].join(" · ")}
          </span>
        </summary>
        <div className="mt-2 space-y-3 text-muted-foreground tabular-nums">
          <div className="space-y-1">
            <p>
              {formatDate({
                date: backfill.windowStart,
                dateFormat:
                  new Date(backfill.windowStart).getFullYear() ===
                  new Date(backfill.cutoff).getFullYear()
                    ? "MMM d"
                    : "MMM d, yyyy",
              })}{" "}
              –{" "}
              {formatDate({ date: backfill.cutoff, dateFormat: "MMM d, yyyy" })}
            </p>
            {unread.length > 0 && <p>Not scored: {unread.join(", ")}</p>}
            {backfill.phase === "score" && (
              <>
                <p>Budget accounted: {spend(backfill)}</p>
                <p>
                  Includes estimates when the scorer did not report a cost. This
                  is not a billing statement.
                </p>
              </>
            )}
          </div>
          <ClientBreakdown breakdown={backfill.breakdown} />
        </div>
      </details>
      {backfill.error && (
        <InlineNotice variant={backfill.status === "failed" ? "error" : "info"}>
          <AlertTriangle />
          <InlineNoticeText>{backfill.error}</InlineNoticeText>
        </InlineNotice>
      )}
      {routingEnabled && backfill.fitBlockedReason && (
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

function spend(backfill: Backfill): string {
  const spent = formatCurrency(backfill.spentCostUsd);
  return backfill.maxCostUsd === null
    ? spent
    : `${spent} of ${formatCurrency(backfill.maxCostUsd)}`;
}

/** Found, then scored; unread sessions count against the sample, not as pending. */
function funnel(found: number, progress: Backfill["progress"]): string[] {
  if (!progress) return [`${count(found)} found`, "none scored yet"];
  const attempted = progress.scored + progress.noText + progress.failed;
  return [
    `${count(found)} found`,
    attempted < progress.sample
      ? `${count(progress.scored)} of ${count(progress.sample)} scored`
      : `${count(progress.scored)} scored`,
  ];
}

/** Sessions per client, largest first; the tail past the top rows folds into "Other". */
function ClientBreakdown({ breakdown }: { breakdown: Backfill["breakdown"] }) {
  const appName = useAppName();
  const totals = new Map<string, number>();
  for (const row of breakdown) {
    const label = clientLabel(row.client, appName);
    totals.set(label, (totals.get(label) ?? 0) + row.sessions);
  }
  const ranked = [...totals]
    .filter(([label]) => label !== OTHER_CLIENTS)
    .sort(([, a], [, b]) => b - a);
  const other =
    (totals.get(OTHER_CLIENTS) ?? 0) +
    ranked.slice(TOP_CLIENTS).reduce((sum, [, sessions]) => sum + sessions, 0);
  const rows = [
    ...ranked.slice(0, TOP_CLIENTS),
    ...(other > 0 ? [[OTHER_CLIENTS, other] as const] : []),
  ];
  if (rows.length === 0) return null;
  const largest = Math.max(...rows.map(([, sessions]) => sessions));
  return (
    <table className="w-full max-w-md text-foreground">
      <tbody>
        {rows.map(([label, sessions]) => (
          <tr key={label}>
            <td className="py-0.5 pr-3 whitespace-nowrap">{label}</td>
            <td className="py-0.5 pr-3 text-right tabular-nums">
              {count(sessions)}
            </td>
            <td className="w-full py-0.5" aria-hidden>
              <div
                className="h-2 rounded-sm bg-primary/60"
                style={{ width: `${(sessions / largest) * 100}%` }}
              />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** The score action's label: what it scores and roughly what it costs. */
function scoreLabel(offer: ScoreOffer): string {
  return `${offer.rescore ? "Re-score" : "Score"} ${count(offer.remaining)} sessions · ~${formatCurrency(offer.estimatedCostUsd)}`;
}

/**
 * Opens the confirmation that says what scoring does and what it may cost;
 * nothing is scored until the admin confirms there.
 */
function ScoreDialogTrigger({
  offer,
  children,
}: {
  offer: ScoreOffer;
  children: (open: () => void) => ReactNode;
}) {
  // The offer the admin confirms, frozen while the dialog is open.
  const [confirming, setConfirming] = useState<ScoreOffer | null>(null);
  return (
    <>
      {children(() => setConfirming(offer))}
      <Dialog
        open={confirming !== null}
        onOpenChange={(open) => !open && setConfirming(null)}
      >
        {confirming && (
          <ScoreDialog offer={confirming} onDone={() => setConfirming(null)} />
        )}
      </Dialog>
    </>
  );
}

function ScoreDialog({
  offer,
  onDone,
  details = null,
}: {
  offer: ScoreOffer;
  onDone: () => void;
  /** Shown above the figures: what the scan found, when the dialog also scanned. */
  details?: ReactNode;
}) {
  const [ceiling, setCeiling] = useState(offer.suggestedMaxCostUsd.toFixed(2));
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
    <DialogContent>
      <DialogHeader>
        <DialogTitle>{verb} past sessions?</DialogTitle>
        <DialogDescription>
          Auto splits sessions across the fast, normal and smart models by how
          hard they are. Scoring sends the opening prompt of each past session
          to Jev, which rates it, so the routing plan can learn from your
          organization&apos;s real traffic.
        </DialogDescription>
      </DialogHeader>
      <DialogBody className="space-y-4">
        {details}
        {offer.rescore && (
          <p className="text-sm text-muted-foreground">
            The session scorer changed since these sessions were scored, so
            their old scores no longer count.
          </p>
        )}
        <dl className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2 text-sm">
          <dt className="text-muted-foreground">Sessions</dt>
          <dd>
            {count(offer.remaining)}, from{" "}
            {formatDate({ date: offer.windowStart, dateFormat: "MMM d, yyyy" })}{" "}
            to {formatDate({ date: offer.cutoff, dateFormat: "MMM d, yyyy" })}
          </dd>
          <dt className="text-muted-foreground">Estimated cost</dt>
          <dd>~{formatCurrency(offer.estimatedCostUsd)}</dd>
          <dt className="text-muted-foreground">Spending limit</dt>
          <dd className="flex items-center gap-1.5">
            <span className="text-muted-foreground">$</span>
            <Input
              aria-label="Spending limit (USD)"
              type="number"
              min={0}
              max={AUTO_ROUTING_BACKFILL_MAX_COST_USD}
              step="0.01"
              value={ceiling}
              aria-invalid={ceilingError !== null}
              aria-describedby={
                ceilingError
                  ? "auto-routing-backfill-ceiling-error"
                  : "auto-routing-backfill-ceiling-hint"
              }
              onChange={(event) => setCeiling(event.target.value)}
              className="w-24"
            />
          </dd>
        </dl>
        {ceilingError ? (
          <p
            id="auto-routing-backfill-ceiling-error"
            className="text-sm text-destructive"
          >
            {ceilingError}
          </p>
        ) : (
          <p
            id="auto-routing-backfill-ceiling-hint"
            className="text-sm text-muted-foreground"
          >
            Scoring runs in the background and stops at the limit. When it
            finishes, the next routing plan is fitted on the scores. Chats keep
            running meanwhile.
          </p>
        )}
      </DialogBody>
      <DialogFooter>
        <Button variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button
          disabled={ceilingError !== null || score.isPending}
          onClick={() =>
            score.mutate(
              {
                backfillId: offer.backfillId,
                scorerVersionId: offer.scorerVersionId,
                maxSessions: offer.sessions,
                maxCostUsd,
              },
              { onSettled: onDone },
            )
          }
        >
          {verb} {count(offer.remaining)} sessions
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

const TOP_CLIENTS = 5;
const OTHER_CLIENTS = "Other";
/** Archestra agents record their delegation chain, agent ids joined by ":", as the client. */
const DELEGATION_CHAIN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})*$/;

function clientLabel(client: string, appName: string): string {
  const family = clientForExternalAgentIds([client]);
  if (family) return family.label;
  return DELEGATION_CHAIN.test(client) ? `${appName} agents` : OTHER_CLIENTS;
}

function count(value: number): string {
  return value.toLocaleString("en-US");
}
