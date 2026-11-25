"use client";

import { AlertTriangle, Hourglass, Info } from "lucide-react";
import { useState } from "react";
import { QueryLoadError } from "@/components/query-load-error";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  InlineNotice,
  InlineNoticeBody,
  InlineNoticeText,
} from "@/components/ui/inline-notice";
import { Progress } from "@/components/ui/progress";
import { useHasPermissions } from "@/lib/auth/auth.query";
import {
  type AutoRouter,
  useAutoRouter,
  useAutoRoutingBackfill,
} from "@/lib/auto-routing.query";
import { formatCurrency } from "@/lib/utils/format-currency";
import { BUDGET_PRESET_LABELS } from "../_parts/budget-presets";
import { PastSessions, ScorePastSessionsDialog } from "../_parts/past-sessions";
import { describeFitError } from "../_parts/plan-document";
import { RouterFigures } from "../_parts/router-figures";
import { coldStartProgress, coldStartState } from "../_parts/router-status";
import { isAutoRoutingSetUp, SetupCards } from "../_parts/setup-cards";
import { TIER_LABELS, TIER_NAMES } from "../_parts/tiers";

export default function AutoRoutingOverviewPage() {
  const settingsQuery = useAutoRouter();
  const { data: canUpdate = false } = useHasPermissions({
    llmProxy: ["update"],
  });
  // Owned here, so the dialog outlives the notice action that opened it.
  const [scoring, setScoring] = useState(false);
  if (settingsQuery.isLoadingError) {
    return (
      <QueryLoadError
        title="Couldn't load this auto router"
        error={settingsQuery.error}
        onRetry={() => settingsQuery.refetch()}
      />
    );
  }
  const settings = settingsQuery.data;
  if (!settings) return null;

  const pastSessions = (
    <PastSessionsCard settings={settings} canUpdate={canUpdate} />
  );

  if (!isAutoRoutingSetUp(settings)) {
    return (
      <div className="space-y-6">
        <SetupCards settings={settings} />
        {pastSessions}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <StateNotice
        settings={settings}
        canUpdate={canUpdate}
        onScore={() => setScoring(true)}
      />
      <RouterDetails settings={settings} />
      <RouterFigures settings={settings} />
      {pastSessions}
      <ScorePastSessionsDialog
        open={scoring}
        onOpenChange={setScoring}
        routerName={settings.name}
      />
    </div>
  );
}

/** Why the figures below are empty, or why the last fit did not replace them. */
function StateNotice({
  settings,
  canUpdate,
  onScore,
}: {
  settings: AutoRouter;
  canUpdate: boolean;
  onScore: () => void;
}) {
  const { activePlan, lastFitError } = settings.status;
  if (lastFitError) {
    const fitError = describeFitError(lastFitError);
    return (
      <InlineNotice variant="error" data-testid="auto-routing-fit-failed">
        <AlertTriangle />
        <span className="font-medium">Last fit failed</span>
        <InlineNoticeText>
          {fitError.message}
          {fitError.code && (
            <span className="ml-1 font-mono text-xs">({fitError.code})</span>
          )}
        </InlineNoticeText>
      </InlineNotice>
    );
  }
  if (activePlan) return null;
  const { coldStart } = settings.status;
  const state = coldStartState(coldStart);
  return (
    <InlineNotice
      variant="info"
      data-testid="auto-routing-evaluating"
      data-state={state}
    >
      <Hourglass />
      <InlineNoticeBody>
        <span className="font-medium">{COLD_START_TITLES[state]}</span>
        <InlineNoticeText className="space-y-1.5">
          <ColdStartText settings={settings} state={state} />
        </InlineNoticeText>
      </InlineNoticeBody>
      {canUpdate && settings.readsPastSessions && (
        <ScoreOfferAction onScore={onScore} />
      )}
    </InlineNotice>
  );
}

const COLD_START_TITLES: Record<ReturnType<typeof coldStartState>, string> = {
  waiting: "Waiting for traffic",
  learning: "Learning from sessions",
  building: "Building the plan",
};

function ColdStartText({
  settings,
  state,
}: {
  settings: AutoRouter;
  state: ReturnType<typeof coldStartState>;
}) {
  const { data } = useAutoRoutingBackfill();
  const { coldStart } = settings.status;
  switch (state) {
    case "waiting": {
      const offer = data?.scoreOffer;
      const pastCanStart =
        settings.readsPastSessions &&
        !!offer &&
        offer.usableSessions >= data.pastSessionsNeeded;
      return (
        <span>
          No sessions yet. The router learns from requests sent to{" "}
          <code>{settings.name}</code>
          {pastCanStart && (
            <span>, and from past sessions once they are scored</span>
          )}
          . Until then, sessions use the normal model.
        </span>
      );
    }
    case "learning":
      return (
        <>
          <span data-testid="auto-routing-cold-start-progress">
            {coldStartProgress(coldStart)}
          </span>
          <Progress
            aria-label="Sessions toward the first plan"
            value={(coldStart.sessions / coldStart.required) * 100}
          />
          <span className="block">
            A session counts once it has been idle for a day. Until the plan is
            set, sessions use the normal model.
          </span>
        </>
      );
    case "building":
      return (
        <span>
          Enough sessions are counted; the first plan is built at the next fit.
          Until then, sessions use the normal model.
        </span>
      );
  }
}

/**
 * The same card in every state, so scoring is always found in one place. A
 * router that does not read past sessions shows it while the organization's
 * job runs, so the job can be stopped from any router.
 */
function PastSessionsCard({
  settings,
  canUpdate,
}: {
  settings: AutoRouter;
  canUpdate: boolean;
}) {
  const { data } = useAutoRoutingBackfill();
  if (settings.readsPastSessions || data?.backfill?.status === "running") {
    return (
      <PastSessions
        routingEnabled={settings.enabled}
        canUpdate={canUpdate}
        routerName={settings.name}
      />
    );
  }
  return settings.learnFromPastSessions && <PastSessionsUnreadable />;
}

/** Scoring past sessions warms the router up while there are some left to score and a key to pay. */
function ScoreOfferAction({ onScore }: { onScore: () => void }) {
  const { data } = useAutoRoutingBackfill();
  const offer = data?.scoreOffer;
  if (
    !offer ||
    offer.remaining === 0 ||
    data.backfill?.status === "running" ||
    data.payer !== "ready"
  ) {
    return null;
  }
  return (
    <span className="ml-auto">
      <Button size="xs" onClick={onScore}>
        Score past sessions
      </Button>
    </span>
  );
}

/** Set to learn from past sessions, but its decision model scores them differently. */
function PastSessionsUnreadable() {
  return (
    <InlineNotice data-testid="auto-routing-past-sessions-unreadable">
      <Info />
      <span className="font-medium">Past sessions are not used</span>
      <InlineNoticeText>
        Past sessions are scored with the default decision model, so a router
        with a custom one learns from its own sessions only.
      </InlineNoticeText>
    </InlineNotice>
  );
}

/** What the router is: its three models, budget and decision model. */
function RouterDetails({ settings }: { settings: AutoRouter }) {
  const budget = settings.budgetPreset
    ? BUDGET_PRESET_LABELS[settings.budgetPreset]
    : settings.budgetUsdPerDay === null
      ? "Not set"
      : `${formatCurrency(settings.budgetUsdPerDay)}/day`;
  return (
    <Card className="py-4" data-testid="auto-routing-details">
      <CardContent className="px-4">
        <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-3">
          {TIER_NAMES.map((tier) => (
            <Detail
              key={tier}
              label={TIER_LABELS[tier]}
              value={
                <span className="font-mono">
                  {settings.tiers[tier]?.modelId ?? "Not set"}
                </span>
              }
              note={settings.tiers[tier]?.apiKey.name}
            />
          ))}
          <Detail label="Daily budget" value={budget} />
          <Detail
            label="Decision model"
            value={
              <span className="font-mono">{settings.decisionModel.model}</span>
            }
            note={settings.status.scorerApiKey?.name}
          />
        </dl>
      </CardContent>
    </Card>
  );
}

function Detail({
  label,
  value,
  note,
}: {
  label: string;
  value: React.ReactNode;
  note?: string;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-muted-foreground text-xs uppercase tracking-wide">
        {label}
      </dt>
      <dd className="truncate text-sm">{value}</dd>
      {note && (
        <dd className="truncate text-xs text-muted-foreground">{note}</dd>
      )}
    </div>
  );
}
