"use client";

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
  const { data: run } = useConnectorRun({ connectorId, runId });
  const formattedLogs = run?.logs ? formatConnectorRunLogs(run.logs) : null;

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
            Sync Run Details
            {run && <ConnectorStatusBadge status={run.status} />}
          </DialogTitle>
          <DialogDescription>
            Inspect the latest status, progress, and any connector errors for
            this sync run.
          </DialogDescription>
        </DialogHeader>

        <DialogBody>
          {run ? (
            <div className="flex flex-col gap-4">
              {/* Run metadata */}
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
                {(run.itemErrors ?? 0) > 0 && (
                  <div>
                    <span className="text-muted-foreground">Item errors:</span>{" "}
                    <span className="text-amber-600">{run.itemErrors}</span>
                  </div>
                )}
                {(run.itemsSkipped ?? 0) > 0 && (
                  <div>
                    <span className="text-muted-foreground">Skipped:</span>{" "}
                    <span className="text-muted-foreground">
                      {run.itemsSkipped}
                    </span>
                  </div>
                )}
              </div>

              {(run.itemsSkipped ?? 0) > 0 && (
                <p className="text-xs text-muted-foreground">
                  {run.itemsSkipped} file(s) were skipped: no extractable text
                  or media (e.g. empty documents, unsupported binary formats, or
                  password-protected files). These are not indexed.
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

              {/* Error section */}
              {run.error && (
                <div>
                  <h4 className="mb-1 text-sm font-medium text-destructive">
                    Error
                  </h4>
                  <pre className="max-h-48 overflow-auto rounded-md bg-destructive/10 p-3 text-xs text-destructive whitespace-pre-wrap break-words">
                    {run.error}
                  </pre>
                </div>
              )}

              {formattedLogs && (
                <div>
                  <h4 className="mb-1 text-sm font-medium">Logs</h4>
                  <pre className="max-h-80 overflow-auto rounded-md border bg-muted/30 p-3 text-xs whitespace-pre-wrap break-words">
                    <code>{formattedLogs}</code>
                  </pre>
                </div>
              )}
            </div>
          ) : (
            <div className="text-sm text-muted-foreground">
              Loading sync run details...
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
