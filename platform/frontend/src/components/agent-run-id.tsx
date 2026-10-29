"use client";

import { Copy } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { copyToClipboard } from "@/lib/clipboard";

export function AgentRunId({ taskId }: { taskId: string }) {
  return (
    <Button
      variant="ghost"
      size="xs"
      title={taskId}
      aria-label={`Copy run ID ${taskId}`}
      onClick={() => {
        void copyToClipboard(taskId).then(
          () => toast.success("Run ID copied"),
          () => toast.error("Could not copy run ID"),
        );
      }}
    >
      <span className="font-mono">Run {taskId.slice(0, 8)}</span>
      <Copy className="size-3" />
    </Button>
  );
}
