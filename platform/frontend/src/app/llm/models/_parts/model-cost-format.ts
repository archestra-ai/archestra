const modelCostFormat = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 10,
});

export function formatModelCost(value: number): string {
  return modelCostFormat.format(value);
}
