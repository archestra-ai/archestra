"use client";
import { format } from "date-fns";
import { Card } from "@/components/ui/card";
import { formatCurrency } from "@/lib/utils/format-currency";
import { formatTokens } from "./_parts/usage-format";
import type { UsageViewProps } from "./usage-data";

export function UsageOverview({
  statistics,
}: Pick<UsageViewProps, "statistics">) {
  const items = [
    {
      label: "Billed spend",
      value: formatCurrency(statistics.billedCost),
      detail: "Metered API-key usage",
    },
    {
      label: "Subscription estimate",
      value: formatCurrency(statistics.subscriptionCost),
      detail: "Equivalent API rates; excludes subscription fees",
    },
    {
      label: "Requests",
      value: statistics.requests.toLocaleString(),
      detail: "Your LLM requests",
    },
    {
      label: "Tokens",
      value: formatTokens(statistics.totalTokens),
      detail: "Input and output; excludes cache reads",
    },
    {
      label: "Active days",
      value: statistics.activeDays.toLocaleString(),
      detail: statistics.lastActiveAt
        ? `Last active ${format(new Date(statistics.lastActiveAt), "MMM d, HH:mm")}`
        : "No recorded activity",
    },
  ];
  return (
    <section
      aria-label="Your usage"
      className="grid min-w-0 grid-cols-2 gap-3 lg:grid-cols-5"
    >
      {items.map((item) => (
        <Card
          key={item.label}
          className="min-w-0 gap-1 rounded-md p-4 shadow-none"
        >
          <span className="text-xs text-muted-foreground">{item.label}</span>
          <span className="text-2xl font-semibold tracking-tight tabular-nums">
            {item.value}
          </span>
          <span className="text-xs text-muted-foreground">{item.detail}</span>
        </Card>
      ))}
    </section>
  );
}
