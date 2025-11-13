import { E2eTestId } from "@shared";
import { MessageCircle, Pencil, Plug, Trash2, Wrench } from "lucide-react";
import type { ReactNode } from "react";
import type { AgentLabel } from "@/components/agent-labels";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface ActionButtonProps {
  children: ReactNode;
  tooltip: string;
  onClick: (e: React.MouseEvent) => void;
  "data-testid"?: string;
  className?: string;
}

function ActionButton({
  children,
  tooltip,
  onClick,
  "data-testid": dataTestId,
  className,
}: ActionButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          onClick={(e) => {
            e.stopPropagation();
            onClick(e);
          }}
          data-testid={dataTestId}
          aria-label={tooltip}
          className={`border h-8 w-8 ${className}`}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  );
}

type Agent = {
  id: string;
  name: string;
  teams: string[];
  labels: AgentLabel[];
  optimizeCost?: boolean;
  considerContextUntrusted: boolean;
  tools: Array<{ id: string }>;
}

type AgentActionsProps = {
  agent: Agent;
  userCanDeleteAgents: boolean;
  onConnect: (agent: Pick<Agent, 'id' | 'name'>) => void;
  onAssignTools: (agent: Agent) => void;
  onConfigureChat: (agent: Agent) => void;
  onEdit: (agent: Omit<Agent, 'tools'>) => void;
  onDelete: (agentId: string) => void;
}

export function AgentActions({
  agent,
  userCanDeleteAgents,
  onConnect,
  onAssignTools,
  onConfigureChat,
  onEdit,
  onDelete,
}: AgentActionsProps) {
  return (
    <ButtonGroup>
      <ActionButton
        tooltip="Connect"
        onClick={() => onConnect(agent)}
      >
        <Plug className="h-4 w-4" />
      </ActionButton>
      <ActionButton
        tooltip="Assign Tools"
        onClick={() => onAssignTools(agent)}
      >
        <Wrench className="h-4 w-4" />
      </ActionButton>
      <ActionButton
        tooltip="Prompts"
        onClick={() => onConfigureChat(agent)}
      >
        <MessageCircle className="h-4 w-4" />
      </ActionButton>
      <ActionButton
        tooltip="Edit"
        onClick={() =>
          onEdit({
            id: agent.id,
            name: agent.name,
            teams: agent.teams || [],
            labels: agent.labels || [],
            optimizeCost: agent.optimizeCost,
            considerContextUntrusted: agent.considerContextUntrusted,
          })
        }
      >
        <Pencil className="h-4 w-4" />
      </ActionButton>
      {userCanDeleteAgents && (
        <ActionButton
          tooltip="Delete"
          onClick={() => onDelete(agent.id)}
          data-testid={`${E2eTestId.DeleteAgentButton}-${agent.name}`}
        >
          <Trash2 className="h-4 w-4 text-destructive" />
        </ActionButton>
      )}
    </ButtonGroup>
  );
}
