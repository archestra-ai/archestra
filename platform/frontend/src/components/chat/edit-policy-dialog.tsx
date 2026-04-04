"use client";

import { ToolCallPolicies } from "@/app/mcp/tool-guardrails/_parts/tool-call-policies";
import { ToolResultPolicies } from "@/app/mcp/tool-guardrails/_parts/tool-result-policies";
import { FormDialog } from "@/components/form-dialog";
import { LoadingSpinner } from "@/components/loading";
import { DialogBody } from "@/components/ui/dialog";
import { useAllProfileTools } from "@/lib/agent-tools.query";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useOrganization } from "@/lib/organization.query";

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
  const { data: canUpdateToolPolicy, isLoading: isLoadingPermissions } =
    useHasPermissions({
      toolPolicy: ["update"],
    });
  const { data: organization } = useOrganization();
  const { data } = useAllProfileTools({
    filters: {
      search: toolName,
      agentId: profileId,
    },
    pagination: {
      limit: 50,
    },
    enabled: canUpdateToolPolicy === true,
  });

  const agentTool = data?.data?.find((t) => t.tool.name === toolName);
  const supportMessage = organization?.chatErrorSupportMessage?.trim();

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Edit Policies"
      description={`Configure policies for ${toolName}`}
      size="medium"
    >
      <DialogBody className="space-y-4">
        {isLoadingPermissions ? (
          <div className="flex items-center justify-center py-6">
            <LoadingSpinner />
          </div>
        ) : canUpdateToolPolicy === false ? (
          <p className="text-muted-foreground text-sm">
            {supportMessage ||
              "You do not have permission to edit tool guardrails. Contact your administrator or support team for help."}
          </p>
        ) : agentTool ? (
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
