"use client";

import {
  AUTO_ROUTING_BACKFILL_MAX_COST_USD,
  clientForExternalAgentIds,
} from "@archestra/shared";
import { AlertTriangle, Loader2, Square } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  type AutoRoutingBackfillState,
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
type HistoryRow = AutoRoutingBackfillState["history"][number];

/**
 * Past sessions from the interaction log the plan can learn from, in one
 * place whatever the router's state: what scanning and scoring did so far,
 * and one button that starts scoring or stops the job that runs. The
 * organization has one pool of them, shared by every router that reads it.
 */
export function PastSessions({
  routingEnabled,
  canUpdate,
  routerName,
}: {
  routingEnabled: boolean;
  canUpdate: boolean;
  routerName: string;
}) {
  const { data } = useAutoRoutingBackfill();
  const [scoring, setScoring] = useState(false);
  if (!data) return null;
  const { backfill, scoreOffer, history, payer } = data;

  return (
    <Card className="gap-3 py-4" data-testid="auto-routing-past-sessions">
      <CardHeader className="px-4">
        <CardTitle className="text-sm">Past sessions</CardTitle>
        <CardDescription>
          Scoring sessions from before routing lets the plan learn without
          waiting for new traffic. Every router that learns from past sessions
          shares them.
        </CardDescription>
        {canUpdate && (
          <CardAction>
            <PastSessionsAction
              backfill={backfill}
              scoreOffer={scoreOffer}
              payer={payer}
              onScore={() => setScoring(true)}
            />
          </CardAction>
        )}
      </CardHeader>
      <CardContent className="space-y-3 px-4">
        {scoreOffer?.rescore && backfill?.status !== "running" && (
          <InlineNotice>
            <AlertTriangle />
            <span className="font-medium">
              Past sessions need scoring again
            </span>
            <InlineNoticeText>
              The decision model changed, so their earlier scores no longer
              count.
            </InlineNoticeText>
          </InlineNotice>
        )}
        {routingEnabled && backfill?.fitBlockedReason && (
          <InlineNotice>
            <AlertTriangle />
            <span className="font-medium">
              No plan is fitted on past sessions
            </span>
            <InlineNoticeText>{backfill.fitBlockedReason}</InlineNoticeText>
          </InlineNotice>
        )}
        {!canUpdate && payer === "no_jev_key" && scoreOffer && (
          <AddJevKeyLink />
        )}
        <PastSessionsHistory history={history} />
      </CardContent>
      <Dialog open={scoring} onOpenChange={setScoring}>
        {scoring && (
          <PastSessionsDialog
            routerName={routerName}
            onClose={() => setScoring(false)}
          />
        )}
      </Dialog>
    </Card>
  );
}

/**
 * The card's one button: Score while there is something to score, Stop
 * while a job runs, in the same place so it never has to be found again.
 */
function PastSessionsAction({
  backfill,
  scoreOffer,
  payer,
  onScore,
}: {
  backfill: Backfill | null;
  scoreOffer: ScoreOffer | null;
  payer: AutoRoutingBackfillState["payer"];
  onScore: () => void;
}) {
  const cancel = useCancelAutoRoutingBackfill();
  const scan = useScanAutoRoutingBackfill();
  if (backfill?.status === "running") {
    return (
      <Button
        size="sm"
        variant="outline"
        disabled={cancel.isPending}
        onClick={() => cancel.mutate(backfill)}
      >
        {cancel.isPending ? <Loader2 className="animate-spin" /> : <Square />}
        <span>{cancel.isPending ? "Stopping…" : "Stop"}</span>
      </Button>
    );
  }
  if (payer === "no_jev_key") return <AddJevKeyLink />;
  if (!scoreOffer && backfill !== null && !isScanStale(backfill)) {
    return (
      <Button
        size="sm"
        variant="outline"
        disabled={scan.isPending}
        onClick={() => scan.mutate(backfill.id)}
      >
        Scan again (free)
      </Button>
    );
  }
  return (
    <Button size="sm" onClick={onScore}>
      Score
    </Button>
  );
}

/** The same scoring dialog as the Past sessions card, opened from elsewhere on the page. */
export function ScorePastSessionsDialog({
  open,
  onOpenChange,
  routerName,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  routerName: string;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open && (
        <PastSessionsDialog
          routerName={routerName}
          onClose={() => onOpenChange(false)}
        />
      )}
    </Dialog>
  );
}

