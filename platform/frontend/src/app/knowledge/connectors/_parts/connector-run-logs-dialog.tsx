"use client";

import { ConnectorStatusBadge } from "@/app/knowledge/knowledge-bases/_parts/connector-status-badge";
import { LogViewer } from "@/components/log-viewer";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useConnectorRun } from "@/lib/connector.query";
import { formatDate } from "@/lib/utils";

interface ConnectorRunLogsDialogProps {
  connectorId: string;
  runId: string | null;
  onClose: () => void;
}

export function ConnectorRunLogsDialog({
  connectorId,
  runId,
  onClose,
}: ConnectorRunLogsDialogProps) {
  const { data: run } = useConnectorRun({ connectorId, runId });

  return (
    <Dialog
      open={runId !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-w-5xl h-[70vh] flex flex-col p-8">
        <DialogHeader className="flex-shrink-0">
          <DialogTitle className="flex items-center gap-2">
            Sync Run Logs
            {run && <ConnectorStatusBadge status={run.status} />}
          </DialogTitle>
        </DialogHeader>

        {run && (
          <div className="flex flex-col flex-1 min-h-0 gap-4">
            {/* Run metadata */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-sm flex-shrink-0">
              <div>
                <span className="text-muted-foreground">Started:</span>{" "}
                {formatDate({ date: run.startedAt })}
              </div>
              <div>
                <span className="text-muted-foreground">Completed:</span>{" "}
                {run.completedAt ? formatDate({ date: run.completedAt }) : "-"}
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
            </div>

            {/* Progress bar when totalItems is known */}
            {run.totalItems != null && run.totalItems > 0 && (
              <div className="flex-shrink-0">
                <div className="h-2 w-full bg-muted rounded-full overflow-hidden">
                  <div
                    className="h-full bg-primary transition-all duration-500 rounded-full"
                    style={{
                      width: `${Math.min(100, ((run.documentsProcessed ?? 0) / run.totalItems) * 100)}%`,
                    }}
                  />
                </div>
                <div className="text-xs text-muted-foreground mt-1">
                  {Math.round(
                    ((run.documentsProcessed ?? 0) / run.totalItems) * 100,
                  )}
                  %
                </div>
              </div>
            )}

            {/* Error section */}
            {run.error && (
              <div className="flex-shrink-0">
                <h4 className="text-sm font-medium text-destructive mb-1">
                  Error
                </h4>
                <pre className="text-xs bg-destructive/10 text-destructive p-3 rounded-md whitespace-pre-wrap break-words max-h-32 overflow-auto">
                  {run.error}
                </pre>
              </div>
            )}

            {/* Log viewer */}
            <LogViewer
              logs={run.logs ?? ""}
              isStreaming={run.status === "running"}
              label="Output"
            />
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
