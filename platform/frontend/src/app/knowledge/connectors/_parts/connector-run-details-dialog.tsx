"use client";

import { contentRunPhase } from "@/app/knowledge/connectors/_parts/content-run-phase";
import { ConnectorStatusBadge } from "@/app/knowledge/knowledge-bases/_parts/connector-status-badge";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useConnectorRun } from "@/lib/knowledge/connector.query";
import { formatDate } from "@/lib/utils";

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
            <div className="flex flex-col gap-4">
              {/* Run metadata — content runs show document/ingest progress;
                  permission runs show ACL reconcile stats instead (their
                  document counters are always 0). */}
              <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
                <div>
                  <span className="text-muted-foreground">Started:</span>{" "}
                  {formatDate({ date: run.startedAt })}
                </div>
                <div>
                  <span className="text-muted-foreground">Completed:</span>{" "}
                  {run.completedAt
                    ? formatDate({ date: run.completedAt })
                    : "-"}
                </div>
                {!isPermissionRun && (
                  <>
                    <div>
                      <span className="text-muted-foreground">Progress:</span>{" "}
                      {run.documentsProcessed ?? 0}
                      {run.totalItems != null &&
                        run.totalItems > 0 &&
                        ` / ${run.totalItems}`}{" "}
                      processed
                    </div>
                    <div>
                      <span className="text-muted-foreground">Ingested:</span>{" "}
                      {run.documentsIngested ?? 0}
                    </div>
                    {phase && (
                      <div className="col-span-2">
                        <span className="text-muted-foreground">Phase:</span>{" "}
                        {phase.label}
                      </div>
                    )}
                  </>
                )}
                {isPermissionRun && run.stats && (
                  <>
                    <div>
                      <span className="text-muted-foreground">
                        Documents checked:
                      </span>{" "}
                      {run.stats.docsScanned.toLocaleString()}
                      {run.stats.totalDocs > 0 &&
                        ` / ${run.stats.totalDocs.toLocaleString()}`}
                    </div>
                    <div>
                      <span className="text-muted-foreground">
                        Access lists checked:
                      </span>{" "}
                      {(run.stats.containersSynced ?? 0).toLocaleString()}
                    </div>
                    <div>
                      <span className="text-muted-foreground">
                        Access lists updated:
                      </span>{" "}
                      {(run.stats.containersChanged ?? 0).toLocaleString()}
                    </div>
                    {(run.stats.containerAudienceFailures ?? 0) > 0 && (
                      <div>
                        <span className="text-muted-foreground">
                          Access lists unreadable:
                        </span>{" "}
                        <span className="text-destructive">
                          {(
                            run.stats.containerAudienceFailures ?? 0
                          ).toLocaleString()}
                        </span>
                      </div>
                    )}
                    <div>
                      <span className="text-muted-foreground">
                        Document permissions updated:
                      </span>{" "}
                      {run.stats.aclsChanged.toLocaleString()}
                    </div>
                    <div>
                      <span className="text-muted-foreground">
                        Search entries updated:
                      </span>{" "}
                      {run.stats.chunksRewritten.toLocaleString()}
                    </div>
                    <div>
                      <span className="text-muted-foreground">
                        Documents locked:
                      </span>{" "}
                      <span
                        className={
                          run.stats.failClosed > 0
                            ? "text-amber-600"
                            : undefined
                        }
                      >
                        {run.stats.failClosed.toLocaleString()}
                      </span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">
                        Groups checked:
                      </span>{" "}
                      <span
                        className={
                          run.stats.groupSyncFailed
                            ? "text-amber-600"
                            : undefined
                        }
                      >
                        {run.stats.groupsSynced.toLocaleString()}
                      </span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">
                        Group members updated:
                      </span>{" "}
                      <span
                        className={
                          run.stats.groupSyncFailed
                            ? "text-amber-600"
                            : undefined
                        }
                      >
                        {run.stats.membershipsUpserted.toLocaleString()}
                      </span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">
                        Group members removed:
                      </span>{" "}
                      {(run.stats.membershipsRemoved ?? 0).toLocaleString()}
                    </div>
                  </>
                )}
                {!isPermissionRun && (run.itemErrors ?? 0) > 0 && (
                  <div>
                    <span className="text-muted-foreground">Item errors:</span>{" "}
                    <span className="text-amber-600">{run.itemErrors}</span>
                  </div>
                )}
                {!isPermissionRun && (run.itemsSkipped ?? 0) > 0 && (
                  <div>
                    <span className="text-muted-foreground">Skipped:</span>{" "}
                    <span className="text-muted-foreground">
                      {run.itemsSkipped}
                    </span>
                  </div>
                )}
              </div>

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
                  {run.itemsSkipped} file(s) were skipped and not indexed —
                  their file type isn&apos;t supported for the knowledge base
                  (e.g. videos, audio, archives, or other binary formats), or
                  they had no extractable text (empty or password-protected
                  documents).
                </p>
              )}

              {/* Progress bar when totalItems is known */}
              {run.totalItems != null && run.totalItems > 0 && (
                <div>
                  <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-primary transition-all duration-500"
                      style={{
                        width: `${Math.min(100, ((run.documentsProcessed ?? 0) / run.totalItems) * 100)}%`,
                      }}
                    />
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {Math.round(
                      ((run.documentsProcessed ?? 0) / run.totalItems) * 100,
                    )}
                    %
                  </div>
                </div>
              )}

              {/* Superseded runs carry an explanatory note, not a real error —
                  render it neutrally so it doesn't read as a failure. */}
              {run.error &&
                (run.status === "superseded" ? (
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

              {formattedLogs && (
                <div>
                  <h4 className="mb-1 text-sm font-medium">Logs</h4>
                  <pre className="max-h-80 overflow-auto rounded-md border bg-muted/30 p-3 text-xs whitespace-pre-wrap break-words">
                    <code>{formattedLogs}</code>
                  </pre>
                </div>
              )}
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
