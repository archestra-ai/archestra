"use client";

import { Search } from "lucide-react";
import { useMemo, useState } from "react";
import type { AgentSelectorAgent } from "@/components/agent-selector";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils/tailwind";

/**
 * Gateways and agents as a checklist with search, the selection counted in
 * the header. Long lists stay usable: checked rows sort to the top.
 */
export function GatewayChecklist({
  gateways,
  value,
  onValueChange,
  label,
  idPrefix,
}: {
  gateways: AgentSelectorAgent[];
  value: string[];
  onValueChange: (value: string[]) => void;
  label: string;
  idPrefix: string;
}) {
  const [query, setQuery] = useState("");
  const [initialValue] = useState(value);
  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return gateways
      .filter(
        (gateway) => !needle || gateway.name.toLowerCase().includes(needle),
      )
      .sort(
        (a, b) =>
          Number(initialValue.includes(b.id)) -
            Number(initialValue.includes(a.id)) || a.name.localeCompare(b.name),
      );
  }, [gateways, initialValue, query]);
  const toggle = (id: string, checked: boolean) =>
    onValueChange(
      checked ? [...value, id] : value.filter((selected) => selected !== id),
    );

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="font-medium text-sm">{label}</span>
        <span className="text-xs text-muted-foreground">
          {value.length} of {gateways.length} selected
        </span>
      </div>
      <div className="overflow-hidden rounded-lg border">
        <div className="relative border-b">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            aria-label="Search gateways and agents"
            placeholder="Search gateways and agents"
            className="h-9 rounded-none border-0 pl-9 shadow-none focus-visible:ring-0"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <ul className="max-h-56 divide-y overflow-y-auto">
          {rows.map((gateway) => {
            const id = `${idPrefix}-${gateway.id}`;
            const checked = value.includes(gateway.id);
            return (
              <li key={gateway.id}>
                <Label
                  htmlFor={id}
                  className={cn(
                    "flex cursor-pointer items-center gap-3 px-3 py-2 font-normal",
                    checked && "bg-muted/50",
                  )}
                >
                  <Checkbox
                    id={id}
                    aria-label={gateway.name}
                    checked={checked}
                    onCheckedChange={(next) =>
                      toggle(gateway.id, next === true)
                    }
                  />
                  <span className="min-w-0 flex-1 truncate">
                    {gateway.name}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {gateway.agentType === "agent" ? "Agent" : "MCP gateway"}
                  </span>
                </Label>
              </li>
            );
          })}
          {rows.length === 0 && (
            <li className="px-3 py-4 text-center text-sm text-muted-foreground">
              No gateways or agents found
            </li>
          )}
        </ul>
      </div>
    </div>
  );
}
