"use client";

import {
  ArrowLeft,
  Bot,
  ChevronDown,
  ChevronRight,
  Cpu,
  Fingerprint,
  KeyRound,
  type LucideIcon,
  Search,
  User,
  Users,
} from "lucide-react";
import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AgentIdenticon, PersonAvatar } from "@/app/llm/logs/_parts/hue-avatar";
import { filterControlClass } from "@/components/filter-bar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import type { AuditActorType } from "@/lib/audit-log/audit-log.query";
import { useMemberSearch } from "@/lib/member.query";
import { matchesSearchTokens } from "@/lib/search-tokens";
import { useServiceAccounts } from "@/lib/service-account.query";
import { cn } from "@/lib/utils/tailwind";
import {
  focusFirstPickerRow,
  movePickerFocus,
  PICKER_PANE_HEIGHT,
  PICKER_ROW_CLASS,
  PickerRow,
  PickerTile,
} from "./filter-picker-panes";

type ActorFilterValue = {
  actorId: string | null;
  actorType: AuditActorType | null;
};

/**
 * Who acted, in two panes like the event filter: a kind of principal on the
 * left; for kinds with members, "Any …" and the people or service accounts
 * on the right. Picking a person under API keys narrows to their keys (keys
 * act under their owner's id); under People it covers everything they did.
 * Service accounts are picked through the `service-account:<id>` id the list
 * endpoint resolves.
 */
