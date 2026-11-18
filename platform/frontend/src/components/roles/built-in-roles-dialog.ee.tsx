// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
"use client";

import { ChevronLeft } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { KeyboardEvent } from "react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { StandardDialog } from "@/components/standard-dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import {
  type RoleGroup,
  type RoleOption,
  roleKindLabels,
  useRolePicker,
} from "@/components/ui/use-role-picker";
import { matchesSearchTokens } from "@/lib/search-tokens";
import { cn } from "@/lib/utils/tailwind";
import { permissionAreas } from "./permission-list-model.ee";

/** `?role=<role>` opens the dialog on that role, so a role can be linked. */
export const BUILT_IN_ROLE_PARAM = "role";

/**
 * A read-only reference of every built-in role, preset and granular, in one
 * dialog: what each is for and what it grants. Built-in roles cannot be
 * edited, so they have no place in the roles table; this is where they are
 * read. It is open whenever the URL names a role.
 */
export function BuiltInRolesDialog() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { isPending, presets, granularGroups } = useRolePicker({ value: "" });

  const setRoleParam = (role: string | null) => {
    const params = new URLSearchParams(searchParams.toString());
    if (role) params.set(ROLE_PARAM, role);
    else params.delete(ROLE_PARAM);
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, {
      scroll: false,
    });
  };

  return (
    <BuiltInRolesDialogBody
      roleParam={searchParams.get(ROLE_PARAM)}
      onRoleParamChange={setRoleParam}
      isPending={isPending}
      presets={presets}
      granularGroups={granularGroups}
    />
  );
}

// === Internal helpers

const ROLE_PARAM = BUILT_IN_ROLE_PARAM;
/** `?role=granular` opens the dialog on the first granular role. */
const GRANULAR_PARAM = "granular";
const PRESET_SECTION_ID = "preset";
const DESKTOP_QUERY = "(min-width: 768px)";
/** Arrow keys repeat fast; the URL only needs the role they settle on. */
const URL_SYNC_DELAY_MS = 250;

const LIST_SKELETONS = ["a", "b", "c", "d", "e", "f", "g", "h"];

type MobileView = "list" | "detail";

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/**
 * One dialog for every built-in role. Search on top keeps focus; arrow keys
 * move through the list on the left while the detail on the right follows.
 * Below 768px the two panes become a list that drills into the detail.
 */
