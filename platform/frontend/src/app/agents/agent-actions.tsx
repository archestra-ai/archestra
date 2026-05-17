import { E2eTestId } from "@shared";
import {
  Clock,
  Copy,
  Download,
  Eye,
  MessageSquare,
  Pencil,
  Plug,
  Trash2,
} from "lucide-react";
import {
  type TableRowAction,
  TableRowActions,
} from "@/components/table-row-actions";
import type { useProfilesPaginated } from "@/lib/agent.query";

type Agent = NonNullable<
  ReturnType<typeof useProfilesPaginated>["data"]
>["data"][number];

type AgentActionsProps = {
  agent: Agent;
  canModify: boolean;
  onConnect: (agent: Pick<Agent, "id" | "name" | "agentType">) => void;
  onEdit: (agent: Agent) => void;
  onView: (agent: Agent) => void;
  onDelete: (agentId: string) => void;
  onClone: (agentId: string) => void;
  onExport: (agent: Agent) => void;
};

export function AgentActions({
  agent,
  canModify,
  onConnect,
  onEdit,
  onView,
  onDelete,
  onClone,
  onExport,
}: AgentActionsProps) {
  const isBuiltIn = Boolean(agent.builtIn);

  const editOrViewAction: TableRowAction =
    canModify || isBuiltIn
      ? {
          icon: <Pencil className="h-4 w-4" />,
          label: "Edit",
          permissions: { agent: ["update"] },
          disabled: !canModify && !isBuiltIn,
          onClick: () => onEdit(agent),
          testId: `${E2eTestId.EditAgentButton}-${agent.name}`,
        }
      : {
          icon: <Eye className="h-4 w-4" />,
          label: "View",
          onClick: () => onView(agent),
          testId: `${E2eTestId.EditAgentButton}-${agent.name}`,
        };

  const primaryActions: TableRowAction[] = [
    {
      icon: <Plug className="h-4 w-4" />,
      label: "Connect",
      disabled: isBuiltIn,
      disabledTooltip: "Built-in agents cannot be connected",
      onClick: () => onConnect(agent),
      testId: `${E2eTestId.ConnectAgentButton}-${agent.name}`,
    },
    {
      icon: <MessageSquare className="h-4 w-4" />,
      label: "Chat",
      disabled: isBuiltIn,
      disabledTooltip: "Built-in agents cannot be chatted with",
      href: `/chat/new?agent_id=${agent.id}`,
    },
    editOrViewAction,
  ];

  const dropdownActions: TableRowAction[] = [
    {
      icon: <Clock className="h-4 w-4" />,
      label: "Schedule",
      disabled: isBuiltIn,
      disabledTooltip: "Built-in agents cannot be scheduled",
      permissions: { scheduledTask: ["read"] },
      href: `/scheduled-tasks?agentId=${agent.id}`,
    },
    {
      icon: <Copy className="h-4 w-4" />,
      label: "Clone",
      disabled: isBuiltIn,
      disabledTooltip: isBuiltIn
        ? "Built-in agents cannot be cloned"
        : undefined,
      permissions: { agent: ["create"] },
      onClick: () => onClone(agent.id),
      testId: `${E2eTestId.CloneAgentButton}-${agent.name}`,
    },
    {
      icon: <Download className="h-4 w-4" />,
      label: "Export",
      permissions: { agent: ["read"] },
      disabled: isBuiltIn || agent.agentType !== "agent",
      disabledTooltip: isBuiltIn
        ? "Built-in agents cannot be exported"
        : agent.agentType !== "agent"
          ? "Only internal agents can be exported"
          : undefined,
      onClick: () => onExport(agent),
    },
    {
      icon: <Trash2 className="h-4 w-4" />,
      label: "Delete",
      permissions: { agent: ["delete"] },
      disabled: isBuiltIn || !canModify,
      disabledTooltip: isBuiltIn
        ? "Built-in agents cannot be deleted"
        : undefined,
      variant: "destructive",
      onClick: () => onDelete(agent.id),
      testId: `${E2eTestId.DeleteAgentButton}-${agent.name}`,
    },
  ];

  return (
    <TableRowActions
      actions={primaryActions}
      dropdownActions={dropdownActions}
    />
  );
}
