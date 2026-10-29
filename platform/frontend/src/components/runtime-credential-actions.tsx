"use client";

import type { Permissions } from "@archestra/shared";
import { Pencil, Plug, RefreshCw, Trash2, Unplug } from "lucide-react";
import { TableRowActions } from "@/components/table-row-actions";
import { useScopedCapabilities } from "@/lib/auth/auth.query";
import { holdsItemGrant } from "@/lib/auth/auth.utils";
import type { RuntimeCredentialDefinition } from "@/lib/runtime-credentials.query";

/**
 * The actions on one credential row, shared by Settings → Credentials and
 * Personal Settings → Credentials so both apply the same rules. `scope` is the
 * value the row acts on: the organization's value, or the reader's own.
 */
export function RuntimeCredentialActions({
  definition,
  scope,
  onConnect,
  onDisconnect,
  onEdit,
  onDelete,
}: {
  definition: RuntimeCredentialDefinition;
  scope: "organization" | "personal";
  onConnect: () => void;
  onDisconnect: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { data: scopedGrants } = useScopedCapabilities();
  const holds = (action: "update" | "manage-permissions") =>
    holdsItemGrant({
      grants: scopedGrants,
      resource: "credential",
      action,
      id: definition.id,
    });
  const organizationScope = scope === "organization";
  const connected = organizationScope
    ? definition.organizationConfigured
    : definition.personalConfigured;
  // An organization value is the credential itself, so setting it is an
  // edit. A personal value is the caller's own, so connecting one is use.
  const connectPermission = organizationScope
    ? { credential: ["update"] }
    : { credential: ["use"] };
  const primaryActions = [
    {
      icon: connected ? (
        <RefreshCw className="size-4" />
      ) : (
        <Plug className="size-4" />
      ),
      label: connected ? "Replace" : "Connect",
      onClick: onConnect,
      permissions: connectPermission,
      permissionScope: definition.id,
    },
  ];
  const dropdownActions = [
    // The dialog also holds the Permissions tab, so managing who has access
    // opens it even without the right to edit the credential itself.
    ...(!definition.builtIn && (holds("update") || holds("manage-permissions"))
      ? [
          {
            icon: <Pencil className="size-4" />,
            label: "Edit",
            onClick: onEdit,
          },
        ]
      : []),
    ...(connected
      ? [
          {
            icon: <Unplug className="size-4" />,
            label: "Disconnect",
            onClick: onDisconnect,
            // Clearing your own personal value needs nothing beyond seeing it.
            permissions: organizationScope
              ? ({ credential: ["update"] } as Permissions)
              : undefined,
            permissionScope: definition.id,
            variant: "destructive" as const,
          },
        ]
      : []),
    ...(!definition.builtIn
      ? [
          {
            icon: <Trash2 className="size-4" />,
            label: "Delete",
            onClick: onDelete,
            permissions: { credential: ["delete"] } as Permissions,
            permissionScope: definition.id,
            variant: "destructive" as const,
          },
        ]
      : []),
  ];

  return (
    <div className="flex items-center gap-2 self-end sm:self-auto">
      <TableRowActions
        actions={primaryActions}
        dropdownActions={dropdownActions}
        itemName={definition.name}
      />
    </div>
  );
}
