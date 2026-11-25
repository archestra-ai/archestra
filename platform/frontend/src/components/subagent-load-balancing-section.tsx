"use client";

import {
  SUBAGENT_LOAD_BALANCING_MAX_RETRIES,
  SUBAGENT_LOAD_BALANCING_MAX_WEIGHT,
  SUBAGENT_LOAD_BALANCING_MIN_WEIGHT,
  type SubagentLoadBalancingAlgorithm,
  type SubagentLoadBalancingConfig,
} from "@archestra/shared";
import { Scale } from "lucide-react";
import { useId } from "react";
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
import { Switch } from "@/components/ui/switch";
import { useAgentOptionsByIds } from "@/lib/agent-options.query";

const DEFAULT_LOAD_BALANCING_CONFIG: SubagentLoadBalancingConfig = {
  enabled: true,
  algorithm: "round_robin",
  retries: 1,
  fallbackEnabled: true,
};

function getAlgorithmOptions(params: {
  runtimeNoun: string;
  runtimeNouns: string;
}): ReadonlyArray<{
  value: SubagentLoadBalancingAlgorithm;
  label: string;
  description: string;
}> {
  const { runtimeNoun, runtimeNouns } = params;
  return [
    {
      value: "round_robin",
      label: "Round robin (rotate)",
      description: `Send each run to the next ${runtimeNoun} in turn.`,
    },
    {
      value: "weighted",
      label: "Weighted",
      description: `Split runs across ${runtimeNouns} based on their weights.`,
    },
    {
      value: "random",
      label: "Random",
      description: `Pick a random ${runtimeNoun} for each run.`,
    },
  ];
}

const RETRY_OPTIONS = Array.from(
  { length: SUBAGENT_LOAD_BALANCING_MAX_RETRIES + 1 },
  (_, count) => ({
    value: String(count),
    label:
      count === 0
        ? "No retries (0)"
        : count === 1
          ? "1 retry"
          : `${count} retries`,
  }),
);

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
  const enableSwitchId = useId();
  const algorithmSelectId = useId();
  const retriesSelectId = useId();
  const fallbackSwitchId = useId();

  // Only runs of Agent Runtime agents are balanced, retried, and failed over:
  // a delegation to any other agent always goes to that agent directly.
  const noun = isGateway ? "agent" : "subagent";
  const nouns = isGateway ? "agents" : "subagents";
  const runtimeNoun = isGateway
    ? "Agent Runtime agent"
    : "Agent Runtime subagent";
  const runtimeNouns = isGateway
    ? "Agent Runtime agents"
    : "Agent Runtime subagents";
  const sectionDescription = isGateway
    ? "When clients run Agent Runtime agents through this gateway, choose how to split runs and handle failures. Other agents run directly."
    : "When this agent delegates to Agent Runtime subagents, choose how to split runs and handle failures. Other subagents run directly.";
  const failoverLabel = `Fail over to other ${nouns}`;
  const algorithmOptions = getAlgorithmOptions({ runtimeNoun, runtimeNouns });

  const isEnabled = value?.enabled === true;
  const currentConfig: SubagentLoadBalancingConfig = value ?? {
    ...DEFAULT_LOAD_BALANCING_CONFIG,
    enabled: false,
  };

  const { data: assignedAgents = [] } = useAgentOptionsByIds({
    ids: selectedAgentIds,
    enabled:
      canReadAgents && isEnabled && currentConfig.algorithm === "weighted",
  });
  const agentNameById = new Map(
    assignedAgents.map((agent) => [agent.id, agent.name]),
  );

  const selectedAlgorithm =
    algorithmOptions.find((opt) => opt.value === currentConfig.algorithm) ??
    algorithmOptions[0];

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

  const handleToggleEnabled = (checked: boolean) => {
    if (!checked) {
      if (!value) return;
      onChange({
        ...currentConfig,
        enabled: false,
      });
      return;
    }
    updateConfig({ enabled: true });
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
    <div className="flex items-start gap-3 border-t pt-4">
      <SettingIcon tone={isEnabled ? "on" : "off"}>
        <Scale className="h-4 w-4" />
      </SettingIcon>
      <div className="min-w-0 flex-1 space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <Label htmlFor={enableSwitchId}>
                <span>Agent Runtime load balancing &amp; failover</span>
              </Label>
              <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
                Beta
              </Badge>
            </div>
            <FieldDescription>
              <span>{sectionDescription}</span>
            </FieldDescription>
          </div>
          <Switch
            id={enableSwitchId}
            aria-label="Enable Agent Runtime load balancing & failover"
            checked={isEnabled}
            disabled={readOnly}
            onCheckedChange={handleToggleEnabled}
          />
        </div>

        {isEnabled && (
          <div className="space-y-4 rounded-md border bg-muted/20 p-3">
            <div className="space-y-1.5">
              <Label htmlFor={algorithmSelectId}>
                <span>Load balancing algorithm</span>
              </Label>
              <Select
                value={currentConfig.algorithm}
                disabled={readOnly}
                onValueChange={(algorithm: SubagentLoadBalancingAlgorithm) =>
                  updateConfig({ algorithm })
                }
              >
                <SelectTrigger id={algorithmSelectId} className="max-w-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {algorithmOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      <span>{option.label}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldDescription>
                <span>{selectedAlgorithm.description}</span>
              </FieldDescription>
            </div>

            {currentConfig.algorithm === "weighted" && (
              <div className="space-y-2 border-t pt-3">
                <div className="space-y-0.5">
                  <Label>
                    <span>
                      {isGateway ? "Agent weights" : "Subagent weights"}
                    </span>
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
                      const displayName =
                        agentNameById.get(agentId) ?? agentId.slice(0, 8);
                      return (
                        <div
                          key={agentId}
                          className="flex items-center justify-between gap-3 rounded border bg-background px-3 py-1.5"
                        >
                          <div className="min-w-0 flex-1">
                            <span className="truncate text-xs font-medium">
                              {displayName}
                            </span>
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

            <div className="space-y-3 border-t pt-3">
              <div className="space-y-1.5">
                <Label htmlFor={retriesSelectId}>
                  <span>{`Retries on same ${noun}`}</span>
                </Label>
                <Select
                  value={String(currentConfig.retries)}
                  disabled={readOnly}
                  onValueChange={(retries) =>
                    updateConfig({ retries: Number.parseInt(retries, 10) })
                  }
                >
                  <SelectTrigger id={retriesSelectId} className="max-w-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {RETRY_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        <span>{option.label}</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FieldDescription>
                  <span>
                    {`Retry a failed run on the same ${runtimeNoun} this many times after a temporary failure.`}
                  </span>
                </FieldDescription>
              </div>

              <div className="flex items-start justify-between gap-4 pt-1">
                <div className="space-y-1">
                  <Label htmlFor={fallbackSwitchId}>
                    <span>{failoverLabel}</span>
                  </Label>
                  <FieldDescription>
                    <span>
                      {`When a run fails after retries, try the other ${runtimeNouns} one by one until one succeeds.`}
                    </span>
                  </FieldDescription>
                </div>
                <Switch
                  id={fallbackSwitchId}
                  aria-label={failoverLabel}
                  checked={currentConfig.fallbackEnabled}
                  disabled={readOnly}
                  onCheckedChange={(fallbackEnabled) =>
                    updateConfig({ fallbackEnabled })
                  }
                />
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
