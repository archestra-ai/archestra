"use client";

import { Bot } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { A2AConnectionInstructions } from "@/components/a2a-connection-instructions";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useInternalAgents } from "@/lib/agent.query";
import { useHasPermissions } from "@/lib/auth/auth.query";

export default function A2APage() {
  const { data: internalAgents } = useInternalAgents({ enabled: true });
  const { data: canCreateAgent } = useHasPermissions({ agent: ["create"] });

  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const effectiveAgentId = selectedAgentId ?? internalAgents?.[0]?.id ?? null;
  const selectedAgent = internalAgents?.find((a) => a.id === effectiveAgentId);

  if (internalAgents && internalAgents.length === 0) {
    return (
      <div className="rounded-lg border border-dashed bg-muted/30 p-6 text-center text-sm text-muted-foreground">
        <div className="font-medium text-foreground">No agents available</div>
        <p className="mt-1">
          {canCreateAgent ? (
            <>
              <Link href="/agents" className="underline hover:text-foreground">
                Create an agent
              </Link>{" "}
              to expose it via A2A.
            </>
          ) : (
            "Ask an admin to create an agent so it can be exposed via A2A."
          )}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6 rounded-lg border bg-card p-4">
      <div className="space-y-2">
        <Label className="text-sm font-medium">Select Agent</Label>
        <Select
          value={effectiveAgentId ?? ""}
          onValueChange={setSelectedAgentId}
        >
          <SelectTrigger className="w-full">
            <SelectValue placeholder="Select an agent">
              {selectedAgent && (
                <div className="flex items-center gap-2 min-w-0">
                  <Bot className="h-4 w-4 shrink-0" />
                  <span className="truncate">{selectedAgent.name}</span>
                </div>
              )}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {internalAgents?.map((agent) => (
              <SelectItem key={agent.id} value={agent.id}>
                <div className="flex items-center gap-2 min-w-0">
                  <Bot className="h-4 w-4 shrink-0" />
                  <span className="truncate">{agent.name}</span>
                </div>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {selectedAgent && <A2AConnectionInstructions agent={selectedAgent} />}
    </div>
  );
}
