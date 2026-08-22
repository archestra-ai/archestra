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
import {
  agentAction,
  getAgentActionModel,
} from "@/components/agent-pages/agent-actions-model";
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
  const actionModel = getAgentActionModel({ kind: "agent", agent });
  const connectAction = agentAction(actionModel, "connect");
  const chatAction = agentAction(actionModel, "chat");
  const editAction = agentAction(actionModel, "edit");
  const cloneAction = agentAction(actionModel, "clone");
  const exportAction = agentAction(actionModel, "export");
  const historyAction = agentAction(actionModel, "history");
  const convertAction = agentAction(actionModel, "convert");
  const deleteAction = agentAction(actionModel, "delete");

  if (isDeleted) {
    return (
      <TableRowActions
        itemName={agent.name}
        actions={[
          {
            icon: <RotateCcw className="h-4 w-4" />,
            label: ACTION_LABEL.restore,
            permissions: deleteAction.permissions,
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
          label: editAction.label,
          // A built-in agent is an org-wide record that only a resource admin
          // may change (`requireAgentModifyPermission`), so the row asks for
          // the permission the destination will actually check. Asking for
          // `agent:update` let any holder of it through to an edit page that
          // renders every field disabled.
          permissions: editAction.permissions,
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
    ...(connectAction.visible
      ? [
          {
            icon: <Plug className="h-4 w-4" />,
            label: connectAction.label,
            permissions: connectAction.permissions,
            href: connectAction.href,
            testId: `${E2eTestId.ConnectAgentButton}-${agent.name}`,
          },
        ]
      : []),
    ...(chatAction.visible
      ? [
          {
            icon: <MessageSquare className="h-4 w-4" />,
            label: chatAction.label,
            href: chatAction.href,
          },
        ]
      : []),
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
      label: cloneAction.label,
      disabled: isBuiltIn,
      disabledTooltip: isBuiltIn
        ? "Built-in agents cannot be cloned"
        : undefined,
      permissions: cloneAction.permissions,
      onClick: () => onClone(agent),
      testId: `${E2eTestId.CloneAgentButton}-${agent.name}`,
    },
    {
      icon: <Download className="h-4 w-4" />,
      label: exportAction.label,
      permissions: exportAction.permissions,
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
      label: historyAction.label,
      permissions: historyAction.permissions,
      testId: `${E2eTestId.AgentVersionHistoryButton}-${agent.name}`,
      onClick: () => onHistory(agent.id, canModify),
    },
    {
      icon: <Sparkles className="h-4 w-4" />,
      label: convertAction.label,
      permissions: convertAction.permissions,
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
      label: deleteAction.label,
      permissions: deleteAction.permissions,
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