/** What scanning and scoring did, newest first; a running job's row updates as it goes. */
function PastSessionsHistory({ history }: { history: HistoryRow[] }) {
  if (history.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No past sessions counted yet.
      </p>
    );
  }
  return (
    <Table data-testid="auto-routing-past-sessions-history">
      <TableHeader>
        <TableRow>
          <TableHead>When</TableHead>
          <TableHead>What happened</TableHead>
          <TableHead className="text-right">Sessions</TableHead>
          <TableHead className="text-right">Cost</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {history.map((row) => {
          const described = describeHistoryRow(row);
          return (
            <TableRow key={row.id}>
              <TableCell className="whitespace-nowrap text-muted-foreground tabular-nums">
                {formatDate({
                  date: row.createdAt,
                  dateFormat: "MMM d, HH:mm",
                })}
              </TableCell>
              <TableCell className="whitespace-normal">
                <div className="flex items-center gap-2 font-medium">
                  {described.running && (
                    <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
                  )}
                  <span>{described.what}</span>
                </div>
                {described.detail && (
                  <div
                    className={
                      described.failed
                        ? "text-xs text-destructive"
                        : "text-xs text-muted-foreground"
                    }
                  >
                    {described.detail}
                  </div>
                )}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {described.sessions}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {described.cost}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

/** One history row in words: scans count sessions for free, scoring jobs score them for a cost. */
function describeHistoryRow(row: HistoryRow): {
  what: string;
  detail: string | null;
  sessions: string;
  cost: string;
  running: boolean;
  failed: boolean;
} {
  const running = row.status === "running";
  const failed = row.status === "failed";
  const startedBy = row.startedByName
    ? `Started by ${row.startedByName}`
    : null;
  if (row.phase === "scan") {
    const what = running
      ? "Counting past sessions"
      : row.status === "cancelled"
        ? "Counting stopped"
        : failed
          ? "Counting failed"
          : `Found ${count(row.foundSessions)} past sessions`;
    return {
      what,
      detail:
        row.error ?? (row.startedByName ? startedBy : "Counted automatically"),
      sessions: running ? "—" : count(row.foundSessions),
      cost: "Free",
      running,
      failed,
    };
  }
  const scored = row.scoredSessions ?? 0;
  const what = running
    ? "Scoring past sessions"
    : row.status === "done"
      ? `Scored ${count(scored)} past sessions`
      : row.status === "superseded"
        ? `Stopped after ${count(scored)} sessions: the decision model changed`
        : failed
          ? `Scoring failed after ${count(scored)} sessions`
          : `Stopped after ${count(scored)} sessions`;
  const spent = formatCurrency(row.spentCostUsd);
  return {
    what,
    detail: row.error ?? startedBy,
    sessions: running ? `${count(scored)} scored` : count(scored),
    cost:
      running && row.maxCostUsd !== null
        ? `${spent} of ${formatCurrency(row.maxCostUsd)}`
        : spent,
    running,
    failed,
  };
}

/** A scan this recent is still a fair count; an older one is redone when the dialog opens. */
const SCAN_FRESH_MS = 24 * 60 * 60 * 1000;

/** True when the dialog should count again: the count is old, or it was stopped or failed. */
function isScanStale(backfill: Backfill): boolean {
  if (
    backfill.phase === "scan" &&
    (backfill.status === "cancelled" || backfill.status === "failed")
  ) {
    return true;
  }
  return Date.now() - new Date(backfill.cutoff).getTime() > SCAN_FRESH_MS;
}

/**
 * Score past sessions in one step: opening the dialog scans the interaction
 * log when the last count is stale (it is free), then offers to score what it
 * found at an estimated cost under a spending limit.
 */
function PastSessionsDialog({
  routerName,
  onClose,
}: {
  routerName: string;
  onClose: () => void;
}) {
  const { data } = useAutoRoutingBackfill();
  const payer = data?.payer;
  const scan = useScanAutoRoutingBackfill();
  // A ref, not state: Strict Mode runs the effect twice before a state update lands.
  const scanRequested = useRef(false);
  const backfill = data?.backfill ?? null;
  const scoreOffer = data?.scoreOffer ?? null;
  const stale =
    data !== undefined &&
    backfill?.status !== "running" &&
    (backfill === null || isScanStale(backfill));

  const latestBackfillId = backfill?.id ?? null;
  useEffect(() => {
    if (stale && !scanRequested.current) {
      scanRequested.current = true;
      scan.mutate(latestBackfillId);
    }
  }, [stale, scan, latestBackfillId]);

  const scanning =
    data === undefined ||
    scan.isPending ||
    (stale && !scan.isError) ||
    (backfill?.status === "running" && backfill.phase === "scan");

  if (scoreOffer && !scanning && backfill?.status !== "running") {
    if (payer === "ready") {
      return (
        <ScoreDialog
          offer={scoreOffer}
          routerName={routerName}
          pastSessionsNeeded={data?.pastSessionsNeeded ?? 0}
          onDone={onClose}
          details={
            backfill?.id === scoreOffer.backfillId && (
              <ScanFindings backfill={backfill} />
            )
          }
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
          <p>Scoring is already running. Follow it on the page.</p>
        ) : (
          <>
            {backfill && <ScanFindings backfill={backfill} />}
            {scoreOffer && payer === "no_jev_key" ? (
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
    <table className="text-foreground">
      <tbody>
        {rows.map(([label, sessions]) => (
          <tr key={label}>
            <td className="py-0.5 pr-3 whitespace-nowrap">{label}</td>
            <td className="py-0.5 pr-3 text-right tabular-nums">
              {count(sessions)}
            </td>
            <td className="w-40 min-w-40 py-0.5" aria-hidden>
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

function ScoreDialog({
  offer,
  routerName,
  pastSessionsNeeded,
  onDone,
  details = null,
}: {
  offer: ScoreOffer;
  routerName: string;
  /** Past sessions it takes before they start a router sooner than its own would. */
  pastSessionsNeeded: number;
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
          <code>{routerName}</code> splits sessions across the fast, normal and
          smart models by how hard they are. Scoring sends the opening prompt of
          each past session to Jev, which rates it, so the routing plan can
          learn from your organization&apos;s real traffic.
        </DialogDescription>
      </DialogHeader>
      <DialogBody className="space-y-4">
        {details}
        {offer.usableSessions < pastSessionsNeeded && (
          <InlineNotice data-testid="auto-routing-score-too-few">
            <AlertTriangle />
            <span className="font-medium">
              This will not start routers sooner
            </span>
            <InlineNoticeText>
              Past sessions count toward a router&apos;s first plan from{" "}
              {count(pastSessionsNeeded)} scored ones, and this sample can yield
              at most {count(offer.usableSessions)}. With fewer, a router starts
              on its own sessions alone.
            </InlineNoticeText>
          </InlineNotice>
        )}
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
              className="w-32"
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
