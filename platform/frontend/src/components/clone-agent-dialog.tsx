"use client";

import type { archestraApiTypes } from "@archestra/shared";
import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { agentTypeDisplayName } from "@/components/agent-form";
import {
  type InitialPermissionGrant,
  InitialResourcePermissions,
} from "@/components/initial-resource-permissions";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogForm,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useCloneAgent } from "@/lib/agent.query";

type CloneSourceAgent = Pick<
  archestraApiTypes.GetAgentsResponses["200"]["data"][number],
  "id" | "name" | "agentType" | "scope" | "teams"
>;

type CloneAgentDialogProps = {
  /** Agent / MCP gateway / LLM proxy to clone; null keeps the dialog closed. */
  agent: CloneSourceAgent | null;
  onOpenChange: (open: boolean) => void;
  /** Called with the newly created clone (e.g. to open its edit dialog). */
  onCloned?: (cloned: archestraApiTypes.CloneAgentResponses["200"]) => void;
};

/**
 * Copies configuration with explicit grants for the new object.
 */
export function CloneAgentDialog({
  agent,
  onOpenChange,
  onCloned,
}: CloneAgentDialogProps) {
  const cloneAgent = useCloneAgent();

  const [initialGrants, setInitialGrants] = useState<InitialPermissionGrant[]>(
    [],
  );
  useEffect(() => {
    setInitialGrants([]);
  }, []);

  const handleSubmit = async () => {
    if (!agent) return;
    try {
      const cloned = await cloneAgent.mutateAsync({
        id: agent.id,
        initialGrants: initialGrants.map(({ subject, actions }) => ({
          subject,
          actions,
        })),
      });
      if (cloned) {
        onOpenChange(false);
        onCloned?.(cloned);
      }
    } catch (_error) {
      // The mutation already surfaced the API error as a toast
    }
  };

  const displayName = agentTypeDisplayName[agent?.agentType ?? "agent"];

  return (
    <Dialog open={agent !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Clone {displayName}</DialogTitle>
          <DialogDescription>
            {agent
              ? `Creates a copy of "${agent.name}" with the same configuration.`
              : null}
          </DialogDescription>
        </DialogHeader>

        {agent ? (
          <DialogForm onSubmit={handleSubmit}>
            <DialogBody>
              <InitialResourcePermissions
                resource={
                  agent.agentType === "mcp_gateway" ? "mcpGateway" : "agent"
                }
                grants={initialGrants}
                onChange={setInitialGrants}
              />
            </DialogBody>

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
                disabled={cloneAgent.isPending}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={cloneAgent.isPending}>
                {cloneAgent.isPending && (
                  <Loader2 className="h-4 w-4 animate-spin" />
                )}
                <span>Clone</span>
              </Button>
            </DialogFooter>
          </DialogForm>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
