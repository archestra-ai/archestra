"use client";

import { AlertTriangle, ChevronDown } from "lucide-react";
import { useSyncExternalStore } from "react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  getAppDiagnosticCounts,
  getAppDiagnostics,
  isErrorDiagnostic,
  subscribeAppDiagnostics,
} from "@/lib/chat/app-diagnostics-store";
import { cn } from "@/lib/utils";

/**
 * Collapsible summary of an owned app's latest-render runtime errors / logs,
 * shown below the app in the chat stream. Collapsed it's a one-line count;
 * expanded it lists the actual (untrusted, plain-text) entries plus a note that
 * they're handed to the model on the next message so it can fix them.
 */
export function AppDiagnosticsPanel({ appId }: { appId: string }) {
  const counts = useSyncExternalStore(
    subscribeAppDiagnostics,
    getAppDiagnosticCounts,
    getAppDiagnosticCounts,
  );
  const appCounts = counts.get(appId);
  const errorCount = appCounts?.errors ?? 0;
  const logCount = appCounts?.logs ?? 0;
  if (errorCount === 0 && logCount === 0) return null;

  const entries = getAppDiagnostics(appId)?.entries ?? [];
  const hasErrors = errorCount > 0;
  const summary = hasErrors
    ? `${errorCount} runtime ${errorCount === 1 ? "error" : "errors"} in this app`
    : `${logCount} ${logCount === 1 ? "log" : "logs"} from this app`;

  return (
    <Collapsible
      className={cn(
        "w-fit max-w-full overflow-hidden rounded-md border text-xs",
        hasErrors
          ? "border-destructive/50 bg-destructive/10"
          : "border-border bg-muted/50",
      )}
    >
      <CollapsibleTrigger
        className={cn(
          "group/diag flex w-full items-center gap-1.5 px-2 py-1 text-left",
          hasErrors ? "text-destructive" : "text-muted-foreground",
        )}
      >
        {hasErrors ? <AlertTriangle className="h-3.5 w-3.5 shrink-0" /> : null}
        <span className="min-w-0 flex-1 truncate">{summary}</span>
        {hasErrors && logCount > 0 ? (
          <span className="shrink-0 text-muted-foreground">
            · {logCount} {logCount === 1 ? "log" : "logs"}
          </span>
        ) : null}
        <ChevronDown className="h-3.5 w-3.5 shrink-0 transition-transform group-data-[state=open]/diag:rotate-180" />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="flex flex-col gap-2 border-t border-inherit px-2 py-2">
          <ul className="flex flex-col gap-1">
            {entries.map((entry) => (
              <li
                key={`${entry.type}:${entry.message}`}
                className={cn(
                  "break-words font-mono text-[11px] leading-snug",
                  isErrorDiagnostic(entry.type)
                    ? "text-destructive"
                    : "text-muted-foreground",
                )}
              >
                {entry.message}
              </li>
            ))}
          </ul>
          <p className="text-muted-foreground">
            Sent to the assistant with your next message so it can fix them.
          </p>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
