import {
  AGENT_RUNTIME_TIER_MAX_COUNT,
  AGENT_RUNTIME_TIER_MAX_CPU_LIMIT,
  AGENT_RUNTIME_TIER_MAX_CPU_REQUEST,
  AGENT_RUNTIME_TIER_MAX_WARM_SPARES,
  formatMemory,
} from "@archestra/shared";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { SettingsBlock } from "@/components/settings/settings-block";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils/tailwind";
import {
  newRuntimeTierRow,
  RUNTIME_TIER_COLUMNS,
  type RuntimeTierDraft,
  type RuntimeTierRow,
  type RuntimeTierSortColumn,
  runtimeTierRowMemory,
  sortRuntimeTierRows,
} from "./runtime-tiers-draft";

const SORTABLE: RuntimeTierSortColumn[] = [
  "name",
  "cpuRequest",
  "cpuLimit",
  "warmSpares",
];
const NUMERIC = new Set<keyof typeof RUNTIME_TIER_COLUMNS>([
  "cpuRequest",
  "cpuLimit",
  "memory",
  "warmSpares",
]);

/** The name a row is known by in labels: its tier name, or "new tier" until it has one. */
function rowLabel(row: RuntimeTierRow): string {
  return row.name.trim() || "new tier";
}

export function RuntimeTiersBlock({
  value,
  onChange,
  problems,
  canEdit,
}: {
  value: RuntimeTierDraft;
  onChange: (draft: RuntimeTierDraft) => void;
  problems: string[];
  canEdit: boolean;
}) {
  // Rows keep their place while they are edited; a header click reorders
  // them, and a reload lists them smallest first.
  const [sort, setSort] = useState<{
    column: RuntimeTierSortColumn;
    direction: "asc" | "desc";
  }>({ column: "cpuRequest", direction: "asc" });
  const sortBy = (column: RuntimeTierSortColumn) => {
    const direction =
      sort.column === column && sort.direction === "asc" ? "desc" : "asc";
    setSort({ column, direction });
    onChange({
      ...value,
      rows: sortRuntimeTierRows(value.rows, column, direction),
    });
  };
  const updateRow = (key: string, patch: Partial<RuntimeTierRow>) =>
    onChange({
      ...value,
      rows: value.rows.map((row) =>
        row.key === key ? { ...row, ...patch } : row,
      ),
    });
  const removeRow = (key: string) => {
    const rows = value.rows.filter((row) => row.key !== key);
    onChange({
      ...value,
      rows,
      defaultKey:
        value.defaultKey === key ? (rows[0]?.key ?? "") : value.defaultKey,
    });
  };
  const addRow = () => {
    const row = newRuntimeTierRow();
    onChange({
      ...value,
      rows: [...value.rows, row],
      defaultKey: value.defaultKey || row.key,
    });
  };

  return (
    <SettingsBlock
      id="runtime-tiers"
      title="Runtime tiers"
      description={
        <>
          The container sizes a run can have. Each tier sets the CPU a run gets.
          Memory follows: 2 GiB per requested CPU, with a limit of twice the
          request, or less when a CPU limit allows less. An agent names its
          default tier and the largest tier its runs may scale up to. Ready
          spares are containers of a tier kept running and empty, so a run on
          one starts in seconds; each holds its CPU and memory while it waits.
        </>
      }
      notice={
        canEdit ? undefined : (
          <span className="text-muted-foreground">
            Only administrators can change the tiers.
          </span>
        )
      }
    >
      <RadioGroup
        value={value.defaultKey}
        onValueChange={(defaultKey) => onChange({ ...value, defaultKey })}
        disabled={!canEdit}
        aria-label="Default tier"
      >
        {/* Narrow screens scroll the table sideways rather than squeeze it. */}
        <Table className="min-w-[54rem]">
          <TableHeader>
            <TableRow>
              {(
                Object.keys(RUNTIME_TIER_COLUMNS) as Array<
                  keyof typeof RUNTIME_TIER_COLUMNS
                >
              ).map((column) => {
                const sortable = SORTABLE.includes(
                  column as RuntimeTierSortColumn,
                );
                const active = sort.column === column;
                const Glyph = sort.direction === "asc" ? ArrowUp : ArrowDown;
                return (
                  <TableHead
                    key={column}
                    className={cn(
                      "whitespace-nowrap",
                      NUMERIC.has(column) && "text-right",
                    )}
                    aria-sort={
                      active
                        ? sort.direction === "asc"
                          ? "ascending"
                          : "descending"
                        : undefined
                    }
                  >
                    {sortable ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        className={cn(
                          "-mx-2 font-normal text-muted-foreground",
                          active && "text-foreground",
                        )}
                        onClick={() => sortBy(column as RuntimeTierSortColumn)}
                      >
                        <span>{RUNTIME_TIER_COLUMNS[column]}</span>
                        {active && (
                          <Glyph aria-hidden="true" className="size-3.5" />
                        )}
                      </Button>
                    ) : (
                      <span>{RUNTIME_TIER_COLUMNS[column]}</span>
                    )}
                  </TableHead>
                );
              })}
              <TableHead className="whitespace-nowrap text-center">
                Default
              </TableHead>
              <TableHead className="w-10">
                <span className="sr-only">Remove</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {value.rows.map((row) => {
              const label = rowLabel(row);
              const memory = runtimeTierRowMemory(row);
              return (
                <TableRow key={row.key}>
                  <TableCell>
                    <Input
                      aria-label={`Tier ${label} name`}
                      disabled={!canEdit}
                      placeholder="Name"
                      value={row.name}
                      onChange={(event) =>
                        updateRow(row.key, { name: event.target.value })
                      }
                    />
                  </TableCell>
                  <TableCell>
                    <Input
                      aria-label={`Tier ${label} CPU request`}
                      className="text-right tabular-nums"
                      disabled={!canEdit}
                      inputMode="decimal"
                      type="number"
                      min={0.1}
                      max={AGENT_RUNTIME_TIER_MAX_CPU_REQUEST}
                      step={0.5}
                      value={row.cpuRequest}
                      onChange={(event) =>
                        updateRow(row.key, { cpuRequest: event.target.value })
                      }
                    />
                  </TableCell>
                  <TableCell>
                    <Input
                      aria-label={`Tier ${label} CPU limit`}
                      className="text-right tabular-nums"
                      disabled={!canEdit}
                      inputMode="decimal"
                      type="number"
                      min={0.1}
                      max={AGENT_RUNTIME_TIER_MAX_CPU_LIMIT}
                      step={0.5}
                      placeholder="No limit"
                      value={row.cpuLimit}
                      onChange={(event) =>
                        updateRow(row.key, { cpuLimit: event.target.value })
                      }
                    />
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {memory ? (
                      <>
                        <span>{formatMemory(memory.memoryRequestMiB)}</span>
                        <span className="block text-xs text-muted-foreground">
                          {formatMemory(memory.memoryLimitMiB)} limit
                        </span>
                      </>
                    ) : (
                      <span className="text-muted-foreground">–</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <Input
                      aria-label={`Tier ${label} ready spares`}
                      className="text-right tabular-nums"
                      disabled={!canEdit}
                      inputMode="numeric"
                      type="number"
                      min={0}
                      max={AGENT_RUNTIME_TIER_MAX_WARM_SPARES}
                      step={1}
                      value={row.warmSpares}
                      onChange={(event) =>
                        updateRow(row.key, { warmSpares: event.target.value })
                      }
                    />
                  </TableCell>
                  <TableCell className="text-center">
                    <RadioGroupItem
                      value={row.key}
                      aria-label={`Default tier ${label}`}
                    />
                  </TableCell>
                  <TableCell>
                    {canEdit && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        aria-label={`Remove tier ${label}`}
                        disabled={value.rows.length <= 1}
                        onClick={() => removeRow(row.key)}
                      >
                        <Trash2 aria-hidden="true" />
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </RadioGroup>
      {canEdit && (
        <div className="mt-3 flex items-center gap-3">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={addRow}
            disabled={value.rows.length >= AGENT_RUNTIME_TIER_MAX_COUNT}
          >
            <Plus aria-hidden="true" />
            <span>Add tier</span>
          </Button>
          <span className="text-xs text-muted-foreground">
            CPU request up to {AGENT_RUNTIME_TIER_MAX_CPU_REQUEST}, CPU limit up
            to {AGENT_RUNTIME_TIER_MAX_CPU_LIMIT}, ready spares 0 to{" "}
            {AGENT_RUNTIME_TIER_MAX_WARM_SPARES}.
          </span>
        </div>
      )}
      {problems.length > 0 && (
        <ul
          aria-label="Runtime tier problems"
          className="mt-3 space-y-1 text-sm text-destructive"
          role="alert"
        >
          {problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      )}
    </SettingsBlock>
  );
}
