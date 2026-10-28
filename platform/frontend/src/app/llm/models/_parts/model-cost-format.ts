import { formatCurrency } from "@/lib/utils/format-currency";

const modelCostFormat = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 10,
});

export function formatModelCost(value: number): string {
  return modelCostFormat.format(value);
}

/** Shorter USD for the stat strip: drops cents from $1,000, compacts from $100k. */
export function formatUsdShort(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 100_000) {
    return `${n < 0 ? "-" : ""}$${(abs / 1000).toLocaleString("en-US", {
      maximumFractionDigits: 1,
    })}k`;
  }
  if (abs >= 1000) {
    return n.toLocaleString("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 0,
    });
  }
  return abs > 0 && abs < 0.01 ? formatModelCost(n) : formatCurrency(n);
}
