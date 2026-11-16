"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { Lightbulb } from "lucide-react";
import { useState } from "react";
import {
  CollectionFilters,
  FilterBar,
  FilterSelect,
} from "@/components/filter-bar";
import { LogTime } from "@/components/log-time";
import { QueryLoadError } from "@/components/query-load-error";
import { Badge } from "@/components/ui/badge";
import { DataTable } from "@/components/ui/data-table";
import { DEFAULT_FILTER_ALL } from "@/consts";
import {
  type TunerKind,
  type TunerSuggestion,
  type TunerSuggestionStatus,
  useTunerSuggestions,
} from "@/lib/tuners.query";
import { SuggestionSheet } from "./suggestion-sheet";
import {
  SEVERITY,
  STATUS_LABEL,
  SUGGESTION_STATUSES,
  TUNER_KINDS,
  TUNER_LABEL,
} from "./tuner-labels";

export function SuggestionsInbox({ canUpdate }: { canUpdate: boolean }) {
  const [status, setStatus] = useState<TunerSuggestionStatus>("open");
  const [kind, setKind] = useState<TunerKind | typeof DEFAULT_FILTER_ALL>(
    DEFAULT_FILTER_ALL,
  );
  const [pagination, setPagination] = useState({ pageIndex: 0, pageSize: 20 });
  const [selected, setSelected] = useState<TunerSuggestion | null>(null);
  const suggestions = useTunerSuggestions({
    status,
    kind: kind === DEFAULT_FILTER_ALL ? undefined : kind,
    limit: pagination.pageSize,
    offset: pagination.pageIndex * pagination.pageSize,
  });
  const resetPage = () =>
    setPagination((current) => ({ ...current, pageIndex: 0 }));

  return (
    <section aria-labelledby="suggestions-heading" className="space-y-3">
      <h2 id="suggestions-heading" className="text-base font-semibold">
        Suggestions
      </h2>
      <CollectionFilters>
        <FilterBar>
          <FilterSelect
            value={status}
            inactiveValue="open"
            ariaLabel="Suggestion status"
            placeholder="Status"
            showSearch={false}
            items={SUGGESTION_STATUSES.map((value) => ({
              value,
              label: STATUS_LABEL[value],
            }))}
            onValueChange={(value) => {
              const next = SUGGESTION_STATUSES.find((each) => each === value);
              if (next) setStatus(next);
              resetPage();
            }}
          />
          <FilterSelect
            value={kind}
            ariaLabel="Tuner"
            placeholder="Tuner"
            showSearch={false}
            items={[
              { value: DEFAULT_FILTER_ALL, label: "All tuners" },
              ...TUNER_KINDS.map((value) => ({
                value,
                label: TUNER_LABEL[value],
              })),
            ]}
            onValueChange={(value) => {
              setKind(
                TUNER_KINDS.find((each) => each === value) ??
                  DEFAULT_FILTER_ALL,
              );
              resetPage();
            }}
          />
        </FilterBar>
      </CollectionFilters>
      {suggestions.isError ? (
        <QueryLoadError
          title="Couldn't load suggestions"
          error={suggestions.error}
          onRetry={() => suggestions.refetch()}
          className="h-auto"
        />
      ) : (
        <DataTable
          columns={COLUMNS}
          fixedWidthColumnIds={["severity", "tuner", "created"]}
          flexibleColumnIds={["title"]}
          data={suggestions.data?.data ?? []}
          getRowId={(row) => row.id}
          isLoading={suggestions.isPending}
          manualPagination
          pagination={{
            ...pagination,
            total: suggestions.data?.pagination.total ?? 0,
          }}
          onPaginationChange={setPagination}
          emptyIcon={Lightbulb}
          emptyMessage={`No ${STATUS_LABEL[status].toLowerCase()} suggestions`}
          emptyDescription="Tuners file suggestions here after each run."
          onRowClick={setSelected}
        />
      )}
      <SuggestionSheet
        suggestion={selected}
        canUpdate={canUpdate}
        onChange={setSelected}
      />
    </section>
  );
}

// === Internal helpers

const COLUMNS: ColumnDef<TunerSuggestion>[] = [
  {
    id: "severity",
    header: "Severity",
    size: 104,
    cell: ({ row }) => {
      const severity = SEVERITY[row.original.severity];
      return <Badge variant={severity.variant}>{severity.label}</Badge>;
    },
  },
  {
    id: "title",
    header: "Suggestion",
    size: 360,
    cell: ({ row }) => (
      <span className="line-clamp-2 font-medium">{row.original.title}</span>
    ),
  },
  {
    id: "tuner",
    header: "Tuner",
    size: 120,
    cell: ({ row }) => TUNER_LABEL[row.original.tunerKind],
  },
  {
    id: "created",
    header: "Created",
    size: 104,
    cell: ({ row }) => <LogTime timestamp={row.original.createdAt} />,
  },
];
