"use client";

import type { PaginationState } from "@tanstack/react-table";
import { ArrowLeft, BookOpen, ChevronLeft, ChevronRight } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { SearchInput } from "@/components/search-input";
import { Button } from "@/components/ui/button";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import { cn } from "@/lib/utils/tailwind";

export interface AvailableSkillRow {
  id: string;
  name: string;
  description: string;
  scope: "org" | "team" | "personal";
  source: "native" | "external_mcp" | "plugin";
  providerName?: string | null;
}

/** Enough names to scan without paging, and few enough to load at once. */
export const AVAILABLE_SKILLS_PAGE_SIZE = 20;

/**
 * Read-only browser for policy discovery: names on the left, the picked
 * skill's whole description on the right. Descriptions run long, so the list
 * shows names only and the pane reads one skill in full. The panes keep a
 * fixed height, so paging and searching never move the dialog. On a phone
 * the list and the skill take turns, with Back between them.
 */
export function AvailableSkillsTable({
  rows,
  total,
  pagination,
  onPaginationChange,
  search,
  onSearchChange,
  isFetching,
  emptyMessage,
}: {
  rows: AvailableSkillRow[];
  total: number;
  pagination: PaginationState;
  onPaginationChange: (pagination: PaginationState) => void;
  search: string;
  onSearchChange: (search: string) => void;
  isFetching: boolean;
  emptyMessage: string;
}) {
  const [pickedId, setPickedId] = useState<string | null>(null);
  // Only a phone shows one pane at a time; this says which.
  const [reading, setReading] = useState(false);
  const picked = rows.find((row) => row.id === pickedId) ?? rows[0] ?? null;
  // A new page or search starts from its first skill and from the list.
  useEffect(() => {
    if (pickedId && !rows.some((row) => row.id === pickedId)) {
      setPickedId(null);
      setReading(false);
    }
  }, [rows, pickedId]);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <SearchInput
          placeholder="Search skills"
          value={search}
          onSearchChange={onSearchChange}
          syncQueryParams={false}
          isLoading={isFetching}
          className="min-w-0 flex-1"
        />
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
          {`${total.toLocaleString()} ${total === 1 ? "skill" : "skills"}`}
        </span>
      </div>
      <SkillsFrame>
        <div
          className={cn(
            "min-h-0 overflow-y-auto bg-muted/20 p-1 transition-opacity sm:border-r",
            isFetching && "opacity-60",
            reading && "max-sm:hidden",
          )}
        >
          {rows.length === 0 ? (
            <EmptyRows
              search={search}
              emptyMessage={emptyMessage}
              onClear={() => onSearchChange("")}
            />
          ) : (
            <ul aria-label="Skills" className="space-y-px">
              {rows.map((row) => {
                const on = picked?.id === row.id;
                return (
                  <li key={row.id}>
                    <UnstyledButton
                      type="button"
                      aria-current={on}
                      onClick={() => {
                        setPickedId(row.id);
                        setReading(true);
                      }}
                      onMouseEnter={() => setPickedId(row.id)}
                      className={cn(
                        "flex w-full flex-col rounded-md px-2.5 py-1.5 text-left",
                        on ? "sm:bg-background sm:shadow-xs" : "",
                        "hover:bg-muted/60",
                      )}
                    >
                      <span className="truncate text-sm font-medium">
                        {row.name}
                      </span>
                      <span className="truncate text-[11px] text-muted-foreground">
                        {sourceText(row)}
                      </span>
                    </UnstyledButton>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <div
          className={cn(
            "min-h-0 min-w-0 overflow-y-auto p-4 sm:p-5",
            !reading && "max-sm:hidden",
          )}
        >
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="-ml-2 mb-2 sm:hidden"
            onClick={() => setReading(false)}
          >
            <ArrowLeft />
            All skills
          </Button>
          {picked ? (
            <article className="space-y-3">
              <div className="flex items-start gap-3">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                  <BookOpen className="size-4" />
                </span>
                <div className="min-w-0">
                  <h3 className="break-words font-semibold">{picked.name}</h3>
                  <p className="text-xs text-muted-foreground">
                    {sourceText(picked)}
                  </p>
                </div>
              </div>
              <p className="whitespace-pre-line break-words text-sm leading-relaxed text-muted-foreground">
                {picked.description || "No description."}
              </p>
            </article>
          ) : (
            <p className="text-sm text-muted-foreground">
              Pick a skill to read what it does.
            </p>
          )}
        </div>
      </SkillsFrame>
      <Pager
        pagination={pagination}
        total={total}
        onPaginationChange={onPaginationChange}
      />
    </div>
  );
}

/** Loading and error states, in the same frame the list will fill. */
export function AvailableSkillsMessageTable({
  children,
  tone = "muted",
}: {
  children: ReactNode;
  tone?: "muted" | "error";
}) {
  return (
    <SkillsFrame single>
      <p
        className={cn(
          "self-center p-6 text-center text-sm",
          tone === "error" ? "text-destructive" : "text-muted-foreground",
        )}
      >
        {children}
      </p>
    </SkillsFrame>
  );
}

// ===

function SkillsFrame({
  single = false,
  children,
}: {
  single?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "grid h-[min(60dvh,26rem)] overflow-hidden rounded-lg border",
        single
          ? "grid-cols-1"
          : "grid-cols-1 sm:grid-cols-[minmax(0,15rem)_minmax(0,1fr)]",
      )}
    >
      {children}
    </div>
  );
}

/** "Skill library", or "adobe-for-creativity · Plugin". */
function sourceText(row: AvailableSkillRow): string {
  const kind =
    row.source === "native"
      ? "Skill library"
      : row.source === "plugin"
        ? "Plugin"
        : "MCP";
  return row.providerName ? `${row.providerName} · ${kind}` : kind;
}

/** "1–20 of 34" with previous and next, or nothing when one page holds all. */
function Pager({
  pagination,
  total,
  onPaginationChange,
}: {
  pagination: PaginationState;
  total: number;
  onPaginationChange: (pagination: PaginationState) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / pagination.pageSize));
  if (pages <= 1) return null;
  const from = pagination.pageIndex * pagination.pageSize + 1;
  const to = Math.min(total, from + pagination.pageSize - 1);
  return (
    <div className="flex items-center justify-end gap-1 text-xs text-muted-foreground">
      <span className="mr-1 tabular-nums">
        {from.toLocaleString()}–{to.toLocaleString()} of{" "}
        {total.toLocaleString()}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label="Previous page"
        disabled={pagination.pageIndex === 0}
        onClick={() =>
          onPaginationChange({
            ...pagination,
            pageIndex: pagination.pageIndex - 1,
          })
        }
      >
        <ChevronLeft />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label="Next page"
        disabled={pagination.pageIndex >= pages - 1}
        onClick={() =>
          onPaginationChange({
            ...pagination,
            pageIndex: pagination.pageIndex + 1,
          })
        }
      >
        <ChevronRight />
      </Button>
    </div>
  );
}

function EmptyRows({
  search,
  emptyMessage,
  onClear,
}: {
  search: string;
  emptyMessage: string;
  onClear: () => void;
}) {
  const query = search.trim();
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-3 py-10 text-center text-sm text-muted-foreground">
      {query ? (
        <>
          <p>No skills match “{query}”.</p>
          <Button type="button" variant="outline" size="sm" onClick={onClear}>
            Clear search
          </Button>
        </>
      ) : (
        <p>{emptyMessage}</p>
      )}
    </div>
  );
}
