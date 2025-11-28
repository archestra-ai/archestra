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
import { useAgents } from "@/lib/agent.query";
import { usePromptVersions, useRollbackPrompt } from "@/lib/prompts.query";
import { formatDate } from "@/lib/utils";
import { TruncatedText } from "../truncated-text";

type Prompt = archestraApiTypes.GetPromptsResponses["200"][number];

interface PromptVersionHistoryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  prompt: Prompt | null;
}

export function PromptVersionHistoryDialog({
  open,
  onOpenChange,
  prompt,
}: PromptVersionHistoryDialogProps) {
  const { data: versions = [], isLoading } = usePromptVersions(
    prompt?.id || "",
  );
  const { data: allAgents = [] } = useAgents();
  const rollbackMutation = useRollbackPrompt();

  const handleRollback = async (versionId: string) => {
    if (!prompt) return;

    try {
      await rollbackMutation.mutateAsync({
        id: prompt.id,
        versionId,
      });
      toast.success("Rolled back to selected version");
      onOpenChange(false);
    } catch (_error) {
      toast.error("Failed to rollback to version");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Version History: {prompt?.name}</DialogTitle>
          <DialogDescription>
            View and rollback to previous versions of this prompt
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin" />
          </div>
        ) : (
          <div className="space-y-3">
            {(versions as Prompt[]).map((version) => {
              return (
                <div
                  key={version.id}
                  className="border rounded-lg p-4 space-y-2"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">
                        Version {version.version}
                      </span>
                      {version.isActive && (
                        <Badge variant="default" className="text-xs">
                          <Check className="h-3 w-3 mr-1" />
                          Current
                        </Badge>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground">
                        {formatDate({ date: version.createdAt })}
                      </span>
                      {!version.isActive && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => handleRollback(version.id)}
                          disabled={rollbackMutation.isPending}
                        >
                          <RotateCcw className="h-3 w-3 mr-1" />
                          Rollback
                        </Button>
                      )}
                    </div>
                  </div>

                  {version.systemPrompt && (
                    <div className="text-xs">
                      <span className="font-medium text-muted-foreground">
                        System Prompt:
                      </span>
                      <div className="mt-1">
                        <TruncatedText
                          message={version.systemPrompt}
                          className="text-foreground"
                          maxLength={100}
                        />
                      </div>
                    </div>
                  )}

                  {version.userPrompt && (
                    <div className="text-xs">
                      <span className="font-medium text-muted-foreground">
                        User Prompt:
                      </span>
                      <div className="mt-1">
                        <TruncatedText
                          message={version.userPrompt}
                          className="text-foreground"
                          maxLength={100}
                        />
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
