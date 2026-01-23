import { E2eTestId } from "@shared";
import { MessageSquare, Pencil, Plug, Trash2 } from "lucide-react";
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

// Infer Profile type from the API response
type Profile = NonNullable<
  ReturnType<typeof useProfilesPaginated>["data"]
>["data"][number];

type ProfileActionsProps = {
  agent: Profile;
  onConnect: (agent: Pick<Profile, "id" | "name" | "agentType">) => void;
  onEdit: (agent: Profile) => void;
  onDelete: (agentId: string) => void;
};

export function ProfileActions({
  agent,
  onConnect,
  onEdit,
  onDelete,
}: ProfileActionsProps) {
  return (
    <ButtonGroup>
      <PermissionButton
        permissions={{ profile: ["update"] }}
        aria-label="Connect"
        tooltip="Connect"
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
      {agent.agentType === "agent" && (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
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
            </TooltipTrigger>
            <TooltipContent>Chat</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}
      <PermissionButton
        permissions={{ profile: ["update"] }}
        tooltip="Edit"
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
