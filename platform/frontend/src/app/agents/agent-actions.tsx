import { E2eTestId } from "@archestra/shared";
import {
  Copy,
  Download,
  Eye,
  History,
  MessageSquare,
  Pencil,
  Pin,
  PinOff,
  Plug,
  RotateCcw,
  Sparkles,
  Trash2,
} from "lucide-react";
import { permanentDeleteRowAction } from "@/components/permanent-delete";
import {
  type TableRowAction,
  TableRowActions,
} from "@/components/table-row-actions";
import type { useProfilesPaginated } from "@/lib/agent.query";
import { ACTION_LABEL, notYoursToChange } from "@/lib/design/resource-lexicon";
import { useIsGlobalAdmin } from "@/lib/organization.query";

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
  onRestore: (agentId: string) => void;
  onPermanentlyDelete: (agent: Agent) => void;
  onClone: (agent: Agent) => void;
  onExport: (agent: Agent) => void;
  onConvertToSkill: (agent: Agent) => void;
  /**
   * The caller's personal default agent, when this row is one of the caller's
   * own personal chat agents. `null` = none set; `undefined` = not applicable
   * to this row (someone else's, org/team scope, or not a chat agent), so no
   * toggle is offered.
   */
  personalDefault?: {
    isDefault: boolean;
    onToggle: (agent: Agent, makeDefault: boolean) => void;
  };
  /**
   * Carries `canModify` with the id: the history dialog offers a restore,
   * which is an update, so it needs the same scope check the row's own
   * mutating buttons apply rather than RBAC alone.
   */
  onHistory: (agentId: string, canModify: boolean) => void;
};

export function AgentActions({
  agent,
  canModify,
  onConnect,
  onEdit,
  onView,
  onDelete,
  onRestore,
  onPermanentlyDelete,
  onClone,
  onExport,
  onConvertToSkill,
  personalDefault,
  onHistory,
}: AgentActionsProps) {
  const admin = useIsGlobalAdmin();
  const isBuiltIn = Boolean(agent.builtIn);
  const isDeleted = Boolean(agent.deletedAt);

  if (isDeleted) {
    return (
      <TableRowActions
        itemName={agent.name}
        actions={[
          {
            icon: <RotateCcw className="h-4 w-4" />,
            label: ACTION_LABEL.restore,
            permissions: { agent: ["delete"] },
            disabled: !canModify,
            disabledTooltip: notYoursToChange({
              resource: "agent",
              scope: agent.scope,
            }),
            onClick: () => onRestore(agent.id),
          },
        ]}
        // Destructive and irreversible, so it sits in the row menu rather than
        // one pixel from Restore — the same place Delete sits on a live row.
        dropdownActions={[
          permanentDeleteRowAction({
            admin,
            onClick: () => onPermanentlyDelete(agent),
          }),
        ]}
      />
    );
  }

  const editOrViewAction: TableRowAction =
    canModify || isBuiltIn
      ? {
          icon: <Pencil className="h-4 w-4" />,
          label: ACTION_LABEL.edit,
          // A built-in agent is an org-wide record that only a resource admin
          // may change (`requireAgentModifyPermission`), so the row asks for
          // the permission the destination will actually check. Asking for
          // `agent:update` let any holder of it through to an edit page that
          // renders every field disabled.
          permissions: isBuiltIn ? { agent: ["admin"] } : { agent: ["update"] },
          disabled: !canModify && !isBuiltIn,
          disabledTooltip: notYoursToChange({
            resource: "agent",
            scope: agent.scope,
          }),
          onClick: () => onEdit(agent),
          testId: `${E2eTestId.EditAgentButton}-${agent.name}`,
        }
      : {
          icon: <Eye className="h-4 w-4" />,
          label: ACTION_LABEL.view,
          onClick: () => onView(agent),
          testId: `${E2eTestId.EditAgentButton}-${agent.name}`,
        };

  const primaryActions: TableRowAction[] = [
    {
      icon: <Plug className="h-4 w-4" />,
      label: ACTION_LABEL.connect,
      disabled: isBuiltIn,
      disabledTooltip: "Built-in agents cannot be connected",
      onClick: () => onConnect(agent),
      testId: `${E2eTestId.ConnectAgentButton}-${agent.name}`,
    },
    {
      icon: <MessageSquare className="h-4 w-4" />,
      label: ACTION_LABEL.chat,
      disabled: isBuiltIn,
      disabledTooltip: "Built-in agents cannot be chatted with",
      href: `/chat/new?agent_id=${agent.id}`,
    },
    editOrViewAction,
  ];

  const dropdownActions: TableRowAction[] = [
    ...(personalDefault
      ? [
          personalDefault.isDefault
            ? {
                icon: <PinOff className="h-4 w-4" />,
                label: "Unpin default",
                tooltip: "New chats go back to the organization default.",
                onClick: () => personalDefault.onToggle(agent, false),
                testId: `${E2eTestId.ToggleDefaultAgentButton}-${agent.name}`,
              }
            : {
                icon: <Pin className="h-4 w-4" />,
                label: "Pin default",
                tooltip: "Your new chats will start on this agent.",
                onClick: () => personalDefault.onToggle(agent, true),
                testId: `${E2eTestId.ToggleDefaultAgentButton}-${agent.name}`,
              },
        ]
      : []),
    {
      icon: <Copy className="h-4 w-4" />,
      label: ACTION_LABEL.clone,
      disabled: isBuiltIn,
      disabledTooltip: isBuiltIn
        ? "Built-in agents cannot be cloned"
        : undefined,
      permissions: { agent: ["create"] },
      onClick: () => onClone(agent),
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
      icon: <History className="h-4 w-4" />,
      label: ACTION_LABEL.versionHistory,
      permissions: { agent: ["read"] },
      testId: `${E2eTestId.AgentVersionHistoryButton}-${agent.name}`,
      onClick: () => onHistory(agent.id, canModify),
    },
    {
      icon: <Sparkles className="h-4 w-4" />,
      label: "Convert to skill",
      permissions: { skill: ["create"] },
      disabled: isBuiltIn || agent.agentType !== "agent",
      disabledTooltip: isBuiltIn
        ? "Built-in agents cannot be converted"
        : agent.agentType !== "agent"
          ? "Only internal agents can be converted to skills"
          : undefined,
      onClick: () => onConvertToSkill(agent),
    },
    {
      icon: <Trash2 className="h-4 w-4" />,
      label: ACTION_LABEL.delete,
      permissions: { agent: ["delete"] },
      disabled: isBuiltIn || !canModify,
      disabledTooltip: isBuiltIn
        ? "Built-in agents cannot be deleted"
        : notYoursToChange({ resource: "agent", scope: agent.scope }),
      variant: "destructive",
      onClick: () => onDelete(agent.id),
      testId: `${E2eTestId.DeleteAgentButton}-${agent.name}`,
    },
  ];

  return (
    <TableRowActions
      itemName={agent.name}
      actions={primaryActions}
      dropdownActions={dropdownActions}
    />
  );
}
