"use client";

import { ToolCallPolicies } from "@/app/mcp/tool-guardrails/_parts/tool-call-policies";
import { ToolResultPolicies } from "@/app/mcp/tool-guardrails/_parts/tool-result-policies";
import { FormDialog } from "@/components/form-dialog";
import { LoadingSpinner } from "@/components/loading";
import { DialogBody } from "@/components/ui/dialog";
import { useAllProfileTools } from "@/lib/agent-tools.query";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useOrganization } from "@/lib/organization.query";
import { useTool } from "@/lib/tools/tool.query";

interface EditPolicyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  toolName: string;
  // The agent whose blocked call opened this dialog. Only used by the
  // name-based fallback lookup below, so it is optional: the tool-guardrails
  // deep link opens the dialog with a toolId and no agent context.
  profileId?: string;
  // The blocked tool's row id, when the backend supplied it. Resolves the tool
  // directly (works for All-mode tools with no agent_tools assignment); absent
  // for denials persisted before the id was carried, which fall back to the
  // name + agent lookup below.
  toolId?: string;
}

export function EditPolicyDialog({
  open,
  onOpenChange,
  toolName,
  profileId,
  toolId,
}: EditPolicyDialogProps) {
  const { data: canUpdateToolPolicy, isLoading: isLoadingPermissions } =
    useHasPermissions({
      toolPolicy: ["update"],
    });
  const { data: organization } = useOrganization();
  const { data: toolById, isLoading: isLoadingToolById } = useTool(
    toolId,
    canUpdateToolPolicy === true,
  );
  const { data } = useAllProfileTools({
    filters: {
      search: toolName,
      agentId: profileId,
    },
    pagination: {
      limit: 50,
    },
    enabled: canUpdateToolPolicy === true && !toolId && !!profileId,
  });

  const tool =
    toolById ?? data?.data?.find((t) => t.tool.name === toolName)?.tool;
  const isLoadingTool = isLoadingPermissions || (!!toolId && isLoadingToolById);
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
        {isLoadingTool ? (
          <div className="flex items-center justify-center py-6">
            <LoadingSpinner />
          </div>
        ) : canUpdateToolPolicy === false ? (
          <p className="text-muted-foreground text-sm">
            {supportMessage ||
              "You do not have permission to edit tool guardrails. Contact your administrator or support team for help."}
          </p>
        ) : tool ? (
          <>
            <ToolCallPolicies tool={tool} />
            <ToolResultPolicies tool={tool} />
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
