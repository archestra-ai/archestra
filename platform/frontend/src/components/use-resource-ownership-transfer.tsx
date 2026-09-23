"use client";
import {
  type AgentType,
  ARCHESTRA_MCP_CATALOG_ID,
  getResourceForAgentType,
} from "@archestra/shared";
import { UserRoundCog } from "lucide-react";
import { useState } from "react";
import { KebabItem } from "@/components/kebab-item";
import { TransferAgentOwnershipDialog } from "@/components/transfer-agent-ownership-dialog";
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
  kind: TransferResourceKind | "agent" | "mcp_gateway";
  resource?: {
    id: string;
    name: string;
    authorId: string | null;
    scope?: string;
    sourceRef?: string | null;
    serverType?: string;
    organizationId?: string | null;
    agentType?: AgentType;
    builtIn?: boolean | null;
    isPersonalGateway?: boolean;
    isPersonalProxy?: boolean;
  } | null;
  onTransferred?: () => void;
  disabledReason?: string;
}) {
  const [open, setOpen] = useState(false);
  const { data: session } = useSession();
  const permissionResource =
    kind === "agent" || kind === "mcp_gateway"
      ? getResourceForAgentType(
          resource?.agentType ?? (kind === "agent" ? "agent" : "mcp_gateway"),
        )
      : kind === "catalog"
        ? "mcpRegistry"
        : kind === "remoteAgent"
          ? "agentSettings"
          : kind;
  const update = useHasPermissions({ [permissionResource]: ["update"] });
  // Managing every object of the kind is `update` at `*`, the grant the
  // retired `admin` role actions became.
  const admin = useHasPermissions(
    kind === "catalog"
      ? { mcpRegistry: ["update"] }
      : kind === "remoteAgent"
        ? { agentSettings: ["update"] }
        : { [permissionResource]: ["update"] },
    "*",
  );
  const managed =
    ((kind === "agent" || kind === "mcp_gateway") &&
      (resource?.builtIn ||
        resource?.isPersonalGateway ||
        resource?.isPersonalProxy ||
        resource?.agentType === "llm_proxy")) ||
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
  kind: TransferResourceKind | "agent" | "mcp_gateway";
  resource: {
    id: string;
    name: string;
    authorId: string | null;
    scope?: string;
  };
  onClose: () => void;
  onTransferred: () => void;
}) {
  if (props.kind === "agent" || props.kind === "mcp_gateway") {
    return (
      <TransferAgentOwnershipDialog
        agent={{
          ...props.resource,
          scope: props.resource.scope as "personal" | "team" | "org",
        }}
        onClose={props.onClose}
        onTransferred={props.onTransferred}
      />
    );
  }
  return <NonAgentTransferDialog {...props} kind={props.kind} />;
}

function NonAgentTransferDialog(
  props: Omit<Parameters<typeof ResourceTransferDialog>[0], "kind"> & {
    kind: TransferResourceKind;
  },
) {
  const transfer = useTransferResourceOwnership(props.kind);
  return <TransferOwnershipDialog {...props} transfer={transfer} />;
}
