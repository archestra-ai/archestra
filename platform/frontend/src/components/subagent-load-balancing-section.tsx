"use client";

import type {
  SubagentLoadBalancingAlgorithm,
  SubagentLoadBalancingConfig,
} from "@archestra/shared";
import { Split } from "lucide-react";
import { useId } from "react";
import { SettingIcon } from "@/components/setting-icon";
import { FieldDescription } from "@/components/ui/field-description";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type LoadBalancingMode = "disabled" | SubagentLoadBalancingAlgorithm;

const DEFAULT_LOAD_BALANCING_CONFIG: SubagentLoadBalancingConfig = {
  enabled: true,
  algorithm: "round_robin",
};

function getModeOptions(params: {
  noun: string;
  nouns: string;
  isAllSubagentsMode: boolean;
}): ReadonlyArray<{
  value: LoadBalancingMode;
  label: string;
  description: string;
  disabled?: boolean;
}> {
  const { noun, nouns, isAllSubagentsMode } = params;
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
      label: "Weighted round robin",
      description: isAllSubagentsMode
        ? "Requires Manual mode."
        : "Split runs by custom weights.",
      disabled: isAllSubagentsMode,
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
  readOnly?: boolean;
  isGateway?: boolean;
  isAllSubagentsMode?: boolean;
}

export function SubagentLoadBalancingSection({
  value,
  onChange,
  selectedAgentIds,
  readOnly = false,
  isGateway = true,
  isAllSubagentsMode = false,
}: SubagentLoadBalancingSectionProps) {
  const modeSelectId = useId();

  // Only runs of Agent Runtime agents are balanced, retried, and failed over:
  // a delegation to any other agent always goes to that agent directly.
  const noun = isGateway ? "agent" : "subagent";
  const nouns = isGateway ? "agents" : "subagents";
  const sectionDescription = isGateway
    ? "Load balance Agent Runtime agent runs or call directly."
    : "Load balance Agent Runtime subagent runs or call directly.";
  const modeOptions = getModeOptions({ noun, nouns, isAllSubagentsMode });

  const isEnabled = value?.enabled === true;
  const currentConfig: SubagentLoadBalancingConfig = value ?? {
    ...DEFAULT_LOAD_BALANCING_CONFIG,
    enabled: false,
  };
  const selectedMode: LoadBalancingMode = !isEnabled
    ? "disabled"
    : isAllSubagentsMode && currentConfig.algorithm === "weighted"
      ? "round_robin"
      : currentConfig.algorithm;

  const handleModeChange = (mode: LoadBalancingMode) => {
    if (mode === "weighted" && isAllSubagentsMode) {
      return;
    }
    if (mode === "disabled") {
      if (!value) return;
      onChange({
        ...currentConfig,
        enabled: false,
      });
      return;
    }
    onChange({
      ...DEFAULT_LOAD_BALANCING_CONFIG,
      ...value,
      enabled: true,
      algorithm: mode,
    });
  };

  // In Manual mode with assigned agents, weights are edited in the Assigned
  // table above; only show a hint when nothing is assigned yet.
  const weightedNotice =
    !isAllSubagentsMode &&
    isEnabled &&
    currentConfig.algorithm === "weighted" &&
    selectedAgentIds.length === 0
      ? `Assign ${nouns} above to set custom weights.`
      : null;

  return (
    <div className="space-y-2 border-t pt-4">
      <div className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-3 sm:flex sm:items-start">
        <SettingIcon tone={isEnabled ? "on" : "off"}>
          <Split className="h-4 w-4" />
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
                disabled={option.disabled}
                description={option.description}
              >
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {weightedNotice && (
        <FieldDescription className="ml-11">
          <span>{weightedNotice}</span>
        </FieldDescription>
      )}
    </div>
  );
}
