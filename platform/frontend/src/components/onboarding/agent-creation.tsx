"use client";

import { useState } from "react";
import { toast } from "sonner";
import { useCreateAgent } from "@/lib/agent.query";
import OnboardingStep from "../onboarding-step";
import { Input } from "../ui/input";

interface AgentCreationProps {
  isActive: boolean;
  isTransitioning: boolean;
  onComplete: (agentId: string) => void;
}

export function AgentCreation({
  isActive,
  isTransitioning,
  onComplete,
}: AgentCreationProps) {
  const [agentName, setAgentName] = useState("My MCP Agent");
  const createAgent = useCreateAgent();

  const handleCreate = async () => {
    try {
      const result = await createAgent.mutateAsync({
        name: agentName,
        teams: [],
      });

      if (result) {
        onComplete(result.id);
      }
    } catch (error) {
      toast.error("Failed to create agent. Please try again.");
    }
  };

  return (
    <OnboardingStep
      title="Create Agent"
      description="Give your agent a name. This agent will be configured to use the MCP gateway."
      isActive={isActive}
      isTransitioning={isTransitioning}
      primaryAction={{
        label: createAgent.isPending ? "Creating..." : "Create Agent",
        onClick: handleCreate,
        disabled: createAgent.isPending || !agentName.trim(),
      }}
    >
      <div className="space-y-2">
        <label htmlFor="agent-name" className="block text-sm text-slate-300">
          Agent Name
        </label>
        <Input
          id="agent-name"
          value={agentName}
          onChange={(e) => setAgentName(e.target.value)}
          placeholder="My MCP Agent"
          className="w-full rounded border border-slate-700 bg-slate-950/20 px-3 py-2 text-sm text-slate-200"
        />
      </div>
    </OnboardingStep>
  );
}
