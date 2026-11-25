"use client";

import { ArrowRight, Info } from "lucide-react";
import type { ReactNode, Ref } from "react";
import { useImperativeHandle, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import { useHasPermissions } from "@/lib/auth/auth.query";
import {
  type UserLimitUsage,
  type UserLimitUsageSummary,
  useDefaultUserLimits,
  useResetUserLimitUsage,
  useUserLimitUsageTop,
} from "@/lib/default-user-limit.query";
import { useEnvironments } from "@/lib/environment.query";
import { cn } from "@/lib/utils/tailwind";
import {
  CustomLimitDialog,
  RemoveCustomLimitDialog,
  type ResetTarget,
  ResetUsageDialog,
} from "./user-limit-dialogs";
import { RosterSheet } from "./user-limits-roster";
import {
  AFFECTED_STACK_SIZE,
  ALL_ENVIRONMENTS,
  type DotItem,
  DotList,
  formatLimit,
  formatUsd,
  LINK_CLASS,
  pluralUsers,
  type RosterFilter,
  type RosterOpen,
  STATUS_META,
  UNLIMITED_DOT,
  UserAvatar,
  type UserLimitStatus,
} from "./user-limits-shared";

/** Lets the limits table open the users drawer, e.g. for one environment. */
export type UserLimitsOverviewHandle = {
  openRoster: (options: RosterOpen) => void;
};

/**
 * Who is at or near their personal limit, in one line above the limits table,
 * with a drawer listing every user's usage. The limits themselves, default
 * user limits included, are rows of the table rendered below it.
 */
export function UserLimitsOverview({
  enabled = true,
  limitsTable,
  ref,
}: {
  enabled?: boolean;
  limitsTable: ReactNode;
  ref?: Ref<UserLimitsOverviewHandle>;
}) {
  return enabled ? (
    <OrganizationUserLimitsOverview limitsTable={limitsTable} ref={ref} />
  ) : (
    limitsTable
  );
}

function OrganizationUserLimitsOverview({
  limitsTable,
  ref,
}: {
  limitsTable: ReactNode;
  ref?: Ref<UserLimitsOverviewHandle>;
}) {
  const { data: defaults = [] } = useDefaultUserLimits();
  const { data: environmentList } = useEnvironments();
  const environments = environmentList?.environments ?? [];
  const { data: top } = useUserLimitUsageTop(AFFECTED_STACK_SIZE);
  const { data: canUpdate } = useHasPermissions({ llmLimit: ["update"] });
  const { data: canCreate } = useHasPermissions({ llmLimit: ["create"] });
  const { data: canDelete } = useHasPermissions({ llmLimit: ["delete"] });
  const canManageUsers = Boolean(canUpdate && canCreate && canDelete);
  const resetUsage = useResetUserLimitUsage();

  const [sheetOpen, setSheetOpen] = useState(false);
  const [filter, setFilter] = useState<RosterFilter>("all");
  const [environmentFilter, setEnvironmentFilter] =
    useState<string>(ALL_ENVIRONMENTS);
  const [search, setSearch] = useState("");
  const [focusId, setFocusId] = useState<string | null>(null);

  const [resetTarget, setResetTarget] = useState<
    | (ResetTarget & { filters?: { environmentId?: string; search?: string } })
    | null
  >(null);
  const [customLimitRow, setCustomLimitRow] = useState<UserLimitUsage | null>(
    null,
  );
  const [removeRow, setRemoveRow] = useState<UserLimitUsage | null>(null);

  const summary = top?.summary;
  const orgDefault = defaults.find((d) => d.environmentId === null);

  const openRoster = (options: RosterOpen) => {
    setFilter(options.filter ?? "all");
    setEnvironmentFilter(options.environmentId ?? ALL_ENVIRONMENTS);
    setSearch("");
    setFocusId(options.focusId ?? null);
    setSheetOpen(true);
  };
  useImperativeHandle(ref, () => ({ openRoster }));

  const fallbackFor = (row: UserLimitUsage) =>
    (row.environmentId
      ? defaults.find((d) => d.environmentId === row.environmentId)
      : undefined) ?? orgDefault;

  return (
    <div className="space-y-4">
      <AffectedByLimits
        rows={top?.data ?? []}
        summary={summary}
        onOpen={openRoster}
      />

      <div className="space-y-3">{limitsTable}</div>

      <RosterSheet
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        environments={environments}
        environmentSummary={summary?.environments ?? []}
        totalUsers={summary?.total ?? 0}
        defaults={defaults}
        filter={filter}
        onFilterChange={(next) => {
          setFilter(next);
          setFocusId(null);
        }}
        environmentFilter={environmentFilter}
        onEnvironmentFilterChange={(next) => {
          setEnvironmentFilter(next);
          setFocusId(null);
        }}
        search={search}
        onSearchChange={(next) => {
          setSearch(next);
          setFocusId(null);
        }}
        focusId={focusId}
        canManage={canManageUsers}
        onReset={(rows) => setResetTarget({ kind: "users", rows })}
        onResetAllAtLimit={({ count, ...filters }) =>
          setResetTarget({ kind: "allAtLimit", count, filters })
        }
        onCustomLimit={setCustomLimitRow}
        onRemoveCustomLimit={setRemoveRow}
      />

      <ResetUsageDialog
        target={resetTarget}
        resetsAt={summary?.resetsAt ?? null}
        isPending={resetUsage.isPending}
        onOpenChange={(open) => {
          if (!open) setResetTarget(null);
        }}
        onConfirm={async () => {
          if (!resetTarget) return;
          await resetUsage.mutateAsync(
            resetTarget.kind === "users"
              ? { userIds: resetTarget.rows.map((row) => row.userId) }
              : { allAtLimit: resetTarget.filters ?? {} },
          );
          if (resetTarget.kind === "users" && resetTarget.rows.length === 1) {
            setFocusId(resetTarget.rows[0].userId);
          }
          setResetTarget(null);
        }}
      />

      <RemoveCustomLimitDialog
        row={removeRow}
        fallback={removeRow ? orgDefault : undefined}
        onOpenChange={(open) => {
          if (!open) setRemoveRow(null);
        }}
        onRemoved={(row) => setFocusId(row.userId)}
      />

      <CustomLimitDialog
        row={customLimitRow}
        fallback={customLimitRow ? fallbackFor(customLimitRow) : undefined}
        onOpenChange={(open) => {
          if (!open) setCustomLimitRow(null);
        }}
        onSaved={(row) => setFocusId(row.userId)}
      />
    </div>
  );
}

// ===
// Constants

/** Larger "+N" counts overflow the avatar-sized chip; show "99+" instead. */
const MAX_HIDDEN_LABEL = 99;

// ===
// Affected by Limits (organization-wide, one line)

function PrecedenceHint() {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <UnstyledButton
          aria-label="How limits apply"
          className="rounded-full text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          <Info aria-hidden className="size-3.5" />
        </UnstyledButton>
      </TooltipTrigger>
      <TooltipContent className="max-w-64">
        Every user gets the default user limit. A default user limit for their
        environment replaces it, and a custom user limit replaces both.
      </TooltipContent>
    </Tooltip>
  );
}

