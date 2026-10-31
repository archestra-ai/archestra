import {
  AGENT_RUNTIME_TIER_MAX_CPU_LIMIT,
  AGENT_RUNTIME_TIER_MAX_CPU_REQUEST,
  AGENT_RUNTIME_TIER_MAX_WARM_SPARES,
  type AgentRuntimeTierSettingsInput,
  agentRuntimeTierMemory,
  agentRuntimeTierProblems,
  DEFAULT_AGENT_RUNTIME_TIERS,
  sortAgentRuntimeTiers,
} from "@archestra/shared";

/** The resolved tiers as the API returns them. */
export interface RuntimeTierSize {
  name: string;
  cpuRequest: number;
  cpuLimit: number | null;
  warmSpares: number;
  memoryRequestMiB: number;
  memoryLimitMiB: number;
}

/** One row of the form: text as typed, plus the name the tier had when loaded. */
export interface RuntimeTierRow {
  /** Stable while the row is on screen; rows move but never change key. */
  key: string;
  /** The saved name this row started from; null for a row added since. */
  originalName: string | null;
  name: string;
  cpuRequest: string;
  cpuLimit: string;
  warmSpares: string;
}

export interface RuntimeTierDraft {
  rows: RuntimeTierRow[];
  /** The key of the default tier's row. */
  defaultKey: string;
}

export const RUNTIME_TIER_COLUMNS = {
  name: "Tier",
  cpuRequest: "CPU request",
  cpuLimit: "CPU limit",
  memory: "Memory",
  warmSpares: "Ready spares",
} as const;
export type RuntimeTierSortColumn = Exclude<
  keyof typeof RUNTIME_TIER_COLUMNS,
  "memory"
>;

let nextKey = 0;
function rowKey(): string {
  nextKey += 1;
  return `tier-${nextKey}`;
}

/** The form's rows for the tiers in effect, smallest first. */
export function runtimeTierDraft(
  resolved: { tiers: RuntimeTierSize[]; defaultTier: string } | undefined,
): RuntimeTierDraft {
  const tiers = resolved
    ? sortAgentRuntimeTiers(resolved.tiers)
    : sortAgentRuntimeTiers(DEFAULT_AGENT_RUNTIME_TIERS.tiers).map((tier) => ({
        ...tier,
        warmSpares: tier.warmSpares ?? 0,
      }));
  const rows = tiers.map((tier) => ({
    key: rowKey(),
    originalName: tier.name,
    name: tier.name,
    cpuRequest: String(tier.cpuRequest),
    cpuLimit: tier.cpuLimit === null ? "" : String(tier.cpuLimit),
    warmSpares: String(tier.warmSpares),
  }));
  const defaultName =
    resolved?.defaultTier ?? DEFAULT_AGENT_RUNTIME_TIERS.defaultTier;
  return {
    rows,
    defaultKey:
      rows.find((row) => row.name.toLowerCase() === defaultName.toLowerCase())
        ?.key ??
      rows[0]?.key ??
      "",
  };
}

/** A row for a tier the administrator is adding. */
export function newRuntimeTierRow(): RuntimeTierRow {
  return {
    key: rowKey(),
    originalName: null,
    name: "",
    cpuRequest: "",
    cpuLimit: "",
    warmSpares: "0",
  };
}

/** A number typed into a field, or null when the text is not one. */
export function parseNumberField(text: string): number | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const value = Number(trimmed.replace(",", "."));
  return Number.isFinite(value) ? value : null;
}

/** The memory a row's CPU gives it, once the CPU request is a number. */
export function runtimeTierRowMemory(
  row: RuntimeTierRow,
): { memoryRequestMiB: number; memoryLimitMiB: number } | null {
  const cpuRequest = parseNumberField(row.cpuRequest);
  if (cpuRequest === null || cpuRequest <= 0) return null;
  const cpuLimit = parseNumberField(row.cpuLimit);
  return agentRuntimeTierMemory(
    cpuRequest,
    cpuLimit !== null && cpuLimit > 0 ? cpuLimit : null,
  );
}

