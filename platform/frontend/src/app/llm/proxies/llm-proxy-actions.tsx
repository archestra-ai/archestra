import { E2eTestId } from "@archestra/shared";
import { Copy, History, Pencil, Plug, RotateCcw, Trash2 } from "lucide-react";
import { PermanentDeleteButton } from "@/components/permanent-delete";
import { ButtonGroup } from "@/components/ui/button-group";
import { PermissionButton } from "@/components/ui/permission-button";
import type { useProfilesPaginated } from "@/lib/agent.query";

// Infer Proxy type from the API response
type Proxy = NonNullable<
  ReturnType<typeof useProfilesPaginated>["data"]
>["data"][number];

type LlmProxyActionsProps = {
  agent: Proxy;
  canModify: boolean;
  onConnect: (agent: Pick<Proxy, "id" | "name" | "agentType">) => void;
  onEdit: (agent: Proxy) => void;
  onDelete: (agentId: string) => void;
  onRestore: (agentId: string) => void;
  onPermanentlyDelete: (agent: Proxy) => void;
  onClone: (agent: Proxy) => void;
  /**
   * Carries `canModify` with the id: the history dialog offers a restore,
   * which is an update, so it needs the same scope check the row's own
   * mutating buttons apply rather than RBAC alone.
   */
  onHistory: (agentId: string, canModify: boolean) => void;
};

export function LlmProxyActions({
  agent,
  canModify,
  onConnect,
  onEdit,
  onDelete,
  onRestore,
  onPermanentlyDelete,
  onClone,
  onHistory,
}: LlmProxyActionsProps) {
  if (agent.deletedAt) {
    return (
      <ButtonGroup>
        <PermissionButton
          permissions={{ llmProxy: ["delete"] }}
          aria-label="Restore"
          variant="outline"
          size="icon-sm"
          disabled={!canModify}
          onClick={(e) => {
            e.stopPropagation();
            onRestore(agent.id);
          }}
        >
          <RotateCcw className="h-4 w-4" />
        </PermissionButton>
        <PermanentDeleteButton
          itemName={agent.name}
          onClick={() => onPermanentlyDelete(agent)}
        />
      </ButtonGroup>
    );
  }

  return (
    <ButtonGroup>
      <PermissionButton
        permissions={{ llmProxy: ["read"] }}
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
        permissions={{ llmProxy: ["update"] }}
        aria-label="Edit"
        variant="outline"
        size="icon-sm"
        disabled={!canModify}
        data-testid={`${E2eTestId.EditAgentButton}-${agent.name}`}
        onClick={(e) => {
          e.stopPropagation();
          onEdit(agent);
        }}
      >
        <Pencil className="h-4 w-4" />
      </PermissionButton>
      <PermissionButton
        permissions={{ llmProxy: ["create"] }}
        aria-label="Clone"
        variant="outline"
        size="icon-sm"
        data-testid={`${E2eTestId.CloneAgentButton}-${agent.name}`}
        onClick={(e) => {
          e.stopPropagation();
          onClone(agent);
        }}
      >
        <Copy className="h-4 w-4" />
      </PermissionButton>
      <PermissionButton
        permissions={{ llmProxy: ["read"] }}
        aria-label="Version history"
        variant="outline"
        size="icon-sm"
        data-testid={`${E2eTestId.AgentVersionHistoryButton}-${agent.name}`}
        onClick={(e) => {
          e.stopPropagation();
          onHistory(agent.id, canModify);
        }}
      >
        <History className="h-4 w-4" />
      </PermissionButton>
      <PermissionButton
        permissions={{ llmProxy: ["delete"] }}
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
    </ButtonGroup>
  );
}
