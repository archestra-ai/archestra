import { E2eTestId } from "@shared";
import { Pencil, Plug, Trash2 } from "lucide-react";
import { ButtonGroup } from "@/components/ui/button-group";
import { PermissionButton } from "@/components/ui/permission-button";
import type { useProfilesPaginated } from "@/lib/agent.query";

// Infer Proxy type from the API response
type Proxy = NonNullable<
  ReturnType<typeof useProfilesPaginated>["data"]
>["data"][number];

type LlmProxyActionsProps = {
  agent: Proxy;
  onConnect: (agent: Pick<Proxy, "id" | "name" | "agentType">) => void;
  onEdit: (agent: Proxy) => void;
  onDelete: (agentId: string) => void;
};

export function LlmProxyActions({
  agent,
  onConnect,
  onEdit,
  onDelete,
}: LlmProxyActionsProps) {
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
