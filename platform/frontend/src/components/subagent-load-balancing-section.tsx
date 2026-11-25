"use client";

import {
  SUBAGENT_LOAD_BALANCING_MAX_WEIGHT,
  SUBAGENT_LOAD_BALANCING_MIN_WEIGHT,
  type SubagentLoadBalancingAlgorithm,
  type SubagentLoadBalancingConfig,
} from "@archestra/shared";
import { Scale } from "lucide-react";
import { useId } from "react";
import { AgentRuntimeChip } from "@/components/chat/runtime-capable-indicator";
import { SettingIcon } from "@/components/setting-icon";
import { Badge } from "@/components/ui/badge";
import { FieldDescription } from "@/components/ui/field-description";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAgentOptionsByIds } from "@/lib/agent-options.query";

type LoadBalancingMode = "disabled" | SubagentLoadBalancingAlgorithm;

const DEFAULT_LOAD_BALANCING_CONFIG: SubagentLoadBalancingConfig = {
  enabled: true,
  algorithm: "round_robin",
};

function getModeOptions(params: {
  noun: string;
  nouns: string;
}): ReadonlyArray<{
  value: LoadBalancingMode;
  label: string;
  description: string;
}> {
  const { noun, nouns } = params;
  return [
    {
      value: "disabled",
      label: "Direct",
      description: `Call each ${noun} directly.`,
    },
    {
      value: "round_robin",
      label: "Round robin",
      description: `Rotate through ${nouns} in turn.`,
    },
    {
      value: "weighted",
      label: "Weighted",
      description: "Split runs by custom weights.",
    },
    {
      value: "random",
      label: "Random",
      description: `Pick ${noun === "agent" ? "an agent" : "a subagent"} at random.`,
    },
  ];
}

export interface SubagentLoadBalancingSectionProps {
  value: SubagentLoadBalancingConfig | null;
  onChange: (value: SubagentLoadBalancingConfig | null) => void;
  selectedAgentIds: string[];
  canReadAgents?: boolean;
  readOnly?: boolean;
  isGateway?: boolean;
  isAllSubagentsMode?: boolean;
}

