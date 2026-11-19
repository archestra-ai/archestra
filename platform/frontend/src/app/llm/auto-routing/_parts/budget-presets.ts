import type { AutoRouter } from "@/lib/auto-routing.query";

export type BudgetPreset = NonNullable<AutoRouter["budgetPreset"]>;

export const BUDGET_PRESET_LABELS: Record<BudgetPreset, string> = {
  cost_efficient: "Cost-efficient",
  balanced: "Balanced",
  intelligence: "Intelligence",
};
