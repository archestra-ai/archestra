"use client";

import {
  SUBAGENT_LOAD_BALANCING_MAX_FALLBACKS,
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
  maxFallbacks: null,
};

const ALGORITHM_OPTIONS: ReadonlyArray<{
  value: SubagentLoadBalancingAlgorithm;
  label: string;
  description: string;
}> = [
  {
    value: "round_robin",
    label: "Round robin (rotate)",
    description:
      "Rotate incoming requests evenly across the subagents assigned to this gateway.",
  },
  {
    value: "weighted",
    label: "Weighted",
    description:
      "Distribute incoming requests across assigned subagents in proportion to their configured weights.",
  },
  {
    value: "random",
    label: "Random",
    description:
      "Select an assigned subagent uniformly at random for each incoming request.",
  },
  {
    value: "ordered",
    label: "Priority order",
    description:
      "Always route requests starting from the first assigned subagent, using the rest in order as fallbacks.",
  },
];

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
}

export function SubagentLoadBalancingSection({
  value,
  onChange,
  selectedAgentIds,
  canReadAgents = true,
  readOnly = false,
}: SubagentLoadBalancingSectionProps) {
  const enableSwitchId = useId();
  const algorithmSelectId = useId();
  const retriesSelectId = useId();
  const fallbackSwitchId = useId();
  const maxFallbacksInputId = useId();

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
    ALGORITHM_OPTIONS.find((opt) => opt.value === currentConfig.algorithm) ??
    ALGORITHM_OPTIONS[0];

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

  const handleMaxFallbacksChange = (rawValue: string) => {
    const trimmed = rawValue.trim();
    if (!trimmed) {
      updateConfig({ maxFallbacks: null });
      return;
    }
    const parsed = Number.parseInt(trimmed, 10);
    if (Number.isNaN(parsed)) return;
    const clamped = Math.max(
      0,
      Math.min(SUBAGENT_LOAD_BALANCING_MAX_FALLBACKS, parsed),
    );
    updateConfig({ maxFallbacks: clamped });
  };

  return (
    <div className="flex items-start gap-3 border-t pt-4">
      <SettingIcon tone={isEnabled ? "on" : "off"}>
        <Scale className="h-4 w-4" />
      </SettingIcon>
      <div className="min-w-0 flex-1 space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <Label htmlFor={enableSwitchId}>
              <span>Load balancing &amp; failover</span>
            </Label>
            <FieldDescription>
              <span>
                Control how incoming requests are distributed across the
                subagents assigned to this gateway, and how failed subagent
                requests are retried or routed to fallback subagents.
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
                  {ALGORITHM_OPTIONS.map((option) => (
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
                      Assign relative weights (
                      {SUBAGENT_LOAD_BALANCING_MIN_WEIGHT}–
                      {SUBAGENT_LOAD_BALANCING_MAX_WEIGHT}) to control each
                      subagent&apos;s share of incoming requests.
                    </span>
                  </FieldDescription>
                </div>
                {selectedAgentIds.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    <span>
                      Assign subagents above to configure individual weights.
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
                    How many times to retry a failed request on the same
                    subagent when the failure is retriable.
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
                      When a subagent fails after exhausting its retries,
                      automatically route the request to the next assigned
                      subagent.
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

              {currentConfig.fallbackEnabled && (
                <div className="space-y-1.5 pt-1">
                  <Label htmlFor={maxFallbacksInputId}>
                    <span>Maximum fallback subagents</span>
                  </Label>
                  <Input
                    id={maxFallbacksInputId}
                    type="number"
                    min={0}
                    max={SUBAGENT_LOAD_BALANCING_MAX_FALLBACKS}
                    placeholder="All remaining subagents"
                    value={
                      currentConfig.maxFallbacks != null
                        ? String(currentConfig.maxFallbacks)
                        : ""
                    }
                    disabled={readOnly}
                    onChange={(event) =>
                      handleMaxFallbacksChange(event.target.value)
                    }
                    className="max-w-xs text-xs"
                  />
                  <FieldDescription>
                    <span>
                      Leave empty to try all remaining assigned subagents before
                      reporting a failure.
                    </span>
                  </FieldDescription>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