export function SubagentLoadBalancingSection({
  value,
  onChange,
  selectedAgentIds,
  canReadAgents = true,
  readOnly = false,
  isGateway = true,
  isAllSubagentsMode = false,
}: SubagentLoadBalancingSectionProps) {
  const modeSelectId = useId();

  // Only runs of Agent Runtime agents are balanced, retried, and failed over:
  // a delegation to any other agent always goes to that agent directly.
  const noun = isGateway ? "agent" : "subagent";
  const nouns = isGateway ? "agents" : "subagents";
  const runtimeNoun = isGateway
    ? "Agent Runtime agent"
    : "Agent Runtime subagent";
  const sectionDescription = isGateway
    ? "Split runs between agents with dedicated runtimes."
    : "Split runs between subagents with dedicated runtimes.";
  const modeOptions = getModeOptions({ noun, nouns });

  const isEnabled = value?.enabled === true;
  const currentConfig: SubagentLoadBalancingConfig = value ?? {
    ...DEFAULT_LOAD_BALANCING_CONFIG,
    enabled: false,
  };
  const selectedMode: LoadBalancingMode = isEnabled
    ? currentConfig.algorithm
    : "disabled";

  const { data: assignedAgents = [] } = useAgentOptionsByIds({
    ids: selectedAgentIds,
    enabled:
      canReadAgents && isEnabled && currentConfig.algorithm === "weighted",
  });
  const agentById = new Map(assignedAgents.map((agent) => [agent.id, agent]));

  const totalWeight = selectedAgentIds.reduce(
    (sum, id) => sum + (currentConfig.weights?.[id] ?? 1),
    0,
  );

  const updateConfig = (patch: Partial<SubagentLoadBalancingConfig>) => {
    onChange({
      ...DEFAULT_LOAD_BALANCING_CONFIG,
      ...value,
      ...patch,
    });
  };

  const handleModeChange = (mode: LoadBalancingMode) => {
    if (mode === "disabled") {
      if (!value) return;
      onChange({
        ...currentConfig,
        enabled: false,
      });
      return;
    }
    updateConfig({
      enabled: true,
      algorithm: mode,
    });
  };

  const handleWeightChange = (agentId: string, rawValue: string) => {
    const parsed = Number.parseInt(rawValue, 10);
    const nextWeights = { ...(currentConfig.weights ?? {}) };
    if (Number.isNaN(parsed)) {
      delete nextWeights[agentId];
    } else {
      const clamped = Math.max(
        SUBAGENT_LOAD_BALANCING_MIN_WEIGHT,
        Math.min(SUBAGENT_LOAD_BALANCING_MAX_WEIGHT, parsed),
      );
      nextWeights[agentId] = clamped;
    }
    updateConfig({
      weights: Object.keys(nextWeights).length > 0 ? nextWeights : undefined,
    });
  };

  return (
    <div className="space-y-3 border-t pt-4">
      <div className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-3 sm:flex sm:items-start">
        <SettingIcon tone={isEnabled ? "on" : "off"}>
          <Scale className="h-4 w-4" />
        </SettingIcon>
        <div className="min-w-0 flex-1 space-y-1">
          <Label htmlFor={modeSelectId}>
            <span>Agent Runtime Delegation</span>
          </Label>
          <FieldDescription>
            <span>{sectionDescription}</span>
          </FieldDescription>
        </div>
        <Select
          value={selectedMode}
          disabled={readOnly}
          onValueChange={(next) => handleModeChange(next as LoadBalancingMode)}
        >
          <SelectTrigger
            id={modeSelectId}
            aria-label="Agent Runtime Delegation"
            className="col-start-2 w-full sm:w-[240px]"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent
            position="popper"
            align="end"
            className="w-72 max-w-[calc(100vw-2rem)]"
          >
            {modeOptions.map((option) => (
              <SelectItem
                key={option.value}
                value={option.value}
                description={option.description}
              >
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {isEnabled && currentConfig.algorithm === "weighted" && (
        <div className="ml-11 space-y-2 rounded-md border bg-muted/20 p-3">
          <div className="space-y-0.5">
            <Label>
              <span>{isGateway ? "Agent weights" : "Subagent weights"}</span>
            </Label>
            <FieldDescription>
              <span>
                {`Set a weight from ${SUBAGENT_LOAD_BALANCING_MIN_WEIGHT} to ${SUBAGENT_LOAD_BALANCING_MAX_WEIGHT} for each ${runtimeNoun}. Higher weights get more runs.`}
              </span>
            </FieldDescription>
          </div>
          {selectedAgentIds.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              <span>
                {isAllSubagentsMode
                  ? `In "All agents" mode, every ${runtimeNoun} gets weight 1. Switch to Manual mode above to set custom weights.`
                  : `Assign ${nouns} above to set custom weights.`}
              </span>
            </p>
          ) : (
            <div className="space-y-2 pt-1">
              {selectedAgentIds.map((agentId) => {
                const weight = currentConfig.weights?.[agentId] ?? 1;
                const sharePercent =
                  totalWeight > 0
                    ? Math.round((weight / totalWeight) * 100)
                    : 0;
                const agent = agentById.get(agentId);
                const displayName = agent?.name ?? agentId.slice(0, 8);
                return (
                  <div
                    key={agentId}
                    className="flex items-center justify-between gap-3 rounded border bg-background px-3 py-1.5"
                  >
                    <div className="flex min-w-0 flex-1 items-center gap-2">
                      <span className="truncate text-xs font-medium">
                        {displayName}
                      </span>
                      {agent?.runtime ? (
                        <AgentRuntimeChip runtime={agent.runtime} />
                      ) : agent ? (
                        <Badge
                          variant="outline"
                          className="shrink-0 px-1.5 py-0 text-[10px] font-normal text-muted-foreground"
                        >
                          <span>No runtime</span>
                        </Badge>
                      ) : null}
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge
                        variant="secondary"
                        className="px-1.5 py-0 text-[10px] tabular-nums"
                      >
                        <span>{sharePercent}%</span>
                      </Badge>
                      <Input
                        type="number"
                        min={SUBAGENT_LOAD_BALANCING_MIN_WEIGHT}
                        max={SUBAGENT_LOAD_BALANCING_MAX_WEIGHT}
                        aria-label={`Weight for ${displayName}`}
                        value={weight}
                        disabled={readOnly}
                        onChange={(event) =>
                          handleWeightChange(agentId, event.target.value)
                        }
                        className="h-7 w-20 text-right text-xs tabular-nums"
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
