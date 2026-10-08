"use client";

import { DocsPage, getDocsUrl } from "@archestra/shared";
import { Info } from "lucide-react";
import { useMemo } from "react";
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
  const cap = spendCap
    ? `${formatWholeDollars(spendCap.limitValue)}${PERIOD_SUFFIXES[spendCap.cleanupInterval]}`
    : "no cap";
  return `${billingTeamName ?? payer} · ${cap}`;
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
}) {
  const teams = useBillableTeams(billingTeamId);
  const team = teams.find((option) => option.id === billingTeamId) ?? null;
  const interval = spendCap?.cleanupInterval ?? "calendar_month";

  return (
    <div className="space-y-5">
      {showBillingTeam && (
        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-billing-team`}>
            Who pays for this {subject}?
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
                Costs and limits count this {subject}'s usage for {team.name}.
                The owner's personal limit does not apply.
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
      )}

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
        <div className="flex flex-wrap items-center gap-2">
          <InputGroup className="w-36">
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
          <Select
            value={interval}
            disabled={capLocked || !spendCap}
            onValueChange={(value) =>
              spendCap &&
              onSpendCapChange({
                ...spendCap,
                cleanupInterval: value as LimitCleanupInterval,
              })
            }
          >
            <SelectTrigger aria-label="Cap resets" className="w-44">
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
        </div>
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
  const reserved = Math.min(
    spendCap?.limitValue ?? 0,
    Math.max(total - used, 0),
  );
  const left = Math.max(total - used - reserved, 0);
  const pct = (value: number) => `${total > 0 ? (value / total) * 100 : 0}%`;
  const window = describeWindow(
    (teamLimit.cleanupInterval ?? "calendar_month") as LimitCleanupInterval,
  );

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
        <div className="bg-foreground/35" style={{ width: pct(reserved) }} />
      </div>
      <dl className="grid grid-cols-3 gap-2 text-xs">
        <LegendItem swatch="bg-foreground" label="Used" value={used} />
        <LegendItem
          swatch="bg-foreground/35"
          label={`This ${subject}, at most`}
          value={spendCap?.limitValue ?? null}
        />
        <LegendItem swatch="bg-muted" label="Left" value={left} />
      </dl>
      <p className="text-xs text-muted-foreground">
        <span>
          The team limit still applies. The {subject} stops at whichever limit
          it reaches first.
        </span>
      </p>
    </div>
  );
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
