import type { BatchAnalysisDetail } from "@/lib/batch-analysis/batch-analysis.query";

type CellFlag = NonNullable<BatchAnalysisDetail["cells"][number]["flag"]>;

/**
 * Display metadata for the model-assigned triage flag. The semantics mirror
 * the extraction contract: green = standard/favourable, yellow = needs
 * attention, red = problematic, grey = neutral or not found.
 */
export const CELL_FLAG_META: Record<
  CellFlag,
  { label: string; dotClass: string }
> = {
  green: { label: "Standard", dotClass: "bg-emerald-500" },
  yellow: { label: "Needs attention", dotClass: "bg-amber-400" },
  red: { label: "Problematic", dotClass: "bg-red-500" },
  grey: { label: "Neutral", dotClass: "bg-muted-foreground/50" },
};