export function AuditActorFilter({
  actorId,
  actorType,
  canPickPrincipals,
  compact,
  onChange,
}: {
  actorId?: string;
  actorType?: AuditActorType;
  /** Without auditLog:admin the trail is the caller's own, so only kinds apply. */
  canPickPrincipals: boolean;
  /** Phone/tablet layout: the panes stack and drill in. */
  compact: boolean;
  onChange: (next: ActorFilterValue) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [focusedKind, setFocusedKind] = useState<AuditActorType>(
    initialKind({ actorId, actorType }),
  );
  const [drilled, setDrilled] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const people = useMemberSearch({
    limit: LIST_LIMIT,
    selectedUserIds:
      actorId && !isServiceAccountActor(actorId) ? [actorId] : [],
    enabled: canPickPrincipals && (open || !!actorId),
  });
  const serviceAccounts = useServiceAccounts({
    enabled: canPickPrincipals && (open || !!actorId),
  });

  const trimmed = query.trim();
  const accounts = useMemo(
    () =>
      (serviceAccounts.data ?? []).filter((account) =>
        matchesSearchTokens(trimmed, [account.name]),
      ),
    [serviceAccounts.data, trimmed],
  );
  const kinds = canPickPrincipals
    ? KINDS
    : KINDS.map((kind) => ({ ...kind, members: undefined }));
  const focused =
    kinds.find((kind) => kind.type === focusedKind && kind.members) ?? kinds[0];
  const selection = describeSelection({
    actorId,
    actorType,
    people: people.users,
    serviceAccounts: serviceAccounts.data ?? [],
  });

  const setSearch = (value: string) => {
    setQuery(value);
    people.onSearchQueryChange(value);
  };
  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) {
      setFocusedKind(initialKind({ actorId, actorType }));
      setDrilled(false);
    } else {
      setSearch("");
    }
  };
  const commit = (next: ActorFilterValue) => {
    onChange(next);
    handleOpenChange(false);
  };

  // On compact screens focus follows the drill-in.
  useEffect(() => {
    if (!open || !compact) return;
    const frame = requestAnimationFrame(() =>
      focusFirstPickerRow(rootRef.current, drilled ? "right" : "left"),
    );
    return () => cancelAnimationFrame(frame);
  }, [open, drilled, compact]);
  useEffect(
    () => () => {
      if (hoverTimer.current) clearTimeout(hoverTimer.current);
    },
    [],
  );

  const previewKind = (type: AuditActorType) => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    // Hover intent, so a diagonal move to the right pane keeps it.
    hoverTimer.current = setTimeout(() => setFocusedKind(type), 110);
  };
  const cancelPreview = () => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
  };

  const onNavKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!(event.target instanceof HTMLElement)) return;
    const target = event.target;
    const group = target.dataset.nav;
    if (!group) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const moved = movePickerFocus({
        root: rootRef.current,
        group,
        from: target,
        delta: event.key === "ArrowDown" ? 1 : -1,
      });
      if (!moved && event.key === "ArrowUp") inputRef.current?.focus();
    } else if (event.key === "ArrowRight" && group === "left") {
      const type = target.dataset.type as AuditActorType | undefined;
      if (!type || !KINDS.find((kind) => kind.type === type)?.members) return;
      event.preventDefault();
      setFocusedKind(type);
      if (compact) setDrilled(true);
      else focusFirstPickerRow(rootRef.current, "right");
    } else if (event.key === "ArrowLeft" && group === "right") {
      event.preventDefault();
      if (compact) setDrilled(false);
      else
        rootRef.current
          ?.querySelector<HTMLElement>(
            `[data-nav="left"][data-type="${focusedKind}"]`,
          )
          ?.focus();
    }
  };

  const personRows = (kind: AuditActorType | null, nav: string) =>
    people.users.map((person) => {
      const name = person.name || person.email || "Unknown";
      return (
        <PickerRow
          key={`${kind}:${person.userId}`}
          nav={nav}
          selected={actorId === person.userId && (actorType ?? null) === kind}
          leading={<PersonAvatar name={name} size={24} ring={false} />}
          description={person.name ? person.email : undefined}
          onClick={() => commit({ actorId: person.userId, actorType: kind })}
        >
          {name}
        </PickerRow>
      );
    });
  const accountRows = (nav: string) =>
    accounts.map((account) => {
      const id = `${SERVICE_ACCOUNT_PREFIX}${account.id}`;
      return (
        <PickerRow
          key={account.id}
          nav={nav}
          selected={actorId === id}
          leading={
            <AgentIdenticon
              seed={account.id}
              name={account.name}
              variant="agent"
              size="sm"
            />
          }
          onClick={() => commit({ actorId: id, actorType: null })}
        >
          {account.name}
        </PickerRow>
      );
    });

  const leftPane = (
    <div
      className={cn(
        "overflow-y-auto overscroll-contain p-1",
        PICKER_PANE_HEIGHT,
      )}
      onWheelCapture={(event) => event.stopPropagation()}
    >
      <PickerRow
        nav="left"
        selected={!actorId && !actorType}
        leading={<KindIcon icon={Users} />}
        onClick={() => commit({ actorId: null, actorType: null })}
        className="font-medium"
      >
        Any actor
      </PickerRow>
      <div className="px-2 pt-2 pb-1 text-xs font-medium text-muted-foreground">
        Kind
      </div>
      {kinds.map((kind) => {
        const isFocused = !compact && kind.type === focused.type;
        const isActive =
          actorType === kind.type ||
          (!!actorId &&
            kind.type ===
              (isServiceAccountActor(actorId) ? "service_account" : "user") &&
            !actorType);
        return (
          <UnstyledButton
            key={kind.type}
            data-nav="left"
            data-type={kind.type}
            aria-current={isFocused ? "true" : undefined}
            // Kinds without members pick on click; they never take over the
            // right pane.
            onMouseEnter={
              compact || !kind.members
                ? undefined
                : () => previewKind(kind.type)
            }
            onMouseLeave={compact ? undefined : cancelPreview}
            onFocus={
              compact || !kind.members
                ? undefined
                : () => setFocusedKind(kind.type)
            }
            onClick={() => {
              cancelPreview();
              // Kinds without members are a pick in themselves.
              if (!kind.members) {
                commit({ actorId: null, actorType: kind.type });
                return;
              }
              setFocusedKind(kind.type);
              if (compact) setDrilled(true);
            }}
            className={cn(
              PICKER_ROW_CLASS,
              isFocused && "bg-accent text-accent-foreground",
            )}
          >
            <KindIcon icon={kind.icon} />
            <span
              className={cn(
                "min-w-0 flex-1 truncate",
                isActive && "font-medium",
              )}
            >
              {kind.label}
            </span>
            {isActive ? (
              <span
                aria-hidden
                className="size-1.5 shrink-0 rounded-full bg-primary"
              />
            ) : null}
            {kind.members ? (
              <ChevronRight
                aria-hidden
                className={cn(
                  "size-3.5 shrink-0 text-muted-foreground",
                  !compact && !isFocused && "opacity-0",
                )}
              />
            ) : null}
          </UnstyledButton>
        );
      })}
    </div>
  );

  // A person under API keys narrows to their keys; under People, to anything.
  const personKind: AuditActorType | null =
    focused.type === "api_key" ? "api_key" : null;
  const rightPane = (
    <div className={cn("flex min-w-0 flex-col", PICKER_PANE_HEIGHT)}>
      <div className="flex shrink-0 items-center gap-2.5 border-b px-3 py-2">
        {compact ? (
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Back to all kinds"
            className="-ml-1.5"
            onClick={() => setDrilled(false)}
          >
            <ArrowLeft aria-hidden />
          </Button>
        ) : null}
        <PickerTile icon={focused.icon} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm leading-5 font-medium">
            {focused.label}
          </div>
          <div className="truncate text-xs leading-4 text-muted-foreground">
            {focused.description}
          </div>
        </div>
      </div>
      <div
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1"
        onWheelCapture={(event) => event.stopPropagation()}
      >
        <PickerRow
          nav="right"
          selected={!actorId && actorType === focused.type}
          onClick={() => commit({ actorId: null, actorType: focused.type })}
          className="font-medium"
        >
          {focused.anyLabel}
        </PickerRow>
        {focused.members ? (
          <div aria-hidden className="mx-2 my-1 h-px bg-border" />
        ) : null}
        {focused.members === "people" && personRows(personKind, "right")}
        {focused.members === "serviceAccounts" && accountRows("right")}
        {focused.members && isTruncated(focused.members) ? (
          <p className="px-2 py-2 text-xs text-muted-foreground">
            Showing the first {LIST_LIMIT}. Search to find more.
          </p>
        ) : null}
      </div>
    </div>
  );

  const matchingKinds = kinds.filter((kind) =>
    matchesSearchTokens(trimmed, [kind.label, kind.anyLabel]),
  );
  const searchPane = (
    <div
      className={cn(
        "overflow-y-auto overscroll-contain p-1",
        "max-h-[min(22rem,calc(var(--radix-popover-content-available-height)-2.75rem))]",
      )}
      onWheelCapture={(event) => event.stopPropagation()}
    >
      {matchingKinds.length > 0 && (
        <SearchGroup heading="Kind">
          {matchingKinds.map((kind) => (
            <PickerRow
              key={kind.type}
              nav="result"
              selected={!actorId && actorType === kind.type}
              leading={<KindIcon icon={kind.icon} />}
              onClick={() => commit({ actorId: null, actorType: kind.type })}
            >
              {kind.anyLabel}
            </PickerRow>
          ))}
        </SearchGroup>
      )}
      {canPickPrincipals && people.users.length > 0 && (
        <SearchGroup heading="People">{personRows(null, "result")}</SearchGroup>
      )}
      {canPickPrincipals && accounts.length > 0 && (
        <SearchGroup heading="Service accounts">
          {accountRows("result")}
        </SearchGroup>
      )}
      {matchingKinds.length === 0 &&
        people.users.length === 0 &&
        accounts.length === 0 && (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">
            {people.emptyMessage ?? `No actors match “${trimmed}”`}
          </div>
        )}
    </div>
  );

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          aria-label={`Actor filter: ${selection.label}`}
          className={filterControlClass({ active: !!(actorId || actorType) })}
        >
          {selection.icon}
          <span className="min-w-0 flex-1 truncate text-left">
            {selection.label}
          </span>
          <ChevronDown aria-hidden className="h-4 w-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        aria-label="Filter by actor"
        className={cn(
          "flex flex-col overflow-hidden p-0",
          compact
            ? "w-[min(22rem,calc(100vw-2rem))]"
            : "w-[min(36rem,calc(100vw-2rem))]",
        )}
        onOpenAutoFocus={(event) => {
          if (compact) event.preventDefault();
        }}
        onKeyDown={onNavKeyDown}
      >
        <div ref={rootRef} className="flex min-h-0 flex-col">
          <div className="flex shrink-0 items-center gap-2 border-b px-3">
            <Search
              aria-hidden
              className="size-4 shrink-0 text-muted-foreground"
            />
            <Input
              ref={inputRef}
              value={query}
              onChange={(event) => setSearch(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  focusFirstPickerRow(
                    rootRef.current,
                    trimmed ? "result" : compact && drilled ? "right" : "left",
                  );
                }
              }}
              placeholder={
                canPickPrincipals
                  ? "Search people and service accounts…"
                  : "Search kinds…"
              }
              aria-label="Search actors"
              className="h-10 rounded-none border-0 bg-transparent px-0 shadow-none focus-visible:ring-0 dark:bg-transparent"
            />
          </div>
          {trimmed ? (
            searchPane
          ) : compact ? (
            drilled ? (
              rightPane
            ) : (
              leftPane
            )
          ) : (
            <div className="grid grid-cols-[13.5rem_minmax(0,1fr)]">
              <div className="border-r">{leftPane}</div>
              {rightPane}
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );

  function isTruncated(members: "people" | "serviceAccounts") {
    return members === "people" ? people.users.length >= LIST_LIMIT : false;
  }
}

