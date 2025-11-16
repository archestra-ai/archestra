import { E2eTestId } from "@shared";
import { MessageCircle, Pencil, Plug, Trash2 } from "lucide-react";
import { ActionButton } from "@/components/ui/action-button";
import { ButtonGroup } from "@/components/ui/button-group";
import type { useAgentsPaginated } from "@/lib/agent.query";

// Infer Agent type from the API response
type Agent = NonNullable<
  ReturnType<typeof useAgentsPaginated>["data"]
>["data"][number];

type AgentActionsProps = {
  agent: Agent;
  userCanDeleteAgents: boolean;
  onConnect: (agent: Pick<Agent, "id" | "name">) => void;
  onConfigureChat: (agent: Agent) => void;
  onEdit: (agent: Omit<Agent, "tools">) => void;
  onDelete: (agentId: string) => void;
};

export function AgentActions({
  agent,
  userCanDeleteAgents,
  onConnect,
  onConfigureChat,
  onEdit,
  onDelete,
}: AgentActionsProps) {
  return (
    <ButtonGroup>
      <ActionButton
        aria-label="Connect"
        tooltip="Connect"
        onClick={() => onConnect(agent)}
      >
        <Plug className="h-4 w-4" />
      </ActionButton>
      <ActionButton
        aria-label="Prompts"
        tooltip="Prompts"
        onClick={() => onConfigureChat(agent)}
      >
        <MessageCircle className="h-4 w-4" />
      </ActionButton>
      <ActionButton
        tooltip="Edit"
        aria-label="Edit"
        onClick={() =>
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
          })
        }
      >
        <Pencil className="h-4 w-4" />
      </ActionButton>
      {userCanDeleteAgents && (
        <ActionButton
          tooltip="Delete"
          onClick={() => onDelete(agent.id)}
          aria-label="Delete"
          data-testid={`${E2eTestId.DeleteAgentButton}-${agent.name}`}
        >
          <Trash2 className="h-4 w-4 text-destructive" />
        </ActionButton>
      )}
    </ButtonGroup>
  );
}
