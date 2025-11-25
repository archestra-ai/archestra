import { E2eTestId } from "@shared";
import { Pencil, Plug, Trash2 } from "lucide-react";
import { ButtonGroup } from "@/components/ui/button-group";
import { PermissionButton } from "@/components/ui/permission-button";
import type { useAgentsPaginated } from "@/lib/agent.query";

// Infer Agent type from the API response
type Agent = NonNullable<
  ReturnType<typeof useAgentsPaginated>["data"]
>["data"][number];

type AgentActionsProps = {
  agent: Agent;
  onConnect: (agent: Pick<Agent, "id" | "name">) => void;
  onEdit: (agent: Omit<Agent, "tools">) => void;
  onDelete: (agentId: string) => void;
};

export function AgentActions({
  agent,
  onConnect,
  onEdit,
  onDelete,
}: AgentActionsProps) {
  return (
    <ButtonGroup>
      <PermissionButton
        permissions={{ profile: ["update"] }}
        aria-label="Connect"
        tooltip="Connect"
        variant="outline"
        size="icon-sm"
        onClick={(e) => {
          e.stopPropagation();
          onConnect(agent);
        }}
      >
        <Plug className="h-4 w-4" />
      </PermissionButton>
      <PermissionButton
        permissions={{ profile: ["update"] }}
        tooltip="Edit"
        aria-label="Edit"
        variant="outline"
        size="icon-sm"
        onClick={(e) => {
          e.stopPropagation();
          onEdit({
            id: agent.id,
            name: agent.name,
            isDemo: agent.isDemo,
            isDefault: agent.isDefault,
            teams: agent.teams || [],
            labels: agent.labels || [],
            optimizeCost: agent.optimizeCost,
            considerContextUntrusted: agent.considerContextUntrusted,
            createdAt: agent.createdAt,
            updatedAt: agent.updatedAt,
            useInChat: agent.useInChat,
            convertToolResultsToToon: agent.convertToolResultsToToon,
          });
        }}
      >
        <Pencil className="h-4 w-4" />
      </PermissionButton>
      <PermissionButton
        permissions={{ profile: ["delete"] }}
        tooltip="Delete"
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
