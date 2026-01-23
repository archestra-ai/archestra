"use client";

import type { archestraApiTypes } from "@shared";
import { Check, Loader2, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useAgentVersions, useRollbackAgent } from "@/lib/agent.query";
import { formatDate } from "@/lib/utils";
import { TruncatedText } from "../truncated-text";

type InternalAgent = archestraApiTypes.GetAllAgentsResponses["200"][number];
type HistoryEntry = NonNullable<
  archestraApiTypes.GetAgentVersionsResponses["200"]
>["history"][number];

interface PromptVersionHistoryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agent: InternalAgent | null;
}

export function PromptVersionHistoryDialog({
  open,
  onOpenChange,
  agent,
}: PromptVersionHistoryDialogProps) {
  const { data: versions, isLoading } = useAgentVersions(agent?.id);
  const rollbackMutation = useRollbackAgent();

  const handleRollback = async (version: number) => {
    if (!agent) return;

    try {
      await rollbackMutation.mutateAsync({
        id: agent.id,
        version,
      });
      toast.success("Rolled back to selected version");
      onOpenChange(false);
    } catch (_error) {
      toast.error("Failed to rollback to version");
    }
  };

  const current = versions?.current;
  const history = [...(versions?.history ?? [])].sort(
    (a, b) => b.version - a.version,
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Version History: {agent?.name}</DialogTitle>
          <DialogDescription>
            View and rollback to previous versions of this agent
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin" />
          </div>
        ) : (
          <div className="space-y-3">
            {/* Current version */}
            {current && (
              <div className="border rounded-lg p-4 space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">
                      Version {current.promptVersion}
                    </span>
                    <Badge variant="default" className="text-xs">
                      <Check className="h-3 w-3 mr-1" />
                      Current
                    </Badge>
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {formatDate({ date: current.updatedAt })}
                  </span>
                </div>

                {current.systemPrompt && (
                  <div className="text-xs">
                    <span className="font-medium text-muted-foreground">
                      System Prompt:
                    </span>
                    <div className="mt-1">
                      <TruncatedText
                        message={current.systemPrompt}
                        className="text-foreground"
                        maxLength={100}
                      />
                    </div>
                  </div>
                )}

                {current.userPrompt && (
                  <div className="text-xs">
                    <span className="font-medium text-muted-foreground">
                      User Prompt:
                    </span>
                    <div className="mt-1">
                      <TruncatedText
                        message={current.userPrompt}
                        className="text-foreground"
                        maxLength={100}
                      />
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* History versions */}
            {history.map((entry: HistoryEntry) => (
              <div
                key={entry.version}
                className="border rounded-lg p-4 space-y-2"
              >
                <div className="flex items-center justify-between">
                  <span className="font-medium">Version {entry.version}</span>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground">
                      {formatDate({ date: entry.createdAt })}
                    </span>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => handleRollback(entry.version)}
                      disabled={rollbackMutation.isPending}
                    >
                      <RotateCcw className="h-3 w-3 mr-1" />
                      Rollback
                    </Button>
                  </div>
                </div>

                {entry.systemPrompt && (
                  <div className="text-xs">
                    <span className="font-medium text-muted-foreground">
                      System Prompt:
                    </span>
                    <div className="mt-1">
                      <TruncatedText
                        message={entry.systemPrompt}
                        className="text-foreground"
                        maxLength={100}
                      />
                    </div>
                  </div>
                )}

                {entry.userPrompt && (
                  <div className="text-xs">
                    <span className="font-medium text-muted-foreground">
                      User Prompt:
                    </span>
                    <div className="mt-1">
                      <TruncatedText
                        message={entry.userPrompt}
                        className="text-foreground"
                        maxLength={100}
                      />
                    </div>
                  </div>
                )}
              </div>
            ))}

            {history.length === 0 && (
              <p className="text-sm text-muted-foreground text-center py-4">
                No previous versions
              </p>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
