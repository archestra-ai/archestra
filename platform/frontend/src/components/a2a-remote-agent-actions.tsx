"use client";

import { Eye, Pencil, Trash2 } from "lucide-react";
import { TableRowActions } from "@/components/table-row-actions";
import type { A2aRemoteAgent } from "@/lib/a2a-remote-agents.query";

export function A2aRemoteAgentActions({
  agent,
  canEdit,
  canDelete,
  onOpen,
  onDelete,
}: {
  agent: A2aRemoteAgent;
  canEdit: boolean;
  canDelete: boolean;
  onOpen: () => void;
  onDelete: () => void;
}) {
  return (
    <TableRowActions
      itemName={agent.name}
      actions={[
        canEdit
          ? {
              icon: <Pencil className="h-4 w-4" />,
              label: "Edit",
              onClick: onOpen,
            }
          : {
              icon: <Eye className="h-4 w-4" />,
              label: "View",
              onClick: onOpen,
            },
      ]}
      dropdownActions={
        canDelete
          ? [
              {
                icon: <Trash2 className="h-4 w-4" />,
                label: "Delete",
                variant: "destructive",
                onClick: onDelete,
              },
            ]
          : undefined
      }
    />
  );
}
