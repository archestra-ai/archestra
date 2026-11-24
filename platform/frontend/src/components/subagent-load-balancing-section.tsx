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
  targetLabel: string;
  runtimeAgents: string;
}): ReadonlyArray<{
  value: SubagentLoadBalancingAlgorithm;
  label: string;
  description: string;
}> {
  const { targetLabel, runtimeAgents } = params;
  return [
    {
      value: "round_robin",
      label: "Round robin (rotate)",
      description: `Give delegated runs to the ${runtimeAgents} assigned to ${targetLabel} in turn.`,
    },
    {
      value: "weighted",
      label: "Weighted",
      description: `Spread delegated runs across the assigned ${runtimeAgents} in proportion to their weights.`,
    },
    {
      value: "random",
      label: "Random",
      description: `Give each delegated run to one of the assigned ${runtimeAgents}, picked at random.`,
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

  const targetLabel = isGateway ? "this gateway" : "this agent";
  // Only runs of Agent Runtime agents are balanced, retried and failed over:
  // a delegation to any other agent always goes to that agent.
  const runtimeAgents = isGateway
    ? "Agent Runtime agents"
    : "Agent Runtime subagents";
  const algorithmOptions = getAlgorithmOptions({ targetLabel, runtimeAgents });

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
                <span>Load balancing &amp; failover</span>
              </Label>
              <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
                Beta
              </Badge>
            </div>
            <FieldDescription>
              <span>
                {`Distributes delegated runs across the ${runtimeAgents} assigned to ${targetLabel} only, with retries, out-of-memory tier upgrades, and failover.`}
              </span>
            </FieldDescription>
          </div>
          <Switch
            id={enableSwitchId}
            aria-label="Enable load balancing"
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
                    <span>Subagent weights</span>
                  </Label>
                  <FieldDescription>
                    <span>
                      {`Give each ${isGateway ? "Agent Runtime agent" : "Agent Runtime subagent"} a weight from ${SUBAGENT_LOAD_BALANCING_MIN_WEIGHT} to ${SUBAGENT_LOAD_BALANCING_MAX_WEIGHT}. A higher weight gets a larger share of delegated runs.`}
                    </span>
                  </FieldDescription>
                </div>
                {selectedAgentIds.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    <span>
                      {isAllSubagentsMode
                        ? 'In "All agents" mode, all accessible runtime subagents receive equal weight (1). Switch to Manual mode above to assign custom weights to specific subagents.'
                        : "Assign subagents above to configure individual weights."}
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
                  <span>Retries on same subagent</span>
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
                    {`How many times a failed run is retried on the same ${isGateway ? "Agent Runtime agent" : "Agent Runtime subagent"}, when the failure allows a retry.`}
                  </span>
                </FieldDescription>
              </div>

              <div className="flex items-start justify-between gap-4 pt-1">
                <div className="space-y-1">
                  <Label htmlFor={fallbackSwitchId}>
                    <span>Fall back to other subagents</span>
                  </Label>
                  <FieldDescription>
                    <span>
                      {`When a run still fails after its retries, it goes to the other assigned ${runtimeAgents}, one after another, until one succeeds.`}
                    </span>
                  </FieldDescription>
                </div>
                <Switch
                  id={fallbackSwitchId}
                  aria-label="Fall back to other subagents"
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
