"use client";

import type { archestraApiTypes, StatisticsTimeFrame } from "@archestra/shared";
import { useState } from "react";
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
import { QueryLoadError } from "@/components/query-load-error";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useProxyCostStatistics } from "@/lib/statistics.query";
import { formatStatisticsAxisLabel } from "./format-axis-label";

type AuthMethod = NonNullable<
  archestraApiTypes.GetProxyCostStatisticsData["query"]
>["authMethod"];

export function ProxyCostPanel({
  timeframe,
  enabled,
}: {
  timeframe: StatisticsTimeFrame;
  enabled: boolean;
}) {
  const [authMethod, setAuthMethod] = useState<AuthMethod>();
  const [credential, setCredential] = useState<{ id: string; name: string }>();
  const [offset, setOffset] = useState(0);
  const query = useProxyCostStatistics({
    timeframe,
    enabled,
    authMethod,
    credentialId: credential?.id,
    offset,
    limit: PAGE_SIZE,
  });
  const { data } = query;
  const reset = () => {
    setAuthMethod(undefined);
    setCredential(undefined);
    setOffset(0);
  };
  const totals = data?.totals;
  return (
    <Card>
      <CardHeader>
        <CardTitle>LLM Proxy</CardTitle>
        <CardDescription>
          See which keys and applications drive proxy spend.
        </CardDescription>
        {(authMethod || credential) && (
          <div className="flex items-center gap-3 text-sm">
            <span>
              {credential?.name ?? METHOD_NAMES[authMethod ?? "unknown"]}
            </span>
            <Button variant="ghost" size="sm" onClick={reset}>
              Clear filter
            </Button>
          </div>
        )}
      </CardHeader>
      <CardContent className="space-y-6">
        {query.isError ? (
          <QueryLoadError
            title="Could not load proxy costs"
            onRetry={() => query.refetch()}
          />
        ) : query.isPending ? (
          <Skeleton className="h-96 w-full" />
        ) : !data || !totals?.requests ? (
          <p className="py-16 text-center text-muted-foreground">
            No proxy requests for this timeframe and filter.
          </p>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-5 lg:grid-cols-4">
              {[
                ["Billed spend", dollars(totals.billedCost)],
                [
                  "Subscription-covered estimate",
                  dollars(totals.subscriptionCost),
                ],
                ["Requests", totals.requests.toLocaleString()],
                [
                  "Tokens (input + output)",
                  (totals.inputTokens + totals.outputTokens).toLocaleString(),
                ],
              ].map(([label, value]) => (
                <div key={label}>
                  <p className="text-xs text-muted-foreground">{label}</p>
                  <p className="mt-1 text-2xl tabular-nums">{value}</p>
                </div>
              ))}
            </div>
            <ChartContainer
              config={{
                billedCost: { label: "Billed spend", color: "var(--chart-1)" },
              }}
              className="h-64 w-full aspect-auto"
            >
              <LineChart
                accessibilityLayer
                data={data.timeSeries.map((point) => ({
                  ...point,
                  label: formatStatisticsAxisLabel(point.timestamp, timeframe),
                }))}
                margin={{ top: 12, left: 12, right: 12 }}
              >
                <CartesianGrid vertical={false} />
                <XAxis
                  dataKey="label"
                  tickLine={false}
                  axisLine={false}
                  tickMargin={8}
                />
                <YAxis
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={(value) => `$${value}`}
                />
                <ChartTooltip
                  content={
                    <ChartTooltipContent
                      formatter={(value) => (
                        <span>{dollars(Number(value))}</span>
                      )}
                    />
                  }
                />
                <Line
                  dataKey="billedCost"
                  type="monotone"
                  stroke="var(--color-billedCost)"
                  strokeWidth={2}
                  dot={{ r: 3 }}
                />
              </LineChart>
            </ChartContainer>
            <p className="text-xs text-muted-foreground">
              Select a credential to focus the trend.
            </p>
            <div className="overflow-x-auto rounded-md border">
              <Table className="min-w-[680px]">
                <TableHeader>
                  <TableRow>
                    <TableHead>Credential</TableHead>
                    <TableHead>Access method</TableHead>
                    <TableHead className="text-right">Requests</TableHead>
                    <TableHead className="text-right">Tokens</TableHead>
                    <TableHead className="text-right">Billed spend</TableHead>
                    <TableHead className="text-right">
                      Subscription estimate
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.credentials.map((row) => (
                    <TableRow key={`${row.authMethod}:${row.credentialId}`}>
                      <TableCell className="max-w-[280px]">
                        {row.credentialId ? (
                          <Button
                            variant="link"
                            className="h-auto max-w-full p-0"
                            onClick={() => {
                              setCredential({
                                id: row.credentialId as string,
                                name:
                                  row.credentialName ??
                                  (row.credentialId as string),
                              });
                              setAuthMethod(row.authMethod);
                              setOffset(0);
                            }}
                          >
                            <span className="truncate" title={row.credentialId}>
                              {row.credentialName ?? row.credentialId}
                            </span>
                          </Button>
                        ) : (
                          <span className="text-muted-foreground">
                            {[
                              "virtual_key",
                              "passthrough_virtual_key",
                              "oauth_client_credentials",
                            ].includes(row.authMethod)
                              ? "Deleted or unavailable credential"
                              : "Not individually attributed"}
                          </span>
                        )}
                      </TableCell>
                      <TableCell>{METHOD_NAMES[row.authMethod]}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {row.requests.toLocaleString()}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {(row.inputTokens + row.outputTokens).toLocaleString()}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {dollars(row.billedCost)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {dollars(row.subscriptionCost)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            {data.pagination.total > PAGE_SIZE && (
              <div className="flex items-center justify-end gap-3">
                <span className="text-sm text-muted-foreground">
                  {offset + 1}–
                  {Math.min(offset + PAGE_SIZE, data.pagination.total)} of{" "}
                  {data.pagination.total}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={offset === 0}
                  onClick={() => setOffset(offset - PAGE_SIZE)}
                >
                  Previous
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={offset + PAGE_SIZE >= data.pagination.total}
                  onClick={() => setOffset(offset + PAGE_SIZE)}
                >
                  Next
                </Button>
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              Each request is counted once by its primary access method.
              Subscription estimates are list-price equivalents, not billed
              spend. Provider keys and user sign-ins are grouped by method.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

const PAGE_SIZE = 10;
const METHOD_NAMES: Record<NonNullable<AuthMethod>, string> = {
  virtual_key: "Virtual key",
  passthrough_virtual_key: "Passthrough virtual key",
  oauth_client_credentials: "OAuth client credentials",
  oauth_user: "OAuth user sign-in",
  jwks: "JWT / JWKS",
  provider_key: "Provider key",
  internal: "Internal",
  unknown: "Unknown / legacy",
};
function dollars(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: value > 0 && value < 0.01 ? 6 : 2,
  }).format(value);
}