// === Internal helpers

const LIST_LIMIT = 50;

/** Synthetic user id a service account acts under (backend `serviceAccountUserId`). */
const SERVICE_ACCOUNT_PREFIX = "service-account:";

type Kind = {
  type: AuditActorType;
  label: string;
  description: string;
  anyLabel: string;
  icon: LucideIcon;
  /** Which principals the right pane lists, if any. */
  members?: "people" | "serviceAccounts";
};

const KINDS: Kind[] = [
  {
    type: "user",
    label: "People",
    description: "Signed in to the app",
    anyLabel: "Any person",
    icon: User,
    members: "people",
  },
  {
    type: "api_key",
    label: "API keys",
    description: "Pick a key's owner to see what their keys did",
    anyLabel: "Any API key",
    icon: KeyRound,
    members: "people",
  },
  {
    type: "service_account",
    label: "Service accounts",
    description: "Machine identities with their own tokens",
    anyLabel: "Any service account",
    icon: Bot,
    members: "serviceAccounts",
  },
  {
    type: "sso",
    label: "SSO",
    description: "Sign-ins through an identity provider",
    anyLabel: "Any SSO sign-in",
    icon: Fingerprint,
  },
  {
    type: "system",
    label: "System",
    description: "Scheduled runs, syncs and other background jobs",
    anyLabel: "System",
    icon: Cpu,
  },
];

