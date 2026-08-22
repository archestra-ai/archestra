import { E2eTestId } from "@archestra/shared";
import { Copy, History, Pencil, Plug, RotateCcw, Trash2 } from "lucide-react";
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

// Infer Proxy type from the API response
type Proxy = NonNullable<
  ReturnType<typeof useProfilesPaginated>["data"]
>["data"][number];

type LlmProxyActionsProps = {
  agent: Proxy;
  canModify: boolean;
  onEdit: (agent: Proxy) => void;
  onDelete: (agentId: string) => void;
  onRestore: (agentId: string) => void;
  onPermanentlyDelete: (agent: Proxy) => void;
  onClone: (agent: Proxy) => void;
  /**
   * Carries `canModify` with the id: the history dialog offers a restore,
   * which is an update, so it needs the same scope check the row's own
   * mutating buttons apply rather than RBAC alone.
   */
  onHistory: (agentId: string, canModify: boolean) => void;
};

/**
 * One row dialect across the five entity surfaces: the two actions a row is
 * usually clicked for as labelled icon buttons, everything else in the row's
 * "More actions" menu with the destructive one last. This used to be a bare
 * `ButtonGroup` of five icons with no `tooltip` on any of them, so a permitted
 * user got no hover label at all — on Delete included.
 */
export function LlmProxyActions({
  agent,
  canModify,
  onEdit,
  onDelete,
  onRestore,
  onPermanentlyDelete,
  onClone,
  onHistory,
}: LlmProxyActionsProps) {
  const admin = useIsGlobalAdmin();
  const actionModel = getAgentActionModel({ kind: "llm_proxy", agent });
  const connectAction = agentAction(actionModel, "connect");
  const editAction = agentAction(actionModel, "edit");
  const cloneAction = agentAction(actionModel, "clone");
  const historyAction = agentAction(actionModel, "history");
  const deleteAction = agentAction(actionModel, "delete");
  const isBuiltIn = !!agent.builtIn;

  if (agent.deletedAt) {
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
              resource: "llm_proxy",
              scope: agent.scope,
            }),
            onClick: () => onRestore(agent.id),
          },
        ]}
        dropdownActions={[
          permanentDeleteRowAction({
            admin,
            onClick: () => onPermanentlyDelete(agent),
          }),
        ]}
      />
    );
  }

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
    {
      icon: <Pencil className="h-4 w-4" />,
      label: editAction.label,
      permissions: editAction.permissions,
      disabled: !canModify,
      disabledTooltip: notYoursToChange({
        resource: "llm_proxy",
        scope: agent.scope,
      }),
      onClick: () => onEdit(agent),
      testId: `${E2eTestId.EditAgentButton}-${agent.name}`,
    },
  ];

  const dropdownActions: TableRowAction[] = [
    {
      icon: <Copy className="h-4 w-4" />,
      label: cloneAction.label,
      permissions: cloneAction.permissions,
      disabled: isBuiltIn,
      disabledTooltip: isBuiltIn
        ? "Built-in LLM proxies cannot be cloned"
        : undefined,
      onClick: () => onClone(agent),
      testId: `${E2eTestId.CloneAgentButton}-${agent.name}`,
    },
    {
      icon: <History className="h-4 w-4" />,
      label: historyAction.label,
      permissions: historyAction.permissions,
      onClick: () => onHistory(agent.id, canModify),
      testId: `${E2eTestId.AgentVersionHistoryButton}-${agent.name}`,
    },
    {
      icon: <Trash2 className="h-4 w-4" />,
      label: deleteAction.label,
      permissions: deleteAction.permissions,
      disabled: isBuiltIn || !canModify,
      disabledTooltip: isBuiltIn
        ? "Built-in LLM proxies cannot be deleted"
        : notYoursToChange({
            resource: "llm_proxy",
            scope: agent.scope,
          }),
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
