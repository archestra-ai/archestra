"use client";

import type { StatisticsTimeFrame } from "@archestra/shared";
import { ClipboardCopy } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { QueryLoadError } from "@/components/query-load-error";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useHasPermissions } from "@/lib/auth/auth.query";
import {
  useCopyLabelCosts,
  useProxyLabelCosts,
} from "@/lib/proxy-label-costs.query";

type Filters = { key: string; value: string; unassigned: boolean };

export function LabelAttributionPanel({
  timeframe,
  enabled,
}: {
  timeframe: StatisticsTimeFrame;
  enabled: boolean;
}) {
  const { data: canReadCosts } = useHasPermissions({ llmCost: ["read"] });
  const [filters, setFilters] = useState<Filters>({
    key: "cost_center",
    value: "",
    unassigned: false,
  });
  const form = useForm<Filters>({ defaultValues: filters });
  const query = useProxyLabelCosts({
    timeframe,
    labelKey: filters.key,
    labelValue:
      filters.unassigned || !filters.value ? undefined : filters.value,
    labelUnassigned: filters.unassigned ? "true" : undefined,
    enabled: enabled && canReadCosts === true,
  });
  const copy = useCopyLabelCosts();
  if (canReadCosts !== true) return null;
  const groups = [...(query.data?.groups ?? [])].sort(
    (a, b) => b.billedCost - a.billedCost,
  );
  const unassigned = groups.find((row) => row.value === null);
  return (
    <Card aria-label="Cost attribution">
      <CardHeader>
        <CardTitle>Cost attribution</CardTitle>
        <CardDescription>
          Group proxy spend by labels recorded when each request started. Later
          label edits keep historical reports unchanged.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={form.handleSubmit((values) =>
            setFilters({ ...values, key: values.key.trim() }),
          )}
        >
          <div className="space-y-1.5">
            <Label htmlFor="attribution-key">Label key</Label>
            <Input
              id="attribution-key"
              placeholder="cost_center"
              required
              maxLength={256}
              {...form.register("key", {
                required: true,
                validate: (value) => value.trim().length > 0,
              })}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="attribution-value">Value (optional)</Label>
            <Input
              id="attribution-value"
              placeholder="All values"
              maxLength={1024}
              disabled={form.watch("unassigned")}
              {...form.register("value")}
            />
          </div>
          <Label
            className="flex h-9 items-center gap-2"
            htmlFor="attribution-unassigned"
          >
            <Checkbox
              id="attribution-unassigned"
              checked={form.watch("unassigned")}
              onCheckedChange={(checked) =>
                form.setValue("unassigned", checked === true)
              }
            />
            <span>Unassigned only</span>
          </Label>
          <Button type="submit">
            <span>Apply</span>
          </Button>
        </form>
        {query.isError ? (
          <QueryLoadError
            title="Could not load cost attribution"
            error={query.error}
            onRetry={() => query.refetch()}
          />
        ) : query.isPending ? (
          <Skeleton className="h-40 w-full" />
        ) : !query.data?.totals.requests ? (
          <p className="text-sm text-muted-foreground">
            No proxy requests for this timeframe and label filter.
          </p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-6">
              <div>
                <p className="text-xs text-muted-foreground">Billed spend</p>
                <p className="text-2xl tabular-nums">
                  {money(query.data.totals.billedCost)}
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Requests</p>
                <p className="text-2xl tabular-nums">
                  {query.data.totals.requests.toLocaleString()}
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">
                  Without this label
                </p>
                <p className="text-2xl tabular-nums">
                  {(unassigned?.requests ?? 0).toLocaleString()}
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="ml-auto"
                disabled={copy.isPending}
                onClick={() => copy.mutate({ key: filters.key, groups })}
              >
                <ClipboardCopy />
                <span>Copy all as CSV</span>
              </Button>
            </div>
            <div className="overflow-x-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{filters.key}</TableHead>
                    <TableHead className="text-right">Requests</TableHead>
                    <TableHead className="text-right">Input tokens</TableHead>
                    <TableHead className="text-right">Output tokens</TableHead>
                    <TableHead className="text-right">Billed spend</TableHead>
                    <TableHead className="text-right">
                      Subscription estimate
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {groups.map((row) => (
                    <TableRow
                      key={
                        row.value === null ? "missing" : `value:${row.value}`
                      }
                    >
                      <TableCell>
                        {row.value === null ? (
                          <span className="text-muted-foreground">
                            Unassigned (label missing)
                          </span>
                        ) : (
                          <span>{row.value}</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {row.requests.toLocaleString()}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {row.inputTokens.toLocaleString()}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {row.outputTokens.toLocaleString()}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {money(row.billedCost)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {money(row.subscriptionCost)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <p className="text-xs text-muted-foreground">
              Each request appears once. Requests recorded before label
              snapshots were available are unassigned.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function money(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  }).format(value);
}