function AffectedByLimits({
  rows,
  summary,
  onOpen,
}: {
  /** The users closest to their limit (the API's first page). */
  rows: UserLimitUsage[];
  summary: UserLimitUsageSummary | undefined;
  onOpen: (options: RosterOpen) => void;
}) {
  const at = summary?.at ?? 0;
  const near = summary?.near ?? 0;
  const flagged = at + near;
  // With no default, the only people who can be near a limit are those on a
  // custom one. Say so, or "2 near" next to "22 with no limit" reads oddly.
  const onlyCustom = flagged > 0 && summary?.flaggedCustom === flagged;
  const suffix = onlyCustom ? " their custom limit" : "";
  const total = summary?.total ?? 0;
  const unlimited = summary?.none ?? 0;
  const allUnlimited = total > 0 && unlimited === total;
  const spent = summary?.spent ?? 0;
  const spenders = summary?.spenders ?? 0;
  // Nobody at or near a limit; with no limits at all, nobody spending either.
  const noOneAffected =
    Boolean(summary) && (allUnlimited ? spenders === 0 : flagged === 0);

  const stack = allUnlimited
    ? rows.filter((row) => row.spent > 0)
    : rows.filter((row) => row.status !== "ok");
  // The avatars stand for spenders (or flagged users), never the whole roster:
  // "All N" at the end of the line already counts everyone.
  const hidden = Math.max(
    (allUnlimited ? spenders : flagged) - stack.length,
    0,
  );

  const unlimitedItem: DotItem | null =
    unlimited > 0 && (!allUnlimited || noOneAffected)
      ? {
          key: "unlimited",
          node: (
            <UnstyledButton
              onClick={() => onOpen({ filter: "none" })}
              className={cn("tabular-nums", LINK_CLASS)}
            >
              {`${pluralUsers(unlimited)} with no limit`}
            </UnstyledButton>
          ),
        }
      : null;
  let main: ReactNode;
  let meta: (DotItem | null)[];

  if (!summary) {
    main = <div className="h-6 w-40 animate-pulse rounded-md bg-muted" />;
    meta = [];
  } else if (noOneAffected) {
    main = null;
    meta = [unlimitedItem];
  } else if (allUnlimited) {
    main = (
      <>
        {stack.length > 0 ? (
          <AvatarStack
            rows={stack}
            hidden={hidden}
            onOpen={onOpen}
            tooltip={(row) => `${formatUsd(row.spent)} this window`}
          />
        ) : null}
        <UnstyledButton
          onClick={() => onOpen({ filter: "none" })}
          className="inline-flex w-fit items-center gap-1.5 rounded-sm text-sm hover:underline hover:underline-offset-4 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <span
            aria-hidden
            className={cn("size-2 rounded-full", UNLIMITED_DOT)}
          />
          <span className="font-medium tabular-nums">
            {spenders.toLocaleString("en-US")}
          </span>
          <span className="text-muted-foreground">
            spending without a limit
          </span>
        </UnstyledButton>
      </>
    );
    meta = [
      stack.length > 0 ? { key: "top", node: <span>Top spenders</span> } : null,
      {
        key: "spent",
        node: (
          <span className="tabular-nums">{`${formatUsd(spent)} spent this window`}</span>
        ),
      },
    ];
  } else {
    main = (
      <>
        <AvatarStack
          rows={stack}
          hidden={hidden}
          onOpen={onOpen}
          tooltip={(row) =>
            `${formatUsd(row.spent)} of ${formatLimit(row.limitValue ?? 0)} · ${Math.round(row.percent ?? 0)}%`
          }
        />
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          {at > 0 ? (
            <StatusLink
              count={at}
              label={onlyCustom ? "at their custom limit" : "at limit"}
              status="at"
              onClick={() => onOpen({ filter: "at" })}
            />
          ) : null}
          {near > 0 ? (
            <StatusLink
              count={near}
              label={`near${suffix}`}
              status="near"
              onClick={() => onOpen({ filter: "near" })}
            />
          ) : null}
        </div>
      </>
    );
    meta = [unlimitedItem];
  }

  return (
    <section
      aria-labelledby="user-limits-affected"
      className="flex min-h-13 flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border bg-muted/30 px-4 py-2"
    >
      <div className="flex shrink-0 items-center gap-1.5">
        <h2
          id="user-limits-affected"
          className="text-sm font-medium text-muted-foreground"
        >
          {noOneAffected ? "No one affected by limits" : "Affected by Limits"}
        </h2>
        <PrecedenceHint />
      </div>
      {main ? (
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          {main}
        </div>
      ) : null}
      <DotList className="text-xs text-muted-foreground" items={meta} />
      {total > 0 ? (
        <Button
          variant="ghost"
          size="xs"
          className="-mr-2 ml-auto shrink-0 text-muted-foreground"
          onClick={() => onOpen({})}
        >
          <span>Users and their limits</span>
          <ArrowRight aria-hidden />
        </Button>
      ) : null}
    </section>
  );
}

