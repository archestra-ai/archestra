import { E2eTestId } from "@shared";
import { Grip, MessageSquare, Pencil, Plug, Trash2 } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import { PermissionButton } from "@/components/ui/permission-button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { useProfilesPaginated } from "@/lib/agent.query";

// Infer Agent type from the API response
type Agent = NonNullable<
  ReturnType<typeof useProfilesPaginated>["data"]
>["data"][number];

type AgentActionsProps = {
  agent: Agent;
  canModify: boolean;
  onConnect: (agent: Pick<Agent, "id" | "name" | "agentType">) => void;
  onEdit: (agent: Agent) => void;
  onDelete: (agentId: string) => void;
};

function DisabledBuiltInButton({
  children,
  tooltip,
  "aria-label": ariaLabel,
}: {
  children: React.ReactNode;
  tooltip: string;
  "aria-label": string;
}) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            aria-label={ariaLabel}
            variant="outline"
            size="icon-sm"
            disabled
          >
            {children}
          </Button>
        </TooltipTrigger>
        <TooltipContent>{tooltip}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export function AgentActions({
  agent,
  canModify,
  onConnect,
  onEdit,
  onDelete,
}: AgentActionsProps) {
  const isBuiltIn = agent.builtIn;

  return (
    <ButtonGroup>
      {isBuiltIn ? (
        <DisabledBuiltInButton
          aria-label="Connect"
          tooltip="Built-in agents cannot be connected"
        >
          <Plug className="h-4 w-4" />
        </DisabledBuiltInButton>
      ) : (
        <Button
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
        </Button>
      )}
      {isBuiltIn ? (
        <DisabledBuiltInButton
          aria-label="Chat"
          tooltip="Built-in agents cannot be chatted with"
        >
          <MessageSquare className="h-4 w-4" />
        </DisabledBuiltInButton>
      ) : (
        <Button
          variant="outline"
          size="icon-sm"
          aria-label="Chat"
          asChild
          onClick={(e) => e.stopPropagation()}
        >
          <Link href={`/chat/new?agent_id=${agent.id}`}>
            <MessageSquare className="h-4 w-4" />
          </Link>
        </Button>
      )}
      {isBuiltIn ? (
        <DisabledBuiltInButton
          aria-label="Agent Builder"
          tooltip="Built-in agents cannot use Agent Builder"
        >
          <Grip className="h-4 w-4" />
        </DisabledBuiltInButton>
      ) : (
        <Button
          variant="outline"
          size="icon-sm"
          aria-label="Agent Builder"
          asChild
          onClick={(e) => e.stopPropagation()}
        >
          <Link href={`/agents/builder?agentId=${agent.id}`}>
            <Grip className="h-4 w-4" />
          </Link>
        </Button>
      )}
      <PermissionButton
        permissions={{ agent: ["update"] }}
        aria-label="Edit"
        variant="outline"
        size="icon-sm"
        disabled={!canModify && !isBuiltIn}
        data-testid={`${E2eTestId.EditAgentButton}-${agent.name}`}
        onClick={(e) => {
          e.stopPropagation();
          onEdit(agent);
        }}
      >
        <Pencil className="h-4 w-4" />
      </PermissionButton>
      {isBuiltIn ? (
        <DisabledBuiltInButton
          aria-label="Delete"
          tooltip="Built-in agents cannot be deleted"
        >
          <Trash2 className="h-4 w-4 text-destructive" />
        </DisabledBuiltInButton>
      ) : (
        <PermissionButton
          permissions={{ agent: ["delete"] }}
          aria-label="Delete"
          variant="outline"
          size="icon-sm"
          disabled={!canModify}
          onClick={(e) => {
            e.stopPropagation();
            onDelete(agent.id);
          }}
          data-testid={`${E2eTestId.DeleteAgentButton}-${agent.name}`}
        >
          <Trash2 className="h-4 w-4 text-destructive" />
        </PermissionButton>
      )}
    </ButtonGroup>
  );
}
