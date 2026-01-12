"use client";

import { ToolCallPolicies } from "@/app/tools/_parts/tool-call-policies";
import { ToolResultPolicies } from "@/app/tools/_parts/tool-result-policies";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useAllProfileTools } from "@/lib/agent-tools.query";

interface EditPolicyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  toolName: string;
  profileId: string;
}

export function EditPolicyDialog({
  open,
  onOpenChange,
  toolName,
  profileId,
}: EditPolicyDialogProps) {
  const { data } = useAllProfileTools({
    filters: {
      search: toolName,
      agentId: profileId,
    },
    pagination: {
      limit: 1,
    },
  });

  const agentTool = data?.data?.find((t) => t.tool.name === toolName);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit Policies</DialogTitle>
          <DialogDescription>
            Configure policies for {toolName}
          </DialogDescription>
        </DialogHeader>
        <div className="mt-2 space-y-4">
          {agentTool ? (
            <>
              <ToolCallPolicies tool={agentTool.tool} />
              <ToolResultPolicies tool={agentTool.tool} />
            </>
          ) : (
            <p className="text-muted-foreground text-sm">
              Tool not found or not assigned to this profile.
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
