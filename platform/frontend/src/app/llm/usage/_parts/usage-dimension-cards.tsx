"use client";

import type { archestraApiTypes } from "@archestra/shared";
import { BilledCost } from "@/components/billed-cost";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { formatTokens } from "./usage-format";

type MyStatistics = archestraApiTypes.GetMyStatisticsResponses["200"];
type MyUsageBreakdown = archestraApiTypes.GetMyUsageBreakdownResponses["200"];

export function ModelUsageCard({ models }: { models: MyStatistics["models"] }) {
  return (
    <UsageDimensionCard
      title="Models"
      description="Your model mix, ranked by input and output tokens."
      dimensionLabel="Model"
      emptyMessage="No model usage recorded for the selected timeframe."
      rows={models.map((model) => ({ ...model, label: model.model }))}
    />
  );
}

export function ClientUsageCard({
  clients,
}: {
  clients: MyUsageBreakdown["clients"];
}) {
  return (
    <UsageDimensionCard
      title="Clients"
      description="Where your requests came from, including connected coding clients."
      dimensionLabel="Client"
      emptyMessage="No client usage recorded for the selected timeframe."
      rows={clients.map((client) => ({
        ...client,
        label: client.client ?? "Not reported",
      }))}
    />
  );
}

type UsageRow = {
  label: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  percentage: number;
  billedCost: number;
  subscriptionCost: number;
};

function UsageDimensionCard({
  title,
  description,
  dimensionLabel,
  emptyMessage,
  rows,
}: {
  title: string;
  description: string;
  dimensionLabel: string;
  emptyMessage: string;
  rows: UsageRow[];
}) {
  return (
    <Card className="min-w-0">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-muted-foreground py-8 text-center text-sm">
            {emptyMessage}
          </p>
        ) : (
          <div className="max-h-[360px] min-w-0 overflow-auto rounded-md border">
            {/*
              Shared Table is `table-fixed` + wrap-break-word; without a floor
              width, phone viewports crush headers and figures into neighbouring
              columns. Scroll horizontally instead.
            */}
            <Table className="min-w-[70rem] table-auto">
              <TableHeader>
                <TableRow>
                  <TableHead className="bg-card sticky top-0 z-10 min-w-[12rem] max-w-[20rem] whitespace-nowrap">
                    {dimensionLabel}
                  </TableHead>
                  <TableHead className="bg-card sticky top-0 z-10 min-w-28 max-w-[12rem] whitespace-nowrap">
                    Share
                  </TableHead>
                  <TableHead className="bg-card sticky top-0 z-10 min-w-[7rem] max-w-[10rem] whitespace-nowrap text-right">
                    Requests
                  </TableHead>
                  <TableHead className="bg-card sticky top-0 z-10 min-w-[8rem] max-w-[12rem] whitespace-nowrap text-right">
                    Tokens
                  </TableHead>
                  <TableHead className="bg-card sticky top-0 z-10 min-w-[10rem] max-w-[16rem] whitespace-nowrap text-right">
                    Spend
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.label}>
                    <TableCell className="max-w-[20rem] font-medium">
                      <span className="block truncate" title={row.label}>
                        {row.label}
                      </span>
                    </TableCell>
                    <TableCell className="min-w-28">
                      <div className="flex items-center gap-2">
                        <div
                          className="bg-muted h-1.5 min-w-14 flex-1 overflow-hidden rounded-full"
                          role="img"
                          aria-label={`${row.label}: ${formatPercentage(row.percentage)} of tokens`}
                        >
                          <div
                            className="bg-primary h-full rounded-full"
                            style={{
                              width: `${Math.min(100, Math.max(0, row.percentage))}%`,
                            }}
                          />
                        </div>
                        <span className="text-muted-foreground w-11 text-right text-xs tabular-nums">
                          {formatPercentage(row.percentage)}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-right tabular-nums">
                      {row.requests.toLocaleString()}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-right tabular-nums">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="cursor-default underline decoration-dotted underline-offset-4">
                            {formatTokens(row.totalTokens)}
                          </span>
                        </TooltipTrigger>
                        <TooltipContent>
                          <div className="space-y-0.5 text-sm">
                            <div>Input: {row.inputTokens.toLocaleString()}</div>
                            <div>
                              Output: {row.outputTokens.toLocaleString()}
                            </div>
                            <div className="text-muted-foreground">
                              Cache reads:{" "}
                              {row.cacheReadTokens.toLocaleString()}
                            </div>
                          </div>
                        </TooltipContent>
                      </Tooltip>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-right">
                      <BilledCost
                        cost={String(row.billedCost + row.subscriptionCost)}
                        billedCost={String(row.billedCost)}
                        subscriptionCost={String(row.subscriptionCost)}
                        baselineCost={String(row.billedCost)}
                        tooltip="hover"
                        format="number"
                        subscriptionBadge="compact"
                        className="justify-end whitespace-nowrap"
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function formatPercentage(value: number): string {
  if (value > 0 && value < 0.1) return "<0.1%";
  return `${value.toFixed(1)}%`;
}
