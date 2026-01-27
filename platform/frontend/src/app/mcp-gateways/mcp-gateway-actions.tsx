import { E2eTestId } from "@shared";
import { Pencil, Plug, Trash2 } from "lucide-react";
import { ButtonGroup } from "@/components/ui/button-group";
import { PermissionButton } from "@/components/ui/permission-button";
import type { useProfilesPaginated } from "@/lib/agent.query";

// Infer Gateway type from the API response
type Gateway = NonNullable<
  ReturnType<typeof useProfilesPaginated>["data"]
>["data"][number];

type McpGatewayActionsProps = {
  agent: Gateway;
  onConnect: (agent: Pick<Gateway, "id" | "name" | "agentType">) => void;
  onEdit: (agent: Gateway) => void;
  onDelete: (agentId: string) => void;
};

export function McpGatewayActions({
  agent,
  onConnect,
  onEdit,
  onDelete,
}: McpGatewayActionsProps) {
  return (
    <ButtonGroup>
      <PermissionButton
        permissions={{ profile: ["update"] }}
        aria-label="Connect"
        variant="outline"
        size="icon-sm"
        data-testid={`${E2eTestId.ConnectAgentButton}-${agent.name}`}
        onClick={(e) => {
          e.stopPropagation();
          onConnect(agent);
        }}
      >
        <Plug className="h-4 w-4" />
      </PermissionButton>
      <PermissionButton
        permissions={{ profile: ["update"] }}
        aria-label="Edit"
        variant="outline"
        size="icon-sm"
        data-testid={`${E2eTestId.EditAgentButton}-${agent.name}`}
        onClick={(e) => {
          e.stopPropagation();
          onEdit(agent);
        }}
      >
        <Pencil className="h-4 w-4" />
      </PermissionButton>
      <PermissionButton
        permissions={{ profile: ["delete"] }}
        aria-label="Delete"
        variant="outline"
        size="icon-sm"
        onClick={(e) => {
          e.stopPropagation();
          onDelete(agent.id);
        }}
        data-testid={`${E2eTestId.DeleteAgentButton}-${agent.name}`}
      >
        <Trash2 className="h-4 w-4 text-destructive" />
      </PermissionButton>
    </ButtonGroup>
  );
}
