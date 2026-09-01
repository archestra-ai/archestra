"use client";

import type { ReactNode } from "react";
import { contentRunPhase } from "@/app/knowledge/connectors/_parts/content-run-phase";
import { formatRunDuration } from "@/app/knowledge/connectors/_parts/run-duration";
import { ConnectorStatusBadge } from "@/app/knowledge/knowledge-bases/_parts/connector-status-badge";
import { LogConsole } from "@/components/log-console";
import { RelativeTime } from "@/components/relative-time";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { useConnectorRun } from "@/lib/knowledge/connector.query";
import { cn } from "@/lib/utils";

interface ConnectorRunDetailsDialogProps {
  connectorId: string;
  runId: string | null;
  onClose: () => void;
}

export function ConnectorRunDetailsDialog({
  connectorId,
  runId,
  onClose,
}: ConnectorRunDetailsDialogProps) {
  const { data: run, isLoading } = useConnectorRun({ connectorId, runId });
  const formattedLogs = run?.logs ? formatConnectorRunLogs(run.logs) : null;
  const isPermissionRun = run?.runType === "permission";
  const phase = run ? contentRunPhase(run) : null;
  const isRunning = run?.status === "running";
  const progressPercent =
    run?.totalItems != null && run.totalItems > 0
      ? Math.min(
          100,
          Math.round(((run.documentsProcessed ?? 0) / run.totalItems) * 100),
        )
      : null;

  return (
    <Dialog
      open={runId !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-w-3xl">
        <DialogHeader className="flex-shrink-0">
          <DialogTitle className="flex items-center gap-2">
            {isPermissionRun
              ? "Permission Sync Run Details"
              : "Sync Run Details"}
            {run && <ConnectorStatusBadge status={run.status} />}
          </DialogTitle>
          <DialogDescription>
            {isPermissionRun
              ? "Inspect how this pass reconciled document access with the source system's permissions."
              : "Inspect the latest status, progress, and any connector errors for this sync run."}
          </DialogDescription>
        </DialogHeader>

        <DialogBody>
          {run ? (
            <div className="flex flex-col gap-5">
              {/* Run metadata as a stat grid — label above value, so ten
                  permission counters read as a block rather than ten
                  colon-separated sentences wrapping into each other. */}
              <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
                <RunStat label="Started">
                  <RelativeTime
                    date={run.startedAt}
                    className="text-sm text-foreground"
                  />
                </RunStat>
                <RunStat label={isRunning ? "Running for" : "Duration"}>
                  {formatRunDuration({
                    startedAt: run.startedAt,
                    completedAt: run.completedAt,
                  }) ?? "-"}
                </RunStat>
                {!isPermissionRun && (
                  <>
                    <RunStat label="Processed">
                      {(run.documentsProcessed ?? 0).toLocaleString()}
                      {run.totalItems != null &&
                        run.totalItems > 0 &&
                        ` / ${run.totalItems.toLocaleString()}`}
                    </RunStat>
                    <RunStat label="Ingested">
                      {(run.documentsIngested ?? 0).toLocaleString()}
                    </RunStat>
                    {phase && <RunStat label="Phase">{phase.label}</RunStat>}
                    {(run.itemErrors ?? 0) > 0 && (
                      <RunStat label="Item errors" tone="warn">
                        {run.itemErrors}
                      </RunStat>
                    )}
                    {(run.itemsSkipped ?? 0) > 0 && (
                      <RunStat label="Skipped">{run.itemsSkipped}</RunStat>
                    )}
                    {(run.documentsWithoutText ?? 0) > 0 && (
                      <RunStat label="No text extracted" tone="warn">
                        {run.documentsWithoutText}
                      </RunStat>
                    )}
                  </>
                )}
                {isPermissionRun && run.stats && (
                  <>
                    <RunStat label="Documents checked">
                      {run.stats.docsScanned.toLocaleString()}
                      {run.stats.totalDocs > 0 &&
                        ` / ${run.stats.totalDocs.toLocaleString()}`}
                    </RunStat>
                    <RunStat label="Access lists checked">
                      {(run.stats.containersSynced ?? 0).toLocaleString()}
                    </RunStat>
                    <RunStat label="Access lists updated">
                      {(run.stats.containersChanged ?? 0).toLocaleString()}
                    </RunStat>
                    {(run.stats.containerAudienceFailures ?? 0) > 0 && (
                      <RunStat label="Access lists unreadable" tone="error">
                        {(
                          run.stats.containerAudienceFailures ?? 0
                        ).toLocaleString()}
                      </RunStat>
                    )}
                    <RunStat label="Document permissions updated">
                      {run.stats.aclsChanged.toLocaleString()}
                    </RunStat>
                    <RunStat label="Search entries updated">
                      {run.stats.chunksRewritten.toLocaleString()}
                    </RunStat>
                    <RunStat
                      label="Documents locked"
                      tone={run.stats.failClosed > 0 ? "warn" : undefined}
                    >
                      {run.stats.failClosed.toLocaleString()}
                    </RunStat>
                    <RunStat
                      label="Groups checked"
                      tone={run.stats.groupSyncFailed ? "warn" : undefined}
                    >
                      {run.stats.groupsSynced.toLocaleString()}
                    </RunStat>
                    <RunStat
                      label="Group members updated"
                      tone={run.stats.groupSyncFailed ? "warn" : undefined}
                    >
                      {run.stats.membershipsUpserted.toLocaleString()}
                    </RunStat>
                    <RunStat label="Group members removed">
                      {(run.stats.membershipsRemoved ?? 0).toLocaleString()}
                    </RunStat>
                  </>
                )}
              </div>

              {/* Only while there is progress left to make: a full bar reading
                  100% under a settled run is decoration. */}
              {isRunning && progressPercent !== null && (
                <div className="space-y-1">
                  <Progress value={progressPercent} className="h-1.5" />
                  <div className="text-xs text-muted-foreground">
                    {progressPercent}%
                  </div>
                </div>
              )}

              {isPermissionRun &&
                (run.stats?.containerAudienceFailures ?? 0) > 0 && (
                  <p className="text-xs text-destructive">
                    This pass could not read the permissions of{" "}
                    {(
                      run.stats?.containerAudienceFailures ?? 0
                    ).toLocaleString()}{" "}
                    project, space, or repository. Everything in them is hidden
                    from everyone until a pass reads them successfully — this is
                    not the same as nobody being granted access. Check that the
                    connector credential can read permission settings, then run
                    a sync. The run log names them.
                  </p>
                )}

              {isPermissionRun && run.stats?.groupSyncFailed && (
                <p className="text-xs text-amber-600">
                  The group membership refresh failed mid-pass — the counts
                  above reflect only what actually persisted, and users keep
                  resolving against the previous group snapshot until a pass
                  completes cleanly.
                </p>
              )}

              {isPermissionRun && run.stats?.contentSyncActiveDuringRun && (
                <p className="text-xs text-muted-foreground">
                  A documents sync was still ingesting while this pass ran, so
                  it only covered documents ingested before it started — newer
                  documents stay access-restricted until the next pass.
                </p>
              )}

              {!isPermissionRun && (run.itemsSkipped ?? 0) > 0 && (
                <p className="text-xs text-muted-foreground">
                  {run.itemsSkipped} item(s) were skipped and not indexed —
                  their type isn&apos;t supported for the knowledge base (e.g.
                  videos, audio, archives, or other binary formats), or they had
                  no extractable text (empty or password-protected documents or
                  pages), or another item-specific reason applied. See the run
                  log for the exact reason.
                </p>
              )}

              {!isPermissionRun && (run.documentsWithoutText ?? 0) > 0 && (
                <p className="text-xs text-amber-600">
                  {run.documentsWithoutText} of the {run.itemsSkipped} skipped
                  items contained no extractable text — scanned or image-only
                  PDFs, files that could not be parsed, images too large to
                  embed, or empty pages — so they are not searchable and will
                  not appear in any knowledge base answer. The run log names
                  each one.
                </p>
              )}

              {/* Superseded/cancelled runs carry an explanatory note, not a
                  real error — render it neutrally so it doesn't read as a
                  failure. */}
              {run.error &&
                (run.status === "superseded" || run.status === "cancelled" ? (
                  <div>
                    <h4 className="mb-1 text-sm font-medium">Note</h4>
                    <pre className="max-h-48 overflow-auto rounded-md bg-muted/30 p-3 text-xs text-muted-foreground whitespace-pre-wrap break-words">
                      {run.error}
                    </pre>
                  </div>
                ) : (
                  <div>
                    <h4 className="mb-1 text-sm font-medium text-destructive">
                      Error
                    </h4>
                    <pre className="max-h-48 overflow-auto rounded-md bg-destructive/10 p-3 text-xs text-destructive whitespace-pre-wrap break-words">
                      {run.error}
                    </pre>
                  </div>
                ))}

              <div className="space-y-1.5">
                <h4 className="text-sm font-medium">Logs</h4>
                <LogConsole
                  content={formattedLogs}
                  emptyMessage="No logs recorded"
                  emptyHint="This sync run finished without writing any log output."
                  className="h-80"
                />
              </div>
            </div>
          ) : isLoading ? (
            <div className="text-sm text-muted-foreground">
              Loading sync run details...
            </div>
          ) : (
            // Resolved to nothing: a stale or invisible `?run=<id>` deep link.
            <div className="text-sm text-muted-foreground">
              This sync run no longer exists.
            </div>
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

// ===== Internal pieces =====

/** One label-above-value cell of the run's stat grid. */
function RunStat({
  label,
  tone,
  children,
}: {
  label: string;
  tone?: "warn" | "error";
  children: ReactNode;
}) {
  return (
    <div className="min-w-0">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div
        className={cn(
          "truncate text-sm tabular-nums",
          tone === "warn" && "text-amber-600",
          tone === "error" && "text-destructive",
        )}
      >
        {children}
      </div>
    </div>
  );
}

function formatConnectorRunLogs(logs: string): string {
  let formatted = "";
  let depth = 0;
  let inString = false;
  let isEscaped = false;

  for (let i = 0; i < logs.length; i++) {
    const char = logs[i];
    formatted += char;

    if (inString) {
      if (isEscaped) {
        isEscaped = false;
        continue;
      }

      if (char === "\\") {
        isEscaped = true;
        continue;
      }

      if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === "{" || char === "[") {
      depth++;
      continue;
    }

    if (char === "}" || char === "]") {
      depth = Math.max(0, depth - 1);

      const nextChar = logs[i + 1];
      const nextNonWhitespace = logs.slice(i + 1).match(/\S/)?.[0];
      if (
        depth === 0 &&
        nextChar !== "\n" &&
        (nextNonWhitespace === "{" || nextNonWhitespace === "[")
      ) {
        formatted += "\n";
      }
    }
  }

  return formatted;
}
