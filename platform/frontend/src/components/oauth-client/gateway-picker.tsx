"use client";

import {
  AgentSelector,
  type AgentSelectorAgent,
} from "@/components/agent-selector";

/** Shares grouping, search and personal-owner labels with other resource pickers. */
export function GatewayPicker({
  gateways,
  value,
  onValueChange,
  label,
}: {
  gateways: AgentSelectorAgent[];
  value: string[];
  onValueChange: (value: string[]) => void;
  label: string;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium text-sm">{label}</span>
        <span className="text-xs text-muted-foreground">
          {value.length} of {gateways.length} selected
        </span>
      </div>
      <p className="text-xs text-muted-foreground">
        Choose which agents and MCP gateways this application can access.
      </p>
      <AgentSelector
        mode="multiple"
        agents={gateways}
        value={value}
        onValueChange={onValueChange}
        placeholder="Select agents and MCP gateways"
        searchPlaceholder="Search agents and MCP gateways"
        className="w-full"
      />
    </div>
  );
}
