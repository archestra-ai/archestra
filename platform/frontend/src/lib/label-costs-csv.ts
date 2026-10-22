import type { archestraApiTypes } from "@archestra/shared";

type Groups = NonNullable<
  archestraApiTypes.GetProxyCostStatisticsResponses["200"]["labels"]
>["groups"];

export function labelCostsCsv({
  key,
  groups,
}: {
  key: string;
  groups: Groups;
}): string {
  const rows = [
    [
      "label_key",
      "label_value",
      "assigned",
      "requests",
      "input_tokens",
      "output_tokens",
      "cache_read_tokens",
      "billed_cost_usd",
      "subscription_estimate_usd",
    ],
    ...groups.map((row) => [
      key,
      row.value ?? "",
      row.value !== null,
      row.requests,
      row.inputTokens,
      row.outputTokens,
      row.cacheReadTokens,
      row.billedCost,
      row.subscriptionCost,
    ]),
  ];
  return rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
}

function csvCell(value: string | number | boolean): string {
  let text = String(value);
  // Labels are administrator input, not spreadsheet formulas.
  if (typeof value === "string" && /^[=+@\-\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}