function isServiceAccountActor(actorId: string) {
  return actorId.startsWith(SERVICE_ACCOUNT_PREFIX);
}

function initialKind({
  actorId,
  actorType,
}: {
  actorId?: string;
  actorType?: AuditActorType;
}): AuditActorType {
  if (actorType && KINDS.find((kind) => kind.type === actorType)?.members) {
    return actorType;
  }
  if (actorId && isServiceAccountActor(actorId)) return "service_account";
  return "user";
}

function describeSelection({
  actorId,
  actorType,
  people,
  serviceAccounts,
}: {
  actorId?: string;
  actorType?: AuditActorType;
  people: { userId: string; name?: string | null; email?: string | null }[];
  serviceAccounts: { id: string; name: string }[];
}): { label: string; icon: ReactNode } {
  if (actorId && isServiceAccountActor(actorId)) {
    const id = actorId.slice(SERVICE_ACCOUNT_PREFIX.length);
    const name =
      serviceAccounts.find((account) => account.id === id)?.name ??
      "Service account";
    return { label: name, icon: <Bot aria-hidden className="size-3.5" /> };
  }
  if (actorId) {
    const person = people.find((user) => user.userId === actorId);
    const name = person?.name || person?.email || "Selected person";
    return {
      label: actorType === "api_key" ? `${name} · API keys` : name,
      icon: <PersonAvatar name={name} size={16} ring={false} />,
    };
  }
  const kind = KINDS.find((entry) => entry.type === actorType);
  if (kind) {
    const Icon = kind.icon;
    return {
      label: kind.label,
      icon: <Icon aria-hidden className="size-3.5" />,
    };
  }
  return { label: "Any actor", icon: null };
}

function KindIcon({ icon: Icon }: { icon: LucideIcon }) {
  return (
    <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
      <Icon aria-hidden className="size-3.5" />
    </span>
  );
}

function SearchGroup({
  heading,
  children,
}: {
  heading: string;
  children: ReactNode;
}) {
  return (
    <div className="mb-1">
      <div className="px-2 pt-2 pb-1 text-xs font-medium text-muted-foreground">
        {heading}
      </div>
      {children}
    </div>
  );
}
