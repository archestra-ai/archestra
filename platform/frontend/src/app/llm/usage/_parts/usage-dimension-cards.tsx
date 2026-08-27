"use client";

import type { archestraApiTypes } from "@archestra/shared";
import { subHours } from "date-fns";
import { BilledCost } from "@/components/billed-cost";
import { RelativeTime } from "@/components/relative-time";
import { Badge } from "@/components/ui/badge";
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
      description="Connections seen through the proxy, with their latest activity and usage."
      dimensionLabel="Client"
      emptyMessage="No client usage recorded for the selected timeframe."
      showActivity
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
  lastActiveAt?: string;
};

function UsageDimensionCard({
  title,
  description,
  dimensionLabel,
  emptyMessage,
  rows,
  showActivity = false,
}: {
  title: string;
  description: string;
  dimensionLabel: string;
  emptyMessage: string;
  rows: UsageRow[];
  showActivity?: boolean;
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
          <div className="max-h-[360px] overflow-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead
                    className={
                      showActivity
                        ? "bg-card sticky top-0 z-10 w-36 min-w-36"
                        : "bg-card sticky top-0 z-10 min-w-36"
                    }
                  >
                    {dimensionLabel}
                  </TableHead>
                  <TableHead
                    className={
                      showActivity
                        ? "bg-card sticky top-0 z-10 hidden lg:table-cell"
                        : "bg-card sticky top-0 z-10"
                    }
                  >
                    Share
                  </TableHead>
                  {showActivity && (
                    <TableHead className="bg-card sticky top-0 z-10">
                      Status
                    </TableHead>
                  )}
                  <TableHead className="bg-card sticky top-0 z-10 whitespace-nowrap text-right">
                    Requests
                  </TableHead>
                  <TableHead className="bg-card sticky top-0 z-10 text-right">
                    Tokens
                  </TableHead>
                  <TableHead className="bg-card sticky top-0 z-10 text-right">
                    Spend
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.label}>
                    <TableCell
                      className={
                        showActivity
                          ? "w-36 min-w-36 whitespace-nowrap font-medium"
                          : "max-w-[20ch] min-w-36 font-medium"
                      }
                    >
                      <span
                        className={showActivity ? undefined : "block truncate"}
                        title={row.label}
                      >
                        {row.label}
                      </span>
                    </TableCell>
                    <TableCell
                      className={
                        showActivity ? "hidden lg:table-cell" : "min-w-28"
                      }
                    >
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
                    {showActivity && (
                      <TableCell className="min-w-36">
                        <ClientActivity lastActiveAt={row.lastActiveAt} />
                      </TableCell>
                    )}
                    <TableCell className="text-right tabular-nums">
                      {row.requests.toLocaleString()}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
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
                    <TableCell className="text-right">
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

function ClientActivity({ lastActiveAt }: { lastActiveAt?: string }) {
  if (!lastActiveAt) return null;

  const lastActiveDate = new Date(lastActiveAt);
  const isActive = lastActiveDate >= subHours(new Date(), 24);

  return (
    <div className="flex flex-col items-start gap-1.5">
      <Badge variant="outline" className="gap-1.5 font-normal">
        <span
          className={
            isActive
              ? "size-1.5 rounded-full bg-emerald-500"
              : "size-1.5 rounded-full bg-muted-foreground"
          }
          aria-hidden="true"
        />
        <span>{isActive ? "Active" : "Idle"}</span>
      </Badge>
      <RelativeTime date={lastActiveAt} className="text-xs" />
    </div>
  );
}

function formatPercentage(value: number): string {
  if (value > 0 && value < 0.1) return "<0.1%";
  return `${value.toFixed(1)}%`;
}
