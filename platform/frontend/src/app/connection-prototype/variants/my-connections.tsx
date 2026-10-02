"use client";

import { Plus, Unplug, Wrench } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  ClientLine,
  CommandBlock,
  ProtoPage,
  relativeDay,
  STATUS_LABEL,
} from "../_parts/proto-ui";
import type { PrototypeVariantProps } from "../variants";

// Avenue G: the return-visit home. Status per agent, revoke that works
// everywhere, and the one-line local cleanup.
export default function MyConnectionsVariant({
  scenario,
}: PrototypeVariantProps) {
  const [revoked, setRevoked] = useState<string[]>([]);
  const agents = scenario.connectedAgents;

  return (
    <ProtoPage
      title="My connections"
      subtitle="Disconnecting here cuts access everywhere, instantly."
    >
      <div className="flex justify-end">
        <Button>
          <Plus />
          <span>Connect another agent</span>
        </Button>
      </div>
      {agents.length === 0 ? (
        <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
          No agents connected yet. Try the “Returning user” scenario.
        </div>
      ) : (
        <div className="divide-y rounded-lg border bg-card">
          {agents.map((agent) => {
            const isRevoked = revoked.includes(agent.id);
            return (
              <div key={agent.id} className="flex flex-col gap-3 p-4">
                <ClientLine clientId={agent.clientId}>
                  <Badge variant={isRevoked ? "outline" : "secondary"}>
                    <span>
                      {isRevoked ? "Revoked" : STATUS_LABEL[agent.status]}
                    </span>
                  </Badge>
                </ClientLine>
                <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted-foreground">
                  <span>Connected {relativeDay(agent.firstConnectedAt)}</span>
                  <span>Last used {relativeDay(agent.lastUsedAt)}</span>
                  <span>
                    Add-ons:{" "}
                    {agent.addOns.length > 0 ? agent.addOns.join(", ") : "none"}
                  </span>
                </div>
                {isRevoked ? (
                  <div className="flex flex-col gap-2">
                    <span className="text-sm">
                      Access is cut. To also tidy your local config, run:
                    </span>
                    <CommandBlock code="claude mcp remove archestra" />
                  </div>
                ) : (
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setRevoked([...revoked, agent.id])}
                    >
                      <Unplug />
                      <span>Disconnect</span>
                    </Button>
                    <Button size="sm" variant="ghost">
                      <Wrench />
                      <span>Repair</span>
                    </Button>
                    <Button size="sm" variant="ghost">
                      <Plus />
                      <span>Add skills</span>
                    </Button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </ProtoPage>
  );
}
