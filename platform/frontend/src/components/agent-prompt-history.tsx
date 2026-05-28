"use client";

import { E2eTestId } from "@shared";
import { ChevronDown, History, Loader2, RotateCcw } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { PermissionButton } from "@/components/ui/permission-button";
import {
  useAgentVersionDiff,
  useAgentVersions,
  useRestoreAgentVersion,
} from "@/lib/agent-versions.query";
import { cn } from "@/lib/utils";
import { formatDate, formatRelativeTimeFromNow } from "@/lib/utils/date-time";

type AgentVersionItem = {
  id: string;
  versionNumber: number;
  source: "create" | "update" | "restore";
  createdBy: string | null;
  createdByName: string | null;
  createdAt: string;
  promptPreview: string | null;
};

type AgentPromptHistoryProps = {
  agentId: string;
  currentPrompt: string | null;
};

export function AgentPromptHistory({
  agentId,
  currentPrompt,
}: AgentPromptHistoryProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [confirmingRestore, setConfirmingRestore] = useState(false);

  const { data: versionsData, isLoading } = useAgentVersions(agentId);
  const { data: diff, isLoading: isDiffLoading } = useAgentVersionDiff(
    agentId,
    expandedId,
    "current",
  );
  const restoreMutation = useRestoreAgentVersion();

  const versions = versionsData?.data ?? [];
  const isAlreadyCurrent = diff !== null && diff !== undefined && !diff.changed;

  function toggleExpand(id: string) {
    if (expandedId === id) {
      setExpandedId(null);
      setConfirmingRestore(false);
    } else {
      setExpandedId(id);
      setConfirmingRestore(false);
    }
  }

  function handleRestore(versionId: string) {
    restoreMutation.mutate(
      { agentId, versionId },
      {
        onSuccess: (data) => {
          if (!data) return;
          setConfirmingRestore(false);
          setExpandedId(null);
        },
      },
    );
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (versions.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center gap-3">
        <div className="h-10 w-10 rounded-full bg-muted flex items-center justify-center">
          <History className="h-5 w-5 text-muted-foreground" />
        </div>
        <div className="space-y-1">
          <p className="text-sm font-medium">No prompt history yet</p>
          <p className="text-xs text-muted-foreground max-w-xs">
            Every time the system prompt is saved a version is recorded here.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div data-testid={E2eTestId.PromptVersionList} className="divide-y">
      {versions.map((version, index) => {
        const isExpanded = expandedId === version.id;
        const isLatest = index === 0;

        return (
          <div key={version.id}>
            <button
              type="button"
              className="w-full text-left flex items-start gap-3 px-1 py-3 hover:bg-muted/50 transition-colors rounded-sm"
              onClick={() => toggleExpand(version.id)}
            >
              <div className="flex flex-col items-center gap-1 pt-0.5 shrink-0">
                <div
                  className={cn(
                    "h-6 w-6 rounded-full border-2 flex items-center justify-center text-[10px] font-bold",
                    isLatest
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border bg-background text-muted-foreground",
                  )}
                >
                  {version.versionNumber}
                </div>
              </div>

              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <SourceBadge source={version.source} />
                  {version.createdByName && (
                    <span className="text-xs text-muted-foreground">
                      {version.createdByName}
                    </span>
                  )}
                  <span className="text-xs text-muted-foreground">
                    {formatRelativeTimeFromNow(version.createdAt)}
                  </span>
                  {isLatest && (
                    <span className="text-[10px] font-medium text-primary bg-primary/10 px-1.5 py-0.5 rounded-full">
                      current
                    </span>
                  )}
                </div>
                {!isExpanded && version.promptPreview && (
                  <p className="text-xs text-muted-foreground truncate mt-0.5 font-mono">
                    {version.promptPreview}
                    {version.promptPreview.length >= 100 && "…"}
                  </p>
                )}
              </div>

              <ChevronDown
                className={cn(
                  "h-4 w-4 text-muted-foreground shrink-0 mt-1 transition-transform",
                  isExpanded && "rotate-180",
                )}
              />
            </button>

            {isExpanded && (
              <div className="px-4 pb-4 space-y-3">
                <div className="text-xs text-muted-foreground">
                  {formatDate({
                    date: version.createdAt,
                    dateFormat: "MMM d, yyyy 'at' h:mm a",
                  })}
                </div>

                {isDiffLoading ? (
                  <div className="flex items-center gap-2 py-4 text-xs text-muted-foreground">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Loading…
                  </div>
                ) : (
                  <pre className="whitespace-pre-wrap break-words rounded-md border bg-muted/50 p-3 text-xs font-mono leading-relaxed max-h-48 overflow-y-auto">
                    {diff?.base.systemPrompt ?? (
                      <span className="italic opacity-60">
                        No system prompt set
                      </span>
                    )}
                  </pre>
                )}

                {!isDiffLoading && (
                  <div className="flex items-center gap-2 pt-1">
                    {confirmingRestore ? (
                      <>
                        <Button
                          type="button"
                          size="sm"
                          disabled={restoreMutation.isPending}
                          onClick={() => handleRestore(version.id)}
                        >
                          {restoreMutation.isPending ? (
                            <>
                              <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                              Restoring…
                            </>
                          ) : (
                            "Confirm restore"
                          )}
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          disabled={restoreMutation.isPending}
                          onClick={() => setConfirmingRestore(false)}
                        >
                          Cancel
                        </Button>
                      </>
                    ) : (
                      <PermissionButton
                        data-testid={E2eTestId.RestorePromptButton}
                        type="button"
                        permissions={{ agent: ["update"] }}
                        variant="outline"
                        size="sm"
                        disabled={isAlreadyCurrent}
                        tooltip={
                          isAlreadyCurrent
                            ? "This is already the current prompt"
                            : undefined
                        }
                        onClick={() => setConfirmingRestore(true)}
                      >
                        <RotateCcw className="h-3.5 w-3.5 mr-1.5" />
                        {isAlreadyCurrent ? "Already current" : "Restore"}
                      </PermissionButton>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function SourceBadge({ source }: { source: "create" | "update" | "restore" }) {
  const config = {
    create: {
      label: "Created",
      className:
        "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950 dark:text-emerald-400 dark:border-emerald-800",
    },
    update: {
      label: "Updated",
      className:
        "bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950 dark:text-blue-400 dark:border-blue-800",
    },
    restore: {
      label: "Restored",
      className:
        "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950 dark:text-amber-400 dark:border-amber-800",
    },
  };

  const { label, className } = config[source];

  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium",
        className,
      )}
    >
      {label}
    </span>
  );
}