function BuiltInRolesDialogBody({
  roleParam,
  onRoleParamChange,
  isPending,
  presets,
  granularGroups,
}: {
  roleParam: string | null;
  onRoleParamChange: (role: string | null) => void;
  isPending: boolean;
  presets: RoleOption[];
  granularGroups: RoleGroup[];
}) {
  const open = roleParam !== null;
  const baseId = useId();
  const listboxId = `${baseId}-list`;
  const optionId = (value: string) => `${baseId}-option-${value}`;

  const [query, setQuery] = useState("");
  // The role picked in this session, ahead of the (debounced) URL.
  const [override, setOverride] = useState<string | null>(null);
  const [mobileView, setMobileView] = useState<MobileView | null>(null);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const backRef = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const urlTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastShown = useRef<RoleOption | null>(null);

  const sections = useMemo<RoleGroup[]>(
    () => [
      {
        id: PRESET_SECTION_ID,
        name: roleKindLabels.preset,
        kind: "preset",
        options: presets,
      },
      ...granularGroups,
    ],
    [presets, granularGroups],
  );
  const byValue = useMemo(
    () =>
      new Map(
        sections.flatMap((section) =>
          section.options.map((option) => [option.value, option] as const),
        ),
      ),
    [sections],
  );

  const fromParam =
    roleParam === null
      ? null
      : roleParam === GRANULAR_PARAM
        ? (granularGroups[0]?.options[0] ?? null)
        : (byValue.get(roleParam) ?? presets[0] ?? null);
  const selected = (override ? byValue.get(override) : undefined) ?? fromParam;
  // Keeps the detail filled while the dialog fades out.
  const shown = selected ?? lastShown.current;

  const visible = filterSections(sections, query);
  const flat = visible.flatMap((section) => section.options);
  const pattern = useMemo(() => buildPattern(query), [query]);
  const searching = query.trim().length > 0;

  const defaultView: MobileView =
    roleParam === GRANULAR_PARAM ? "list" : "detail";
  const view = mobileView ?? defaultView;

  useEffect(() => {
    if (selected) lastShown.current = selected;
  }, [selected]);

  useEffect(() => {
    if (open) return;
    if (urlTimer.current) clearTimeout(urlTimer.current);
    setQuery("");
    setOverride(null);
    setMobileView(null);
  }, [open]);

  useEffect(
    () => () => {
      if (urlTimer.current) clearTimeout(urlTimer.current);
    },
    [],
  );

  const selectedValue = selected?.value;
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run when the selection moves, to bring its row into view.
  useEffect(() => {
    if (!open) return;
    listRef.current
      ?.querySelector<HTMLElement>('[aria-selected="true"]')
      ?.scrollIntoView?.({ block: "nearest" });
  }, [open, selectedValue, isPending]);

  const select = (value: string) => {
    setOverride(value);
    if (urlTimer.current) clearTimeout(urlTimer.current);
    urlTimer.current = setTimeout(
      () => onRoleParamChange(value),
      URL_SYNC_DELAY_MS,
    );
  };

  const close = () => {
    if (urlTimer.current) clearTimeout(urlTimer.current);
    onRoleParamChange(null);
  };

  const onQueryChange = (next: string) => {
    setQuery(next);
    // Typing happens in the list; do not let a URL update flip the view.
    setMobileView((current) => current ?? defaultView);
    if (!next.trim()) return;
    const first = filterSections(sections, next)[0]?.options[0];
    if (first) select(first.value);
  };

  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (flat.length === 0) return;
      setMobileView((current) => current ?? defaultView);
      const index = flat.findIndex((option) => option.value === selectedValue);
      const step = event.key === "ArrowDown" ? 1 : -1;
      const next =
        index === -1
          ? step === 1
            ? 0
            : flat.length - 1
          : Math.min(flat.length - 1, Math.max(0, index + step));
      select(flat[next].value);
    } else if (event.key === "Enter") {
      // The selection already follows the arrows; Enter only confirms it,
      // which on a phone means drilling into the detail.
      event.preventDefault();
      if (selected) setMobileView("detail");
    }
  };

  // Desktop focuses the search; a phone opening on a role focuses the back
  // control instead, so the keyboard does not cover the detail.
  const initialFocus = useMemo(
    () => ({
      get current(): HTMLElement | null {
        const desktop =
          typeof window !== "undefined" &&
          window.matchMedia?.(DESKTOP_QUERY).matches;
        if (desktop) return inputRef.current;
        return backRef.current?.offsetParent
          ? backRef.current
          : listRef.current;
      },
    }),
    [],
  );

  return (
    <StandardDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
      title="Built-in roles"
      size="large"
      className="h-[90dvh] max-w-4xl md:h-[min(40rem,90dvh)]"
      headerClassName="border-b-0 pb-1"
      bodyClassName="flex flex-col overflow-hidden p-0"
      initialFocusRef={initialFocus}
    >
      <div
        className={cn(
          "items-center border-b",
          view === "detail" ? "hidden md:flex" : "flex",
        )}
      >
        <Input
          ref={inputRef}
          role="combobox"
          aria-label="Search built-in roles"
          aria-expanded
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-activedescendant={
            selectedValue ? optionId(selectedValue) : undefined
          }
          autoComplete="off"
          spellCheck={false}
          placeholder="Search roles, areas or permissions"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={onSearchKeyDown}
          className="h-12 min-w-0 flex-1 rounded-none border-0 bg-transparent px-4 text-base shadow-none focus-visible:border-0 focus-visible:ring-0 dark:bg-transparent"
        />
        <span className="shrink-0 pr-4 text-xs tabular-nums text-muted-foreground">
          {plural(flat.length, "role")}
        </span>
      </div>
      <div
        className={cn(
          "border-b",
          view === "detail" ? "flex md:hidden" : "hidden",
        )}
      >
        <UnstyledButton
          ref={backRef}
          onClick={() => setMobileView("list")}
          className="flex h-12 w-full items-center gap-1.5 px-3 text-left text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:bg-muted focus-visible:text-foreground focus-visible:outline-none"
        >
          <ChevronLeft className="size-4 shrink-0" />
          <span>All built-in roles</span>
        </UnstyledButton>
      </div>

      <div className="flex min-h-0 flex-1">
        <div
          ref={listRef}
          tabIndex={-1}
          className={cn(
            "min-h-0 w-full overflow-y-auto overscroll-contain outline-none md:block md:w-72 md:shrink-0 md:border-r",
            view === "detail" && "hidden",
          )}
        >
          {isPending ? (
            <div className="space-y-2 p-4">
              {LIST_SKELETONS.map((key) => (
                <Skeleton key={key} className="h-5" />
              ))}
            </div>
          ) : flat.length === 0 ? (
            <p className="px-4 py-10 text-center text-sm text-muted-foreground">
              No built-in roles match.
            </p>
          ) : (
            <div
              id={listboxId}
              role="listbox"
              aria-label="Built-in roles"
              className="pb-2"
            >
              {visible.map((section) => {
                const headingId = `${baseId}-group-${section.id}`;
                return (
                  // biome-ignore lint/a11y/useSemanticElements: option groups inside the listbox above.
                  <div
                    key={section.id}
                    role="group"
                    aria-labelledby={headingId}
                  >
                    <div
                      id={headingId}
                      className="sticky top-0 z-10 flex h-7 items-center justify-between gap-2 bg-background px-4 text-xs font-medium text-muted-foreground"
                    >
                      <span className="min-w-0 truncate">
                        <Highlight text={section.name} pattern={pattern} />
                      </span>
                      <span className="shrink-0 tabular-nums">
                        {section.options.length}
                      </span>
                    </div>
                    {section.options.map((option) => {
                      const active = option.value === selectedValue;
                      return (
                        <UnstyledButton
                          key={option.value}
                          id={optionId(option.value)}
                          role="option"
                          aria-selected={active}
                          tabIndex={-1}
                          // Keep focus in the search input on desktop.
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => {
                            select(option.value);
                            setMobileView("detail");
                          }}
                          className={cn(
                            "flex min-h-11 w-full scroll-mt-7 items-center gap-3 px-4 text-left text-sm transition-colors duration-100 md:min-h-8",
                            active
                              ? "bg-accent font-medium text-accent-foreground"
                              : "hover:bg-muted/60",
                          )}
                        >
                          <span className="min-w-0 flex-1 truncate">
                            <Highlight text={option.label} pattern={pattern} />
                          </span>
                          <span
                            className={cn(
                              "shrink-0 text-xs font-normal tabular-nums",
                              !active && "text-muted-foreground",
                            )}
                          >
                            {option.permissions.length}
                          </span>
                        </UnstyledButton>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div
          key={shown?.value ?? "none"}
          className={cn(
            "min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain md:block",
            view === "list" && "hidden",
          )}
        >
          {shown ? (
            <RoleDetail option={shown} pattern={searching ? pattern : null} />
          ) : isPending ? (
            <div className="space-y-3 p-5">
              <Skeleton className="h-5 w-40" />
              <Skeleton className="h-4 w-full max-w-sm" />
              <Skeleton className="h-4 w-full max-w-xs" />
            </div>
          ) : null}
        </div>
      </div>

      <div className="hidden h-9 shrink-0 items-center border-t px-4 text-xs text-muted-foreground md:flex">
        ↑↓ to move · Esc to close
      </div>
    </StandardDialog>
  );
}

function RoleDetail({
  option,
  pattern,
}: {
  option: RoleOption;
  pattern: RegExp | null;
}) {
  const preset = option.kind === "preset";
  const held = new Set(option.permissions.map((entry) => entry.key));
  const areas = permissionAreas
    .map((area) => ({
      name: area.name,
      rows: area.resources.flatMap((resource) =>
        resource.rows.filter((row) => held.has(row.key)),
      ),
    }))
    .filter((area) => area.rows.length > 0);
  return (
    <div className="px-4 py-4 md:px-5">
      <h4 className="text-base font-semibold leading-tight">
        <Highlight text={option.label} pattern={pattern} />
      </h4>
      <p className="mt-1 text-xs tabular-nums text-muted-foreground">
        {preset ? (
          <span>Preset role</span>
        ) : (
          <span>
            Granular role ·{" "}
            <Highlight text={option.groupName} pattern={pattern} />
          </span>
        )}
        <span> · {plural(option.permissions.length, "permission")}</span>
      </p>
      {option.description && (
        <p className="mt-3 text-sm text-muted-foreground">
          <Highlight text={option.description} pattern={pattern} />
        </p>
      )}
      <div className="mt-3 border-t">
        {areas.map((area) => (
          <section key={area.name} className="border-b py-3 last:border-b-0">
            <div className="flex items-baseline justify-between gap-3 text-xs font-medium text-muted-foreground">
              <h5>{area.name}</h5>
              <span className="tabular-nums">{area.rows.length}</span>
            </div>
            <ul className="mt-1 gap-x-6 sm:columns-2">
              {area.rows.map((row) => (
                <li
                  key={row.key}
                  className="break-inside-avoid truncate text-sm leading-7"
                >
                  <Highlight text={row.label} pattern={pattern} />
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}

/** The text with every search token marked. Always elements, never bare text. */
function Highlight({
  text,
  pattern,
}: {
  text: string;
  pattern: RegExp | null;
}) {
  if (!pattern) return <span>{text}</span>;
  const pieces: Array<{ start: number; text: string; hit: boolean }> = [];
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (start > cursor)
      pieces.push({
        start: cursor,
        text: text.slice(cursor, start),
        hit: false,
      });
    pieces.push({ start, text: match[0], hit: true });
    cursor = start + match[0].length;
  }
  if (cursor < text.length)
    pieces.push({ start: cursor, text: text.slice(cursor), hit: false });
  return (
    <span>
      {pieces.map((piece) =>
        piece.hit ? (
          <mark
            key={piece.start}
            className="rounded-[2px] bg-primary/15 text-inherit"
          >
            {piece.text}
          </mark>
        ) : (
          <span key={piece.start}>{piece.text}</span>
        ),
      )}
    </span>
  );
}

function buildPattern(query: string): RegExp | null {
  const tokens = query.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  return new RegExp(
    tokens
      .map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("|"),
    "gi",
  );
}

function filterSections(sections: RoleGroup[], query: string): RoleGroup[] {
  return sections
    .map((section) => ({
      ...section,
      options: section.options.filter((option) =>
        matchesSearchTokens(query, [
          option.label,
          option.description,
          section.name,
          ...option.permissions.map((entry) => entry.label),
        ]),
      ),
    }))
    .filter((section) => section.options.length > 0);
}
