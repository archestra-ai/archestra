"use client";

import { ArrowLeft, Ban, Check, ExternalLink, X } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { EmptyState } from "@/components/empty-state";
import { PageLayout } from "@/components/page-layout";
import { QueryLoadError } from "@/components/query-load-error";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useHasPermissions } from "@/lib/auth/auth.query";
import {
  type EvalRunResult,
  useCancelEvalRun,
  useEvalRun,
  useEvalRunResults,
} from "@/lib/evals/eval.query";
import { formatDate } from "@/lib/utils";
import { EvalRunStatusBadge } from "../../_parts/eval-run-status-badge";

const POLL_INTERVAL_MS = 3000;
const RESULTS_PAGE_SIZE = 100;

export default function EvalRunPage() {
  return (
    <ErrorBoundary>
      <EvalRunDetail />
    </ErrorBoundary>
  );
}

function EvalRunDetail() {
  const params = useParams<{ id: string }>();
  const runId = params.id;

  const runQuery = useEvalRun(runId, { refetchInterval: POLL_INTERVAL_MS });
  const run = runQuery.data;
  const isActive = run?.status === "pending" || run?.status === "running";

  const resultsQuery = useEvalRunResults({
    runId,
    limit: RESULTS_PAGE_SIZE,
    offset: 0,
    refetchInterval: isActive ? POLL_INTERVAL_MS : false,
  });
  const results = resultsQuery.data?.data ?? [];

  const cancelRun = useCancelEvalRun();
  const { data: canExecute } = useHasPermissions({ eval: ["execute"] });

  if (runQuery.isLoadingError) {
    return (
      <QueryLoadError
        title="Couldn't load this eval run"
        onRetry={() => runQuery.refetch()}
      />
    );
  }
  if (!runQuery.isLoading && !run) {
    return (
      <EmptyState
        title="Eval run not found"
        description="It may belong to a different organization."
        action={
          <Button asChild variant="outline">
            <Link href="/evals">
              <ArrowLeft className="mr-2 h-4 w-4" />
              <span>Back to Evals</span>
            </Link>
          </Button>
        }
      />
    );
  }
  if (!run) return null;

  const finishedCases =
    run.passedCases + run.failedCases + run.erroredCases + run.canceledCases;
  const gradedCases = run.passedCases + run.failedCases;
  const passRate =
    gradedCases > 0 ? Math.round((run.passedCases / gradedCases) * 100) : null;

  return (
    <PageLayout
      title={run.name ? `Run: ${run.name}` : "Eval run"}
      documentTitle="Eval run"
      status={<EvalRunStatusBadge status={run.status} />}
      description={
        <span>
          Against <strong>{run.agentNameSnapshot}</strong>
          {run.modelSnapshot ? ` (${run.modelSnapshot})` : ""} ·{" "}
          {formatDate({ date: run.createdAt })}
        </span>
      }
      backLink={
        <Link
          href={`/evals/${run.suiteId}`}
          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          <span>Back to suite</span>
        </Link>
      }
      actionButton={
        canExecute && isActive ? (
          <Button
            variant="outline"
            onClick={() => cancelRun.mutate(run.id)}
            disabled={cancelRun.isPending}
          >
            <Ban className="mr-2 h-4 w-4" />
            <span>Cancel run</span>
          </Button>
        ) : undefined
      }
    >
      <div className="space-y-6">
        {run.status === "failed" && run.error && (
          <Card className="border-destructive/50">
            <CardContent className="text-destructive pt-6 text-sm">
              {run.error}
            </CardContent>
          </Card>
        )}

        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <StatCard
            label="Pass rate"
            value={passRate === null ? "—" : `${passRate}%`}
            hint={`${run.passedCases} passed / ${run.failedCases} failed${run.erroredCases > 0 ? ` / ${run.erroredCases} errored` : ""}`}
          />
          <StatCard
            label="Progress"
            value={`${finishedCases}/${run.totalCases}`}
            hint="cases finished"
          />
          <StatCard
            label="Tokens"
            value={run.totalTokens.toLocaleString()}
            hint={`${run.inputTokens.toLocaleString()} in / ${run.outputTokens.toLocaleString()} out`}
          />
          <StatCard
            label="Billed cost"
            value={`$${run.billedCost.toFixed(4)}`}
            hint={
              run.subscriptionCost > 0
                ? `+ $${run.subscriptionCost.toFixed(4)} subscription`
                : "may settle shortly after completion"
            }
          />
        </div>

        <section className="space-y-3">
          <h2 className="text-lg font-semibold">Results</h2>
          {resultsQuery.isLoadingError ? (
            <QueryLoadError
              title="Couldn't load results"
              onRetry={() => resultsQuery.refetch()}
            />
          ) : (
            <div className="space-y-2">
              {results.map((result) => (
                <ResultCard key={result.id} result={result} />
              ))}
            </div>
          )}
        </section>
      </div>
    </PageLayout>
  );
}

