"use client";

import {
  ArrowRight,
  Boxes,
  Check,
  ChevronDown,
  Info,
  Pencil,
  Plus,
  Search,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import type { KeyboardEvent, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import { useHasPermissions } from "@/lib/auth/auth.query";
import {
  type DefaultUserLimit,
  type UserLimitUsage,
  type UserLimitUsageSummary,
  useDefaultUserLimits,
  useResetUserLimitUsage,
  useUserLimitUsageTop,
} from "@/lib/default-user-limit.query";
import { useEnvironments } from "@/lib/environment.query";
import { cn } from "@/lib/utils/tailwind";
import {
  DefaultLimitDialog,
  DeleteDefaultLimitDialog,
} from "./default-limit-dialogs";
import {
  CustomLimitDialog,
  RemoveCustomLimitDialog,
  type ResetTarget,
  ResetUsageDialog,
} from "./user-limit-dialogs";
import { RosterSheet } from "./user-limits-roster";
import {
  ALL_ENVIRONMENTS,
  type DotItem,
  DotList,
  formatLimit,
  formatRelative,
  formatUsd,
  intervalLabel,
  LINK_CLASS,
  modelCountLabel,
  pluralUsers,
  ROW_ACTION_CLASS,
  type RosterFilter,
  type RosterOpen,
  STATUS_META,
  UNLIMITED_DOT,
  UserAvatar,
  type UserLimitStatus,
} from "./user-limits-shared";

/**
 * Per-user limits at the top of the Limits page: the default user limit
 * (organization-wide, with per-environment overrides) next to who is at or
 * near their limit, with a drawer listing every user's usage. The explicit
 * limits table renders below it.
 */
export function UserLimitsOverview({
  limitsTable,
}: {
  limitsTable: ReactNode;
}) {
  const { data: defaults = [] } = useDefaultUserLimits();
  const { data: environmentList } = useEnvironments();
  const environments = environmentList?.environments ?? [];
  const { data: top } = useUserLimitUsageTop(MAX_STACK);
  const { data: canUpdate } = useHasPermissions({ llmLimit: ["update"] });
  const { data: canCreate } = useHasPermissions({ llmLimit: ["create"] });
  const { data: canDelete } = useHasPermissions({ llmLimit: ["delete"] });
  const canManageUsers = Boolean(canUpdate && canCreate && canDelete);
  const resetUsage = useResetUserLimitUsage();

  const [overridesOpen, setOverridesOpen] = useState(false);

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

  // Every default is created, edited and deleted through the shared dialogs.
  const [editor, setEditor] = useState<EditorState>({ editing: null });
  const [editorOpen, setEditorOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<DefaultUserLimit | null>(
    null,
  );

  const summary = top?.summary;
  const orgDefault = defaults.find((d) => d.environmentId === null);
  const overrides = buildOverrides({
    environments,
    defaults,
    summary: summary?.environments ?? [],
  });
  const canAddOverride = environments.some(
    (env) => !defaults.some((d) => d.environmentId === env.id),
  );

  const openRoster = (options: RosterOpen) => {
    setFilter(options.filter ?? "all");
    setEnvironmentFilter(options.environmentId ?? ALL_ENVIRONMENTS);
    setSearch("");
    setFocusId(options.focusId ?? null);
    setSheetOpen(true);
  };

  const openEditor = (next: EditorState) => {
    setEditor(next);
    setEditorOpen(true);
  };
  const editDefault = (d: DefaultUserLimit) => openEditor({ editing: d });
  /** `undefined` leaves the dialog's environment picker empty. */
  const newDefault = (environmentId: string | null | undefined) =>
    openEditor({ editing: null, initialEnvironmentId: environmentId });

  const fallbackFor = (row: UserLimitUsage) =>
    (row.environmentId
      ? defaults.find((d) => d.environmentId === row.environmentId)
      : undefined) ?? orgDefault;

  return (
    <div className="space-y-5">
      <Card className="gap-0 overflow-hidden py-0">
        <div className="grid items-stretch lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
          <section
            aria-labelledby="user-limits-default"
            className="flex min-w-0 flex-col gap-3 px-4 py-3.5 sm:px-5 sm:py-4"
          >
            <div className="flex h-7 items-center justify-between gap-3">
              <div className="flex items-center gap-1.5">
                <h2
                  id="user-limits-default"
                  className="text-sm font-medium text-muted-foreground"
                >
                  Default user limit
                </h2>
                <PrecedenceHint />
              </div>
              <EnvironmentOverrides
                overrides={overrides}
                orgDefault={orgDefault}
                canAdd={canAddOverride && Boolean(canCreate)}
                canEdit={Boolean(canUpdate)}
                canDelete={Boolean(canDelete)}
                hasEnvironments={environments.length > 0}
                open={overridesOpen}
                onOpenChange={setOverridesOpen}
                onView={(environmentId) => openRoster({ environmentId })}
                onEdit={editDefault}
                onDelete={setDeleteTarget}
                onAdd={() => newDefault(undefined)}
              />
            </div>

            <OrgLimit
              orgDefault={orgDefault}
              summary={summary}
              canCreate={Boolean(canCreate)}
              canEdit={Boolean(canUpdate)}
              onEdit={editDefault}
              onSet={() => newDefault(null)}
              onOpenCustom={() => openRoster({ filter: "custom" })}
              onOpenUncapped={() => openRoster({ filter: "none" })}
            />
          </section>

          <WhoIsAffected
            rows={top?.data ?? []}
            summary={summary}
            onOpen={openRoster}
          />
        </div>
      </Card>

      <section aria-labelledby="explicit-limits" className="space-y-3">
        <div className="space-y-1">
          <h2 id="explicit-limits" className="text-base font-semibold">
            Explicit limits
          </h2>
          <p className="text-sm text-muted-foreground">
            Limits set on the organization, teams, agents, users and keys. Each
            one applies on top of the default user limit.
          </p>
        </div>
        {limitsTable}
      </section>

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

      <DefaultLimitDialog
        open={editorOpen}
        onOpenChange={setEditorOpen}
        editing={editor.editing}
        initialEnvironmentId={editor.initialEnvironmentId}
        defaults={defaults}
        environments={environments}
      />

      <DeleteDefaultLimitDialog
        target={deleteTarget}
        orgDefault={orgDefault}
        environments={environments}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
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
// Types and constants

/** `editing` null = add; `initialEnvironmentId` preselects the scope then. */
type EditorState = {
  editing: DefaultUserLimit | null;
  initialEnvironmentId?: string | null;
};

/** An environment with its own default, which overrides the org default. */
type EnvironmentOverride = {
  environmentId: string;
  name: string;
  limit: DefaultUserLimit;
  users: number;
  at: number;
  near: number;
};

/** Avatars before "+N", sized so the counts still fit on the same row. */
const MAX_STACK = 4;

/** Above this many overrides the overrides list gets a search field. */
const SEARCH_THRESHOLD = 4;

const QUIET_ACTION_CLASS =
  "rounded-sm font-medium text-foreground/80 underline-offset-4 hover:text-foreground hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none";

// ===
// Header controls

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
        Every user gets the organization default. An environment override
        replaces it for users in that environment, and a custom user limit
        replaces both.
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * The environment overrides, managed from one popover: each row opens the
 * drawer for that environment and carries its own Edit and Delete buttons,
 * and the footer adds another override.
 */
function EnvironmentOverrides({
  overrides,
  orgDefault,
  canAdd,
  canEdit,
  canDelete,
  hasEnvironments,
  open,
  onOpenChange,
  onView,
  onEdit,
  onDelete,
  onAdd,
}: {
  overrides: EnvironmentOverride[];
  orgDefault: DefaultUserLimit | undefined;
  canAdd: boolean;
  canEdit: boolean;
  canDelete: boolean;
  hasEnvironments: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onView: (environmentId: string) => void;
  onEdit: (d: DefaultUserLimit) => void;
  onDelete: (d: DefaultUserLimit) => void;
  onAdd: () => void;
}) {
  const [query, setQuery] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  // A dialog or drawer opened from a row waits until the popover has handed
  // focus back to the trigger, so closing it returns focus there too.
  const pending = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  // The organization has no environments: explain what they would add.
  if (!hasEnvironments) return <NoEnvironmentsHint />;

  // Nothing to manage yet: the button adds the first override directly. With
  // no org default there is nothing to override, so "Set default" covers it.
  if (overrides.length === 0) {
    if (!canAdd || !orgDefault) return null;
    return (
      <Button variant="outline" size="xs" onClick={onAdd}>
        <Plus />
        <span className="sm:hidden">Override</span>
        <span className="hidden sm:inline">Environment override</span>
      </Button>
    );
  }

  const searchable = overrides.length > SEARCH_THRESHOLD;
  const needle = query.trim().toLowerCase();
  const shown = needle
    ? overrides.filter((o) => o.name.toLowerCase().includes(needle))
    : overrides;
  const count = `${overrides.length} environment ${overrides.length === 1 ? "override" : "overrides"}`;

  const handOff = (action: () => void) => {
    pending.current = action;
    onOpenChange(false);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const items = Array.from(
      containerRef.current?.querySelectorAll<HTMLElement>(
        "[data-override-row]",
      ) ?? [],
    );
    if (items.length === 0) return;
    event.preventDefault();
    const current = (document.activeElement as HTMLElement | null)
      ?.closest("li")
      ?.querySelector<HTMLElement>("[data-override-row]");
    const index = current ? items.indexOf(current) : -1;
    const next =
      event.key === "ArrowDown"
        ? (index + 1) % items.length
        : index <= 0
          ? items.length - 1
          : index - 1;
    items[next]?.focus();
  };

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="xs"
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={count}
          className="max-w-full min-w-0"
        >
          <span className="truncate tabular-nums sm:hidden">
            {`${overrides.length} ${overrides.length === 1 ? "override" : "overrides"}`}
          </span>
          <span className="hidden truncate tabular-nums sm:inline">
            {count}
          </span>
          <ChevronDown aria-hidden className="opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        aria-labelledby="user-limits-overrides-title"
        className="w-[min(22rem,calc(100vw-2rem))] p-0"
        onKeyDown={onKeyDown}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          const root = containerRef.current;
          (
            root?.querySelector<HTMLElement>("input") ??
            root?.querySelector<HTMLElement>("[data-override-row]")
          )?.focus();
        }}
        onCloseAutoFocus={() => {
          const action = pending.current;
          pending.current = null;
          if (action) window.setTimeout(action, 0);
        }}
      >
        <div ref={containerRef}>
          <div className="space-y-0.5 border-b px-3 pt-2.5 pb-2">
            <p id="user-limits-overrides-title" className="text-sm font-medium">
              Environment overrides
            </p>
            <p className="text-xs text-muted-foreground">
              {orgDefault
                ? `Users in these environments get this limit instead of the ${formatLimit(orgDefault.limitValue)} organization default.`
                : "Users in these environments get this limit. Everyone else has no default limit."}
            </p>
          </div>

          {searchable ? (
            <div className="border-b p-2">
              <InputGroup>
                <InputGroupAddon>
                  <Search aria-hidden />
                </InputGroupAddon>
                <InputGroupInput
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search environments"
                  aria-label="Search environment overrides"
                />
              </InputGroup>
            </div>
          ) : null}

          <div className="max-h-72 overflow-y-auto p-1">
            {shown.length > 0 ? (
              <ul>
                {shown.map((override) => (
                  <OverrideRow
                    key={override.environmentId}
                    override={override}
                    onView={() => handOff(() => onView(override.environmentId))}
                    onEdit={
                      canEdit
                        ? () => handOff(() => onEdit(override.limit))
                        : undefined
                    }
                    onDelete={
                      canDelete
                        ? () => handOff(() => onDelete(override.limit))
                        : undefined
                    }
                  />
                ))}
              </ul>
            ) : (
              <p className="px-2 py-4 text-center text-sm text-muted-foreground">
                No override matches
              </p>
            )}
          </div>

          {canAdd ? (
            <div className="border-t p-1">
              <Button
                variant="ghost"
                size="sm"
                className="w-full justify-start"
                onClick={() => handOff(onAdd)}
              >
                <Plus />
                <span>Add environment override</span>
              </Button>
            </div>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function NoEnvironmentsHint() {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="xs"
          aria-label="Per-environment limits"
          className="-mr-2 text-muted-foreground"
        >
          <Boxes />
          <span className="hidden sm:inline">Per-environment limits</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 space-y-2">
        <p className="text-sm font-medium">Different limits per environment</p>
        <p className="text-sm text-muted-foreground">
          Environments separate resources, such as staging and production. Once
          you add one, you can give its users a different limit than this
          default.
        </p>
        <Button asChild variant="outline" size="xs">
          <Link href="/settings/environments">
            <span>Go to Environments</span>
            <ArrowRight />
          </Link>
        </Button>
      </PopoverContent>
    </Popover>
  );
}

function OverrideRow({
  override,
  onView,
  onEdit,
  onDelete,
}: {
  override: EnvironmentOverride;
  onView: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
}) {
  const { name, limit, at, near, users } = override;
  return (
    <li className="flex items-center gap-1 rounded-sm pr-1 transition-colors hover:bg-accent focus-within:bg-accent">
      <UnstyledButton
        data-override-row=""
        onClick={onView}
        className="group/row flex min-w-0 flex-1 flex-col items-start rounded-sm px-2 py-1.5 text-left focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
      >
        <span className="max-w-full truncate text-sm underline-offset-4 group-hover/row:underline">
          <span>{name}</span>
          <span className="sr-only">{`, view ${pluralUsers(users)}`}</span>
        </span>
        <span className="block max-w-full truncate text-xs text-foreground/80 tabular-nums">
          {`${formatLimit(limit.limitValue)} / ${intervalLabel(limit.cleanupInterval).toLowerCase().replace("calendar ", "")} · ${modelCountLabel(limit.model)}`}
        </span>
      </UnstyledButton>
      <span className="flex shrink-0 items-center gap-2 px-1 text-xs tabular-nums">
        {at > 0 ? <StatusCount status="at" count={at} /> : null}
        {near > 0 ? <StatusCount status="near" count={near} /> : null}
      </span>
      <span className="flex shrink-0 items-center gap-0.5">
        {onEdit ? (
          <RowAction tip="Edit">
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={`Edit the ${name} override`}
              className={ROW_ACTION_CLASS}
              onClick={onEdit}
            >
              <Pencil />
            </Button>
          </RowAction>
        ) : null}
        {onDelete ? (
          <RowAction tip="Delete">
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={`Delete the ${name} override`}
              className={cn(ROW_ACTION_CLASS, "hover:text-destructive")}
              onClick={onDelete}
            >
              <Trash2 />
            </Button>
          </RowAction>
        ) : null}
      </span>
    </li>
  );
}

function StatusCount({
  status,
  count,
}: {
  status: UserLimitStatus;
  count: number;
}) {
  return (
    <span className="inline-flex items-center gap-1">
      <span
        aria-hidden
        className={cn("size-2 rounded-full", STATUS_META[status].dot)}
      />
      <span className="font-medium">{count}</span>
      <span className="sr-only">{STATUS_META[status].label.toLowerCase()}</span>
    </span>
  );
}

function RowAction({ tip, children }: { tip: string; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent>{tip}</TooltipContent>
    </Tooltip>
  );
}

// ===
// The organization default (read-only; edits go through the dialog)

function OrgLimit({
  orgDefault,
  summary,
  canCreate,
  canEdit,
  onEdit,
  onSet,
  onOpenCustom,
  onOpenUncapped,
}: {
  orgDefault: DefaultUserLimit | undefined;
  summary: UserLimitUsageSummary | undefined;
  canCreate: boolean;
  canEdit: boolean;
  onEdit: (d: DefaultUserLimit) => void;
  onSet: () => void;
  onOpenCustom: () => void;
  onOpenUncapped: () => void;
}) {
  const custom = summary?.custom ?? 0;
  const customItem: DotItem | null =
    custom > 0
      ? {
          key: "custom",
          node: (
            <UnstyledButton
              onClick={onOpenCustom}
              className={cn("tabular-nums", LINK_CLASS)}
            >
              {`${custom} custom`}
            </UnstyledButton>
          ),
        }
      : null;

  // Same rhythm as the "$50 per month" state, so an empty org default reads
  // as a value ("No limit") rather than an error banner.
  if (!orgDefault) {
    const uncapped = summary?.none ?? 0;
    return (
      <>
        <div className="flex min-h-9 flex-wrap items-center gap-x-2.5 gap-y-1">
          <span className="text-3xl leading-none font-semibold tracking-tight text-muted-foreground/60 sm:text-4xl">
            No limit
          </span>
          {canCreate ? (
            <Button size="xs" variant="outline" onClick={onSet}>
              <Plus />
              <span>Set default</span>
            </Button>
          ) : null}
        </div>
        {summary ? (
          <DotList
            className="text-xs text-muted-foreground"
            items={[
              uncapped > 0
                ? {
                    key: "uncapped",
                    node: (
                      <UnstyledButton
                        onClick={onOpenUncapped}
                        className={cn("tabular-nums", LINK_CLASS)}
                      >
                        {`${pluralUsers(uncapped)} can spend without a cap`}
                      </UnstyledButton>
                    ),
                  }
                : {
                    key: "covered",
                    node: (
                      <span>Everyone has an override or a custom limit</span>
                    ),
                  },
              customItem,
            ]}
          />
        ) : null}
      </>
    );
  }

  return (
    <>
      <div className="flex min-h-9 flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-3xl leading-none font-semibold tracking-tight tabular-nums sm:text-4xl">
          {formatLimit(orgDefault.limitValue)}
        </span>
        <span className="text-sm text-muted-foreground">
          {`per ${intervalLabel(orgDefault.cleanupInterval).toLowerCase()}`}
        </span>
      </div>
      <DotList
        className="text-xs text-muted-foreground"
        items={[
          summary
            ? {
                key: "applies",
                node: (
                  <span className="tabular-nums">
                    {`Applies to ${pluralUsers(summary.organizationDefault)}`}
                  </span>
                ),
              }
            : null,
          { key: "models", node: <ModelsLabel models={orgDefault.model} /> },
          customItem,
          canEdit
            ? {
                key: "edit",
                node: (
                  <UnstyledButton
                    onClick={() => onEdit(orgDefault)}
                    aria-label="Edit the organization default"
                    className={QUIET_ACTION_CLASS}
                  >
                    Edit
                  </UnstyledButton>
                ),
              }
            : null,
        ]}
      />
    </>
  );
}

/** "All models", one model's name, or "2 models" with the names on hover. */
function ModelsLabel({ models }: { models: string[] | null | undefined }) {
  if (!models?.length) return <span>All models</span>;
  if (models.length === 1) return <span>{models[0]}</span>;
  const names = models.join(", ");
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <UnstyledButton
          aria-label={`${models.length} models: ${names}`}
          className={cn("tabular-nums", LINK_CLASS)}
        >
          {`${models.length} models`}
        </UnstyledButton>
      </TooltipTrigger>
      <TooltipContent className="max-w-64">{names}</TooltipContent>
    </Tooltip>
  );
}

// ===
// Who's affected (organization-wide, three short lines)

function WhoIsAffected({
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
  // With no org default, the only people who can be near a limit are those on
  // a custom one. Say so, or "2 near" next to "22 with no limit" reads oddly.
  const onlyCustom = flagged > 0 && summary?.flaggedCustom === flagged;
  const suffix = onlyCustom ? " their custom limit" : "";
  const total = summary?.total ?? 0;
  const unlimited = summary?.none ?? 0;
  const allUnlimited = total > 0 && unlimited === total;
  const spent = summary?.spent ?? 0;

  const stack = allUnlimited
    ? rows.filter((row) => row.spent > 0)
    : rows.filter((row) => row.status !== "ok");
  const hidden = Math.max((allUnlimited ? total : flagged) - stack.length, 0);

  const resetsItem: DotItem | null = summary?.resetsAt
    ? {
        key: "resets",
        node: <span>{`Resets ${formatRelative(summary.resetsAt)}`}</span>,
      }
    : null;
  const unlimitedItem: DotItem | null =
    unlimited > 0 && !allUnlimited
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
    main = <div className="h-8 w-40 animate-pulse rounded-md bg-muted" />;
    meta = [];
  } else if (spent === 0 && flagged === 0) {
    main = (
      <p className="text-sm text-muted-foreground">
        No one has used a model this window
      </p>
    );
    meta = [
      {
        key: "later",
        node: <span>Limits apply once someone sends traffic</span>,
      },
    ];
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
          <span className="font-medium tabular-nums">{unlimited}</span>
          <span className="text-muted-foreground">without a limit</span>
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
  } else if (flagged === 0) {
    main = (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Check aria-hidden className="size-4 text-emerald-500" />
        <span>No one is near their limit</span>
      </div>
    );
    meta = [unlimitedItem, resetsItem];
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
    meta = [unlimitedItem, resetsItem];
  }

  return (
    <section
      aria-labelledby="user-limits-affected"
      className="flex min-w-0 flex-col gap-3 border-t bg-muted/30 px-4 py-3.5 sm:px-5 sm:py-4 lg:border-t-0 lg:border-l"
    >
      <div className="flex h-7 items-center justify-between gap-3">
        <h2
          id="user-limits-affected"
          className="truncate text-sm font-medium text-muted-foreground"
        >
          Who's affected
        </h2>
        {total > 0 ? (
          <Button
            variant="ghost"
            size="xs"
            className="-mr-2 shrink-0 text-muted-foreground"
            aria-label={`View all ${total.toLocaleString("en-US")} users`}
            onClick={() => onOpen({})}
          >
            <span className="tabular-nums">{`All ${total.toLocaleString("en-US")}`}</span>
            <ArrowRight aria-hidden />
          </Button>
        ) : null}
      </div>
      <div className="flex min-h-9 flex-wrap items-center gap-x-3 gap-y-1">
        {main}
      </div>
      <DotList className="text-xs text-muted-foreground" items={meta} />
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
          aria-label={`${hidden} more users`}
          className="relative flex size-8 items-center justify-center rounded-full border-2 border-card bg-muted text-xs font-medium tabular-nums hover:bg-accent focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          {`+${hidden}`}
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
      <span className="font-medium tabular-nums">{count}</span>
      <span className="text-muted-foreground">{label}</span>
    </UnstyledButton>
  );
}

// ===
// Helpers

function buildOverrides(params: {
  environments: { id: string; name: string }[];
  defaults: DefaultUserLimit[];
  summary: UserLimitUsageSummary["environments"];
}): EnvironmentOverride[] {
  return params.environments.flatMap((env): EnvironmentOverride[] => {
    const limit = params.defaults.find((d) => d.environmentId === env.id);
    if (!limit) return [];
    const counts = params.summary.find(
      (entry) => entry.environmentId === env.id,
    );
    return [
      {
        environmentId: env.id,
        name: env.name,
        limit,
        users: counts?.users ?? 0,
        at: counts?.at ?? 0,
        near: counts?.near ?? 0,
      },
    ];
  });
}
