"use client";

import { DocsPage, getDocsUrl } from "@archestra/shared";
import { Info } from "lucide-react";
import { useMemo, useState } from "react";
import {
  CLEANUP_INTERVAL_LABELS,
  type LimitCleanupInterval,
} from "@/components/limit-cleanup-interval-select";
import { TeamSelect } from "@/components/team-select";
import { Badge } from "@/components/ui/badge";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
} from "@/components/ui/input-group";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { useLimits } from "@/lib/limits.query";
import { useMyTeams, useTeams } from "@/lib/teams/team.query";
import { formatCurrency } from "@/lib/utils/format-currency";
import { cn } from "@/lib/utils/tailwind";

export type SpendCapValue = {
  limitValue: number;
  cleanupInterval: LimitCleanupInterval;
} | null;

/** "this month", "this week", … for the window a limit resets on. */
export function describeWindow(interval: LimitCleanupInterval): string {
  return WINDOW_DESCRIPTIONS[interval];
}

/** "Platform · $500/month" for a credential's budget nav line. */
export function summarizeBudget({
  billingTeamName,
  spendCap,
  payer = "No team",
}: {
  billingTeamName: string | null;
  spendCap: SpendCapValue;
  /** Who pays when no team does. */
  payer?: string;
}): string {
  const cap = spendCap ? formatSpendCap(spendCap) : "no cap";
  return `${billingTeamName ?? payer} · ${cap}`;
}

/** "$500/month" for a credential's spend cap. */
export function formatSpendCap(spendCap: NonNullable<SpendCapValue>): string {
  return `${formatWholeDollars(spendCap.limitValue)}${PERIOD_SUFFIXES[spendCap.cleanupInterval]}`;
}

/**
 * Who pays for a credential and how much it may spend: the K3 budget layout
 * shared by virtual keys and LLM OAuth clients.
 *
 * - The billing team replaces the LLM proxy's teams for this credential's
 *   spend, and the owner's personal limit no longer applies.
 * - The spend cap is an ordinary limit on the credential. When a team pays,
 *   the team's own limit still applies, so a bar shows how the cap fits in it.
 */