function AvatarStack({
  rows,
  hidden,
  onOpen,
  tooltip,
}: {
  rows: UserLimitUsage[];
  hidden: number;
  onOpen: (options: RosterOpen) => void;
  tooltip: (row: UserLimitUsage) => string;
}) {
  return (
    <div className="flex shrink-0 items-center -space-x-1.5 py-1 pl-1">
      {rows.map((row) => (
        <Tooltip key={row.userId}>
          <TooltipTrigger asChild>
            <UnstyledButton
              onClick={() => onOpen({ focusId: row.userId })}
              aria-label={`${row.name}, ${tooltip(row)}`}
              className="relative rounded-full transition-transform hover:z-10 hover:-translate-y-0.5 focus-visible:z-10 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              <UserAvatar row={row} className="size-8" ringed />
            </UnstyledButton>
          </TooltipTrigger>
          <TooltipContent>
            <p className="font-medium">{row.name}</p>
            <p className="tabular-nums text-muted-foreground">{tooltip(row)}</p>
          </TooltipContent>
        </Tooltip>
      ))}
      {hidden > 0 ? (
        <UnstyledButton
          onClick={() => onOpen({})}
          aria-label={`${hidden.toLocaleString("en-US")} more users`}
          className="relative flex size-8 items-center justify-center rounded-full border-2 border-card bg-muted text-xs font-medium tabular-nums hover:bg-accent focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          {hidden > MAX_HIDDEN_LABEL ? `${MAX_HIDDEN_LABEL}+` : `+${hidden}`}
        </UnstyledButton>
      ) : null}
    </div>
  );
}

function StatusLink({
  count,
  label,
  status,
  onClick,
}: {
  count: number;
  label: string;
  status: UserLimitStatus;
  onClick: () => void;
}) {
  return (
    <UnstyledButton
      onClick={onClick}
      className="inline-flex items-center gap-1.5 rounded-sm hover:underline hover:underline-offset-4 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
    >
      <span
        aria-hidden
        className={cn("size-2 rounded-full", STATUS_META[status].dot)}
      />
      <span className="font-medium tabular-nums">
        {count.toLocaleString("en-US")}
      </span>
      <span className="text-muted-foreground">{label}</span>
    </UnstyledButton>
  );
}