/** Rows sorted by a column; ties and blank numbers keep their current order. */
export function sortRuntimeTierRows(
  rows: RuntimeTierRow[],
  column: RuntimeTierSortColumn,
  direction: "asc" | "desc",
): RuntimeTierRow[] {
  const sign = direction === "asc" ? 1 : -1;
  const value = (row: RuntimeTierRow): number | string => {
    if (column === "name") return row.name.trim().toLowerCase();
    const number = parseNumberField(row[column]);
    if (number !== null) return number;
    // Blank CPU limit means no limit, the largest; a blank elsewhere sorts last.
    return column === "cpuLimit"
      ? Number.POSITIVE_INFINITY
      : Number.POSITIVE_INFINITY;
  };
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const left = value(a.row);
      const right = value(b.row);
      const order =
        typeof left === "string" && typeof right === "string"
          ? left.localeCompare(right)
          : Number(left) - Number(right);
      return (Number.isNaN(order) ? 0 : order) * sign || a.index - b.index;
    })
    .map(({ row }) => row);
}

/**
 * What the form would save, or the problems that stop a save: a field that
 * is not a number, a value outside its range, a repeated name, or no default.
 */
export function validateRuntimeTierDraft(
  draft: RuntimeTierDraft,
):
  | { ok: true; settings: AgentRuntimeTierSettingsInput }
  | { ok: false; problems: string[] } {
  const problems: string[] = [];
  const tiers: AgentRuntimeTierSettingsInput["tiers"] = [];
  for (const row of draft.rows) {
    const label = row.name.trim()
      ? `Tier ${row.name.trim()}`
      : "A tier without a name";
    const cpuRequest = parseNumberField(row.cpuRequest);
    if (cpuRequest === null)
      problems.push(
        `${label}: enter a CPU request from 0.1 to ${AGENT_RUNTIME_TIER_MAX_CPU_REQUEST}`,
      );
    const cpuLimit = row.cpuLimit.trim()
      ? parseNumberField(row.cpuLimit)
      : null;
    if (row.cpuLimit.trim() && cpuLimit === null)
      problems.push(
        `${label}: enter a CPU limit up to ${AGENT_RUNTIME_TIER_MAX_CPU_LIMIT}, or leave it blank for no limit`,
      );
    const warmSpares = parseNumberField(row.warmSpares);
    if (warmSpares === null)
      problems.push(
        `${label}: enter how many spares to keep ready, 0 to ${AGENT_RUNTIME_TIER_MAX_WARM_SPARES}`,
      );
    tiers.push({
      name: row.name.trim(),
      cpuRequest: cpuRequest ?? 0,
      cpuLimit,
      warmSpares: warmSpares ?? 0,
      ...(row.originalName !== null && row.originalName !== row.name.trim()
        ? { previousName: row.originalName }
        : {}),
    });
  }
  const defaultRow = draft.rows.find((row) => row.key === draft.defaultKey);
  const settings: AgentRuntimeTierSettingsInput = {
    tiers,
    defaultTier: defaultRow?.name.trim() ?? "",
  };
  if (problems.length === 0)
    problems.push(...agentRuntimeTierProblems(settings));
  return problems.length ? { ok: false, problems } : { ok: true, settings };
}

export function runtimeTierDraftChanged(
  draft: RuntimeTierDraft,
  saved: RuntimeTierDraft,
): boolean {
  if (draft.rows.length !== saved.rows.length) return true;
  const defaultName = (value: RuntimeTierDraft) =>
    value.rows.find((row) => row.key === value.defaultKey)?.name.trim() ?? "";
  if (defaultName(draft) !== defaultName(saved)) return true;
  const text = (row: RuntimeTierRow) =>
    [
      row.originalName ?? "",
      row.name,
      row.cpuRequest,
      row.cpuLimit,
      row.warmSpares,
    ]
      .map((value) => value.trim())
      .join("\u0000");
  const left = draft.rows.map(text).sort();
  const right = saved.rows.map(text).sort();
  return left.some((value, index) => value !== right[index]);
}