export function BudgetFields({
  subject,
  billingTeamId,
  onBillingTeamIdChange,
  spendCap,
  onSpendCapChange,
  showBillingTeam = true,
  capLocked = false,
  currentUsage = null,
  idPrefix,
  layout = "card",
}: {
  /** What is being billed, for the copy: "key" or "client". */
  subject: "key" | "client";
  billingTeamId: string | null;
  onBillingTeamIdChange: (teamId: string | null) => void;
  spendCap: SpendCapValue;
  onSpendCapChange: (cap: SpendCapValue) => void;
  /** False for an authorization-code client, whose users pay for themselves. */
  showBillingTeam?: boolean;
  /** True when the caller may not change an existing cap. */
  capLocked?: boolean;
  /** Spend counted against the saved cap so far in its window. */
  currentUsage?: number | null;
  idPrefix: string;
  /**
   * "inline" is the create dialog's: a "Budget" heading over the payer and
   * two labelled cap fields, with no card around the cap.
   */
  layout?: "card" | "inline";
}) {
  const teams = useBillableTeams(billingTeamId);
  const team = teams.find((option) => option.id === billingTeamId) ?? null;
  // The period can be picked before an amount is typed, so it is kept here
  // until the cap exists to carry it.
  const [chosenInterval, setChosenInterval] =
    useState<LimitCleanupInterval>("calendar_month");
  const interval = spendCap?.cleanupInterval ?? chosenInterval;

  const payerLabel =
    layout === "inline" ? "Who pays" : `Who pays for this ${subject}?`;
  const payer = showBillingTeam && (
    <div className={layout === "inline" ? "space-y-1.5" : "space-y-2"}>
      <Label
        htmlFor={`${idPrefix}-billing-team`}
        className={cn(
          layout === "inline" && "font-normal text-muted-foreground text-xs",
        )}
      >
        {payerLabel}
      </Label>
      <TeamSelect
        id={`${idPrefix}-billing-team`}
        ariaLabel={`Who pays for this ${subject}?`}
        className="w-full"
        value={billingTeamId}
        onValueChange={onBillingTeamIdChange}
        teams={teams}
        noneOption={{
          label: "No team",
          description:
            "Usage counts toward the LLM proxy's teams and the owner's limits.",
        }}
      />
      <p className="text-xs text-muted-foreground">
        {team ? (
          <span>
            Costs and limits count this {subject}'s usage for {team.name}. The
            owner's personal limit does not apply.
          </span>
        ) : (
          <span>
            Pick a team to charge its budget for everything this {subject}{" "}
            spends.{" "}
            <a
              className="underline underline-offset-2"
              href={getDocsUrl(DocsPage.PlatformCostsAndLimits)}
              target="_blank"
              rel="noreferrer"
            >
              Costs and limits
            </a>
          </span>
        )}
      </p>
    </div>
  );
  const capInput = (
    <InputGroup className="w-full">
      <InputGroupAddon>
        <InputGroupText>$</InputGroupText>
      </InputGroupAddon>
      <InputGroupInput
        id={`${idPrefix}-spend-cap`}
        aria-label="Spend cap in dollars"
        inputMode="numeric"
        placeholder="No cap"
        disabled={capLocked}
        value={spendCap ? String(spendCap.limitValue) : ""}
        onChange={(event) => {
          const digits = event.target.value.replace(/[^0-9]/g, "");
          const amount = Number.parseInt(digits, 10);
          onSpendCapChange(
            digits && amount > 0
              ? { limitValue: amount, cleanupInterval: interval }
              : null,
          );
        }}
      />
    </InputGroup>
  );
  const periodSelect = (
    <Select
      value={interval}
      disabled={capLocked}
      onValueChange={(value) => {
        const next = value as LimitCleanupInterval;
        setChosenInterval(next);
        if (spendCap) onSpendCapChange({ ...spendCap, cleanupInterval: next });
      }}
    >
      <SelectTrigger
        id={`${idPrefix}-cap-resets`}
        aria-label="Cap resets"
        className="w-full"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {CAP_PERIODS.map((period) => (
          <SelectItem key={period} value={period}>
            {PERIOD_LABELS[period]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
  const capNotes = (
    <>
      {currentUsage !== null && spendCap && (
        <p className="text-xs text-muted-foreground">
          <span>
            {formatWholeDollars(currentUsage)} spent{" "}
            {describeWindow(spendCap.cleanupInterval)}.
          </span>
        </p>
      )}
      {capLocked && (
        <p className="text-xs text-muted-foreground">
          <span>
            Ask someone who manages limits to change or remove this cap.
          </span>
        </p>
      )}
      {team && (
        <TeamUsageBar team={team} spendCap={spendCap} subject={subject} />
      )}
    </>
  );

  if (layout === "inline") {
    return (
      <section aria-label="Budget" className="space-y-3">
        <div className="font-medium text-sm">
          Budget{" "}
          <span className="font-normal text-muted-foreground">· optional</span>
        </div>
        {payer}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label
              htmlFor={`${idPrefix}-spend-cap`}
              className="font-normal text-muted-foreground text-xs"
            >
              Spend cap for this {subject}
            </Label>
            {capInput}
          </div>
          <div className="space-y-1.5">
            <Label
              htmlFor={`${idPrefix}-cap-resets`}
              className="font-normal text-muted-foreground text-xs"
            >
              Cap resets
            </Label>
            {periodSelect}
          </div>
        </div>
        {capNotes}
      </section>
    );
  }

  return (
    <div className="space-y-5">
      {payer}
      <fieldset className="space-y-3 rounded-lg border p-4">
        <legend className="sr-only">Spend cap for this {subject}</legend>
        <div className="flex items-center justify-between gap-2">
          <span className="font-medium text-sm">
            Spend cap for this {subject === "key" ? "key" : "client"}
          </span>
          <Badge
            variant="outline"
            className="font-normal text-muted-foreground"
          >
            Optional
          </Badge>
        </div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {capInput}
          {periodSelect}
        </div>
        {capNotes}
      </fieldset>
    </div>
  );
}

/** Info shown in place of the billing team for clients whose users pay. */
export function UsersPayNotice() {
  return (
    <InlineNotice variant="info">
      <Info />
      <span className="font-medium">Each signed-in user pays</span>
      <InlineNoticeText>
        Usage counts toward each user's own limits and the LLM proxy's teams. A
        cap here limits all users of this client together.
      </InlineNoticeText>
    </InlineNotice>
  );
}

// =========================================================================
// Team usage
// =========================================================================

function TeamUsageBar({
  team,
  spendCap,
  subject,
}: {
  team: { id: string; name: string };
  spendCap: SpendCapValue;
  subject: "key" | "client";
}) {
  const { data: canReadLimits } = useHasPermissions({ llmLimit: ["read"] });
  const { data: limits } = useLimits({ enabled: !!canReadLimits });
  const teamLimit = useMemo(
    () =>
      (limits ?? []).find(
        (limit) =>
          limit.entityType === "team" &&
          limit.entityId === team.id &&
          limit.limitType === "token_cost" &&
          !limit.model?.length,
      ),
    [limits, team.id],
  );

  if (!teamLimit) {
    return (
      <p className="text-xs text-muted-foreground">
        <span>
          {canReadLimits
            ? `${team.name} has no spend limit. This ${subject} stops only at its own cap.`
            : `${team.name}'s own limits still apply.`}
        </span>
      </p>
    );
  }

  const used = (teamLimit.modelUsage ?? []).reduce(
    (sum, usage) => sum + usage.cost,
    0,
  );
  const total = teamLimit.limitValue;
  const teamInterval = (teamLimit.cleanupInterval ??
    "calendar_month") as LimitCleanupInterval;
  const left = Math.max(total - used, 0);
  // The cap fits inside the team's bar only when both reset on the same
  // window. Otherwise their amounts measure different periods.
  const sameWindow = !!spendCap && spendCap.cleanupInterval === teamInterval;
  const keyMost = sameWindow ? Math.min(spendCap.limitValue, left) : 0;
  const pct = (value: number) => `${total > 0 ? (value / total) * 100 : 0}%`;
  const window = describeWindow(teamInterval);

  return (
    <div className="space-y-2 border-t pt-3">
      <div className="flex justify-between text-xs">
        <span className="font-medium">
          {team.name} {window}
        </span>
        <span className="text-muted-foreground">
          {formatWholeDollars(total)} limit
        </span>
      </div>
      <div
        className="flex h-2 overflow-hidden rounded-full bg-muted"
        role="img"
        aria-label={`${team.name} has used ${formatWholeDollars(used)} of ${formatWholeDollars(total)} ${window}`}
      >
        <div
          className="bg-foreground"
          style={{ width: pct(Math.min(used, total)) }}
        />
        {sameWindow && (
          <div className="bg-foreground/35" style={{ width: pct(keyMost) }} />
        )}
      </div>
      <dl
        className={cn(
          "grid gap-2 text-xs",
          sameWindow ? "grid-cols-3" : "grid-cols-2",
        )}
      >
        <LegendItem swatch="bg-foreground" label="Used" value={used} />
        {sameWindow && (
          <LegendItem
            swatch="bg-foreground/35"
            label={`This ${subject}, at most`}
            value={keyMost}
          />
        )}
        <LegendItem swatch="bg-muted" label="Team has left" value={left} />
      </dl>
      <p className="text-xs text-muted-foreground">
        <span>
          {describeCapAgainstTeam({
            subject,
            spendCap,
            sameWindow,
            left,
            teamName: team.name,
            teamLimit: `${formatWholeDollars(total)}${PERIOD_SUFFIXES[teamInterval]}`,
            window,
          })}
        </span>
      </p>
    </div>
  );
}

/** The sentence under the team bar that relates the cap to the team limit. */
function describeCapAgainstTeam({
  subject,
  spendCap,
  sameWindow,
  left,
  teamName,
  teamLimit,
  window,
}: {
  subject: "key" | "client";
  spendCap: SpendCapValue;
  sameWindow: boolean;
  left: number;
  teamName: string;
  teamLimit: string;
  window: string;
}): string {
  const first = `The ${subject} stops at whichever limit it reaches first.`;
  if (!spendCap) {
    return `The ${subject} can spend what ${teamName} has left ${window}.`;
  }
  if (!sameWindow) {
    return `This ${subject}'s cap (${formatWholeDollars(spendCap.limitValue)}${PERIOD_SUFFIXES[spendCap.cleanupInterval]}) and ${teamName}'s limit (${teamLimit}) reset on different periods. ${first}`;
  }
  if (spendCap.limitValue > left) {
    return `${teamName} has less left ${window} than this ${subject}'s cap, so the team limit stops it first.`;
  }
  return `The team limit still applies. ${first}`;
}

function LegendItem({
  swatch,
  label,
  value,
}: {
  swatch: string;
  label: string;
  value: number | null;
}) {
  return (
    <div className="space-y-0.5">
      <dt className="flex items-center gap-1.5 text-muted-foreground">
        <span className={cn("size-2 rounded-full border", swatch)} />
        <span>{label}</span>
      </dt>
      <dd className="font-medium tabular-nums">
        {value === null ? "No cap" : formatWholeDollars(value)}
      </dd>
    </div>
  );
}

// =========================================================================
// Teams
// =========================================================================

/**
 * Teams the current user may bill: every team for cost managers, otherwise
 * the teams they administer. The current billing team stays listed so an
 * edit never shows a blank value.
 */
function useBillableTeams(currentTeamId: string | null) {
  const { data: isCostManager } = useHasPermissions({ llmLimit: ["update"] });
  const { data: session } = useSession();
  const userId = session?.user?.id;
  const { data: allTeams = [] } = useTeams({ enabled: !!isCostManager });
  const { data: myTeams = [] } = useMyTeams({ enabled: !isCostManager });
  return useMemo(() => {
    const candidates = isCostManager
      ? allTeams
      : myTeams.filter(
          (team) =>
            team.id === currentTeamId ||
            !team.members ||
            team.members.some(
              (member) => member.userId === userId && member.role === "admin",
            ),
        );
    return [...candidates].sort((a, b) => a.name.localeCompare(b.name));
  }, [allTeams, currentTeamId, isCostManager, myTeams, userId]);
}

const CAP_PERIODS: LimitCleanupInterval[] = [
  "calendar_month",
  "calendar_week_monday",
  "calendar_day",
  "1m",
  "1w",
  "24h",
];

const PERIOD_LABELS: Record<LimitCleanupInterval, string> = {
  ...CLEANUP_INTERVAL_LABELS,
  calendar_month: "Every month",
  calendar_week_monday: "Every week",
  calendar_week_sunday: "Every week (from Sunday)",
  calendar_day: "Every day",
  "1m": "Rolling 30 days",
  "1w": "Rolling 7 days",
  "24h": "Rolling 24 hours",
};

const PERIOD_SUFFIXES: Record<LimitCleanupInterval, string> = {
  calendar_month: "/month",
  calendar_week_monday: "/week",
  calendar_week_sunday: "/week",
  calendar_day: "/day",
  "1m": " per 30 days",
  "1w": " per 7 days",
  "24h": " per 24h",
  "12h": " per 12h",
  "1h": " per hour",
};

const WINDOW_DESCRIPTIONS: Record<LimitCleanupInterval, string> = {
  calendar_month: "this month",
  calendar_week_monday: "this week",
  calendar_week_sunday: "this week",
  calendar_day: "today",
  "1m": "in the last 30 days",
  "1w": "in the last 7 days",
  "24h": "in the last 24 hours",
  "12h": "in the last 12 hours",
  "1h": "in the last hour",
};

function formatWholeDollars(value: number): string {
  return Number.isInteger(value)
    ? `$${value.toLocaleString("en-US")}`
    : formatCurrency(value);
}
