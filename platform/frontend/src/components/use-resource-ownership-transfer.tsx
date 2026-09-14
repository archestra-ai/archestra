"use client";
import { ARCHESTRA_MCP_CATALOG_ID } from "@archestra/shared";
import { UserRoundCog } from "lucide-react";
import { useState } from "react";
import { KebabItem } from "@/components/kebab-item";
import { TransferOwnershipDialog } from "@/components/transfer-ownership-dialog";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import {
  type TransferResourceKind,
  useTransferResourceOwnership,
} from "@/lib/resource-ownership.query";

export function useResourceOwnershipTransfer({
  kind,
  resource,
  onTransferred,
  disabledReason,
}: {
  kind: TransferResourceKind;
  resource?: {
    id: string;
    name: string;
    authorId: string | null;
    scope?: string;
    sourceRef?: string | null;
    serverType?: string;
    organizationId?: string | null;
  } | null;
  onTransferred?: () => void;
  disabledReason?: string;
}) {
  const [open, setOpen] = useState(false);
  const { data: session } = useSession();
  const permissionResource =
    kind === "catalog"
      ? "mcpRegistry"
      : kind === "remoteAgent"
        ? "agentSettings"
        : kind;
  const update = useHasPermissions({ [permissionResource]: ["update"] });
  const admin = useHasPermissions(
    kind === "catalog"
      ? { mcpServerInstallation: ["admin"] }
      : kind === "remoteAgent"
        ? { agentSettings: ["update"] }
        : { [permissionResource]: ["admin"] },
  );
  const managed =
    (kind === "skill" && resource?.sourceRef?.startsWith("builtin:")) ||
    (kind === "catalog" &&
      (resource?.organizationId === null ||
        resource?.id === ARCHESTRA_MCP_CATALOG_ID ||
        resource?.serverType === "app"));
  const allowed =
    !!update.data &&
    (!!admin.data ||
      (kind !== "plugin" &&
        !!session?.user.id &&
        resource?.authorId === session.user.id));
  return {
    menuItem:
      resource && !managed ? (
        <KebabItem
          icon={<UserRoundCog className="h-4 w-4" />}
          label="Transfer ownership"
          reason={
            !allowed
              ? "Only the owner or a resource admin can transfer ownership"
              : disabledReason
          }
          onSelect={() => setOpen(true)}
        />
      ) : null,
    dialog:
      open && resource ? (
        <ResourceTransferDialog
          kind={kind}
          resource={resource}
          onClose={() => setOpen(false)}
          onTransferred={() => {
            setOpen(false);
            onTransferred?.();
          }}
        />
      ) : null,
  };
}

function ResourceTransferDialog(props: {
  kind: TransferResourceKind;
  resource: {
    id: string;
    name: string;
    authorId: string | null;
    scope?: string;
  };
  onClose: () => void;
  onTransferred: () => void;
}) {
  const transfer = useTransferResourceOwnership(props.kind);
  return <TransferOwnershipDialog {...props} transfer={transfer} />;
}
