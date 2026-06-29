export function formatCost(value: number) {
  if (value < 0.000001) return `$${value.toExponential(2)}`;
  if (value < 0.01) return `$${value.toFixed(6)}`;
  return `$${value.toFixed(4)}`;
}

export function Cost({
  cost,
  className,
}: {
  cost: string;
  className?: string;
}) {
  const costNum = Number.parseFloat(cost);
  return <span className={className}>{formatCost(costNum)}</span>;
}
