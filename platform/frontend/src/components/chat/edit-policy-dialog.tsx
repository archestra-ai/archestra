"use client";

import { ToolCallPolicies } from "@/app/mcp/tool-policies/_parts/tool-call-policies";
import { ToolResultPolicies } from "@/app/mcp/tool-policies/_parts/tool-result-policies";
import { FormDialog } from "@/components/form-dialog";
import { DialogBody } from "@/components/ui/dialog";
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
      limit: 50,
    },
  });

  const agentTool = data?.data?.find((t) => t.tool.name === toolName);

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Edit Policies"
      description={`Configure policies for ${toolName}`}
      size="medium"
    >
      <DialogBody className="space-y-4">
        {agentTool ? (
          <>
            <ToolCallPolicies tool={agentTool.tool} />
            <ToolResultPolicies tool={agentTool.tool} />
          </>
        ) : (
          <p className="text-muted-foreground text-sm">
            Tool not found or not assigned to this Agent.
          </p>
        )}
      </DialogBody>
    </FormDialog>
  );
}
