"use client";

import { AlertTriangle, Hourglass, Info } from "lucide-react";
import { useState } from "react";
import { QueryLoadError } from "@/components/query-load-error";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
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
      <ScorePastSessionsDialog open={scoring} onOpenChange={setScoring} />
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
      <InlineNotice variant="error">
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
  return (
    <InlineNotice variant="info" data-testid="auto-routing-evaluating">
      <Hourglass />
      <span className="font-medium">Evaluating sessions</span>
      <InlineNoticeText>
        Spend and quality figures appear once enough sessions are scored. Until
        then, sessions use the normal model.
      </InlineNoticeText>
      {canUpdate && settings.readsPastSessions && (
        <ScoreOfferAction onScore={onScore} />
      )}
    </InlineNotice>
  );
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
      <PastSessions routingEnabled={settings.enabled} canUpdate={canUpdate} />
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
