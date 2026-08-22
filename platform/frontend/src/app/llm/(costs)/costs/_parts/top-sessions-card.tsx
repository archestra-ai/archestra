"use client";

import type { archestraApiTypes } from "@archestra/shared";
import { format } from "date-fns";
import {
  formatDuration,
  formatTokens,
  percentOf,
} from "@/app/llm/(costs)/costs/_parts/usage-format";
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

type Breakdown = archestraApiTypes.GetMyUsageBreakdownResponses["200"];
type SessionCost = Breakdown["topSessions"][number];

/**
 * The caller's costliest sessions.
 *
 * The most directly actionable cut on the page: agentic spend concentrates
 * hard, so naming the handful of sessions that produced most of it turns "I
 * used a lot this week" into a specific piece of work the reader recognises and
 * can decide about.
 */
export function TopSessionsCard({
  sessions,
  totalCost,
  unsessionedRequests,
}: {
  sessions: SessionCost[];
  totalCost: Breakdown["totalCost"];
  unsessionedRequests: Breakdown["unsessionedRequests"];
}) {
  const listedCost = sessions.reduce((sum, { cost }) => sum + cost, 0);
  const listedShare = percentOf(listedCost, totalCost);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Costliest sessions</CardTitle>
        <CardDescription>
          {sessions.length > 0 ? (
            <span>
              These {sessions.length} sessions account for {listedShare}% of
              your list-price usage in this timeframe.
              {unsessionedRequests > 0 ? (
                <span>
                  {" "}
                  A further {unsessionedRequests.toLocaleString()} requests
                  arrived without a session id and belong to none of them.
                </span>
              ) : null}
            </span>
          ) : (
            <span>Your sessions, ranked by what they cost.</span>
          )}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {sessions.length === 0 ? (
          <p className="text-muted-foreground py-4 text-center">
            No sessions recorded for the selected timeframe.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Started</TableHead>
                  <TableHead>Client</TableHead>
                  <TableHead>Model</TableHead>
                  <TableHead className="text-right">Requests</TableHead>
                  <TableHead className="text-right">Duration</TableHead>
                  <TableHead className="text-right">Tokens</TableHead>
                  <TableHead className="text-right">Spend</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sessions.map((session) => (
                  <TableRow key={session.sessionId}>
                    <TableCell className="whitespace-nowrap">
                      <span className="block">
                        {format(new Date(session.startedAt), "MMM d, HH:mm")}
                      </span>
                      <span
                        className="text-muted-foreground block max-w-[16ch] truncate font-mono text-xs"
                        title={session.sessionId}
                      >
                        {session.sessionId}
                      </span>
                    </TableCell>
                    <TableCell className="max-w-[14ch] truncate">
                      <span title={session.client ?? undefined}>
                        {session.client ?? "Not reported"}
                      </span>
                    </TableCell>
                    <TableCell className="max-w-[18ch] truncate">
                      <span title={session.model ?? undefined}>
                        {session.model ?? "Not reported"}
                      </span>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {session.requests.toLocaleString()}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatDuration(session.durationMinutes)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatTokens(session.tokens)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      <BilledCost
                        cost={String(session.cost)}
                        billedCost={String(session.billedCost)}
                        subscriptionCost={String(
                          Math.max(0, session.cost - session.billedCost),
                        )}
                        baselineCost={String(session.billedCost)}
                        tooltip="hover"
                        format="number"
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