function StatCard({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-muted-foreground text-sm font-medium">
          {label}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-semibold tabular-nums">{value}</div>
        {hint && <p className="text-muted-foreground mt-1 text-xs">{hint}</p>}
      </CardContent>
    </Card>
  );
}

const RESULT_STATUS_STYLES: Record<EvalRunResult["status"], string> = {
  pending: "bg-muted text-muted-foreground",
  running: "bg-blue-500/15 text-blue-700 dark:text-blue-300",
  passed: "bg-green-500/15 text-green-700 dark:text-green-300",
  failed: "bg-red-500/15 text-red-700 dark:text-red-300",
  error: "bg-orange-500/15 text-orange-700 dark:text-orange-300",
  canceled: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
};

function ResultCard({ result }: { result: EvalRunResult }) {
  const [expanded, setExpanded] = useState(false);
  const { data: canReadAllLogs } = useHasPermissions({ log: ["admin"] });
  const { data: canReadOwnLogs } = useHasPermissions({ log: ["read"] });
  // log:read only surfaces the viewer's own interactions; eval sessions run
  // under the run creator, so only they (or a log admin) get a working link.
  const canOpenSession = canReadAllLogs || canReadOwnLogs;

  return (
    <Card>
      <button
        type="button"
        className="w-full text-left"
        onClick={() => setExpanded((current) => !current)}
      >
        <CardHeader className="flex flex-row items-center gap-3 space-y-0 py-3">
          <span className="text-muted-foreground w-6 shrink-0 text-sm tabular-nums">
            {result.position}
          </span>
          <span className="flex-1 truncate font-medium">{result.caseName}</span>
          {result.durationMs !== null && (
            <span className="text-muted-foreground text-xs tabular-nums">
              {(result.durationMs / 1000).toFixed(1)}s
            </span>
          )}
          <Badge
            variant="outline"
            className={RESULT_STATUS_STYLES[result.status]}
          >
            {result.status}
          </Badge>
        </CardHeader>
      </button>
      {expanded && (
        <CardContent className="space-y-4 border-t pt-4">
          <div>
            <h4 className="text-muted-foreground mb-1 text-xs font-medium uppercase">
              Input
            </h4>
            <p className="whitespace-pre-wrap text-sm">{result.input}</p>
          </div>
          {result.outputText !== null && (
            <div>
              <h4 className="text-muted-foreground mb-1 text-xs font-medium uppercase">
                Output
              </h4>
              <p className="whitespace-pre-wrap text-sm">{result.outputText}</p>
            </div>
          )}
          {result.error && (
            <div>
              <h4 className="text-muted-foreground mb-1 text-xs font-medium uppercase">
                Error
              </h4>
              <p className="text-destructive text-sm">{result.error}</p>
            </div>
          )}
          {result.toolCalls && result.toolCalls.length > 0 && (
            <div>
              <h4 className="text-muted-foreground mb-1 text-xs font-medium uppercase">
                Tools called
              </h4>
              <div className="flex flex-wrap gap-1">
                {result.toolCalls.map((toolName, index) => (
                  <Badge
                    // biome-ignore lint/suspicious/noArrayIndexKey: ordered call list
                    key={index}
                    variant="outline"
                    className="text-xs"
                  >
                    {toolName}
                  </Badge>
                ))}
              </div>
            </div>
          )}
          {result.assertionResults && result.assertionResults.length > 0 && (
            <div>
              <h4 className="text-muted-foreground mb-1 text-xs font-medium uppercase">
                Assertions
              </h4>
              <ul className="space-y-1">
                {result.assertionResults.map((assertion, index) => (
                  <li
                    // biome-ignore lint/suspicious/noArrayIndexKey: assertion order is stable
                    key={index}
                    className="flex items-start gap-2 text-sm"
                  >
                    {assertion.passed ? (
                      <Check className="mt-0.5 h-4 w-4 shrink-0 text-green-600" />
                    ) : (
                      <X className="text-destructive mt-0.5 h-4 w-4 shrink-0" />
                    )}
                    <span>
                      <Badge variant="outline" className="mr-2 text-xs">
                        {assertion.type}
                      </Badge>
                      <span className="text-muted-foreground">
                        {assertion.reason}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {canOpenSession && result.sessionId && (
            <div className="flex gap-3">
              <Link
                href={`/llm/logs?sessionId=${encodeURIComponent(result.sessionId)}`}
                className="text-primary inline-flex items-center gap-1 text-sm hover:underline"
              >
                <ExternalLink className="h-3.5 w-3.5" />
                <span>Agent session</span>
              </Link>
              {result.judgeSessionId && (
                <Link
                  href={`/llm/logs?sessionId=${encodeURIComponent(result.judgeSessionId)}`}
                  className="text-primary inline-flex items-center gap-1 text-sm hover:underline"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  <span>Judge session</span>
                </Link>
              )}
            </div>
          )}
        </CardContent>
      )}
    </Card>
  );
}
