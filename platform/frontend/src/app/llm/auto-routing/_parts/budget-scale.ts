// The `routing_plans.budget_usd_per_day` column bounds.
export const MIN_BUDGET = 0.01;
export const MAX_BUDGET = 9_999_999_999.99;

const SPAN = 20;
const STEPS = 200;

/**
 * A log-scale slider over budgets `SPAN`× either side of `saved`, clamped to
 * the column bounds and rounded to cents; the position nearest `saved` is
 * `saved` itself.
 */
export function budgetScale(saved: number) {
  const lo = Math.max(MIN_BUDGET, Math.ceil((saved / SPAN) * 100) / 100);
  const hi = Math.min(MAX_BUDGET, Math.floor(saved * SPAN * 100) / 100);
  const ratio = Math.log(hi / lo);
  const position = (budget: number) => (STEPS * Math.log(budget / lo)) / ratio;
  const savedPosition = position(saved);
  return {
    steps: STEPS,
    savedPosition,
    positionOf: (budget: number) =>
      Math.min(STEPS, Math.max(0, position(budget))),
    budgetAt(at: number): number {
      if (Math.abs(at - savedPosition) < 0.5) return saved;
      const cents = Math.round(lo * Math.exp((at / STEPS) * ratio) * 100);
      return Math.min(hi, Math.max(lo, cents / 100));
    },
  };
}
