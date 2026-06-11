import { CheckCircleIcon, ClockIcon, PlusCircleIcon } from "lucide-react";
import { toast } from "sonner";
import { useAllProfileTools, useGrantTool } from "@/lib/agent-tools.query";
import { ToolStatusRow } from "./tool-status-row";

interface ToolGrantApprovalCardProps {
  /** The run_tool target the model wants to call (its tool name). */
  targetToolName: string;
  agentId: string;
  approvalId: string;
  onRespond: (params: {
    id: string;
    approved: boolean;
    reason?: string;
  }) => void;
}

/**
 * Approval card for a run_tool call whose target the user can access but the
 * agent does not yet have. Confirming grants the tool to the agent (the backend
 * resolves it by name and enforces authorization) and then approves, so the AI
 * SDK resumes the same call with the tool now assigned. If the target is in fact
 * already assigned (an ordinary policy approval routed through run_tool), it
 * falls back to plain approve/deny.
 */
export function ToolGrantApprovalCard({
  targetToolName,
  agentId,
  approvalId,
  onRespond,
}: ToolGrantApprovalCardProps) {
  const grantTool = useGrantTool();
  // Discriminate a grant from an ordinary policy approval routed through
  // run_tool: only an unassigned target needs granting. (Archestra built-ins are
  // omitted from this list, so they read as unassigned and take the grant path —
  // which is correct; the backend grant is idempotent if already assigned.)
  const { data: assignedMatches } = useAllProfileTools({
    filters: { search: targetToolName, agentId },
    skipPagination: true,
  });
  const isAssigned = Boolean(
    assignedMatches?.data.some((row) => row.tool.name === targetToolName),
  );

  const respond = (approved: boolean) =>
    onRespond({
      id: approvalId,
      approved,
      reason: approved ? undefined : "User declined",
    });

  if (isAssigned) {
    return (
      <ToolStatusRow
        icon={<ClockIcon className="mt-0.5 size-4 flex-none text-amber-600" />}
        title="Approval required"
        description="Review this tool call before it can continue."
        actions={[
          {
            label: "Approve",
            variant: "secondary",
            icon: <CheckCircleIcon className="size-4" />,
            onClick: () => respond(true),
          },
          {
            label: "Decline",
            variant: "outline",
            onClick: () => respond(false),
          },
        ]}
      />
    );
  }

  const grant = () => {
    if (grantTool.isPending) return;
    grantTool.mutate(
      { agentId, toolName: targetToolName },
      {
        onSuccess: () => respond(true),
        onError: () =>
          toast.error(`Could not add "${targetToolName}" to this agent`),
      },
    );
  };

  return (
    <ToolStatusRow
      icon={
        <PlusCircleIcon className="mt-0.5 size-4 flex-none text-amber-600" />
      }
      title="Add tool to agent"
      description={`"${targetToolName}" isn't on this agent yet. Add it and run this call?`}
      actions={[
        {
          label: grantTool.isPending ? "Adding…" : "Add to agent & run",
          variant: "secondary",
          icon: <PlusCircleIcon className="size-4" />,
          onClick: grant,
          disabled: grantTool.isPending,
        },
        { label: "Cancel", variant: "outline", onClick: () => respond(false) },
      ]}
    />
  );
}
