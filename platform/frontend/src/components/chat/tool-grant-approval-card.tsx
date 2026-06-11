import { CheckCircleIcon, ClockIcon, PlusCircleIcon } from "lucide-react";
import { toast } from "sonner";
import { useAllProfileTools, useAssignTool } from "@/lib/agent-tools.query";
import { ToolStatusRow } from "./tool-status-row";

interface ToolGrantApprovalCardProps {
  /** The run_tool target the model wants to call (its full tool name). */
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
 * agent does not yet have. Confirming adds the tool to the agent (the normal
 * assign endpoint) and then approves, so the AI SDK resumes the same call with
 * the tool now assigned. If the target is in fact already assigned (an ordinary
 * policy approval routed through run_tool), it falls back to plain approve/deny.
 */
export function ToolGrantApprovalCard({
  targetToolName,
  agentId,
  approvalId,
  onRespond,
}: ToolGrantApprovalCardProps) {
  const assignTool = useAssignTool();
  const { data: matches } = useAllProfileTools({
    filters: { search: targetToolName },
    skipPagination: true,
  });
  const { data: assignedMatches } = useAllProfileTools({
    filters: { search: targetToolName, agentId },
    skipPagination: true,
  });

  // The model may pass a short name (e.g. `run_command`) while the catalog row
  // is `archestra__run_command`; match exactly, else fall back to the sole
  // search hit so a short name still resolves.
  const resolveRow = (
    rows: { tool: { id: string; name: string } }[] | undefined,
  ) =>
    rows?.find((row) => row.tool.name === targetToolName) ??
    (rows?.length === 1 ? rows[0] : undefined);

  const toolId = resolveRow(matches?.data)?.tool.id;
  const isAssigned = Boolean(resolveRow(assignedMatches?.data));

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
    if (!toolId || assignTool.isPending) return;
    assignTool.mutate(
      { agentId, toolId, resolveAtCallTime: true },
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
          label: assignTool.isPending ? "Adding…" : "Add to agent & run",
          variant: "secondary",
          icon: <PlusCircleIcon className="size-4" />,
          onClick: grant,
        },
        { label: "Cancel", variant: "outline", onClick: () => respond(false) },
      ]}
    />
  );
}
