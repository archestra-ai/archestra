// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
"use client";

import { type ScopedResource, TEAM_RESOURCE_SCOPE } from "@archestra/shared";
import { Shield } from "lucide-react";
import { useState } from "react";
import { ResourcePermissionDialog } from "@/components/resource-permission-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/** Manage organization-bound wildcard grants without requiring an object first. */
export function ResourceTypeGrants() {
  const [selected, setSelected] = useState<{
    resource: ScopedResource;
    label: string;
    scope: string;
  } | null>(null);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm">
            <Shield className="size-4" />
            <span>Resource grants</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {resources.map((entry) => (
            <DropdownMenuSub key={entry.resource}>
              <DropdownMenuSubTrigger>{entry.label}</DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuItem
                  onSelect={() => setSelected({ ...entry, scope: "*" })}
                >
                  All resources
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() =>
                    setSelected({ ...entry, scope: TEAM_RESOURCE_SCOPE })
                  }
                >
                  Resources shared with recipients’ teams
                </DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {selected && (
        <ResourcePermissionDialog
          resource={selected.resource}
          scope={selected.scope}
          title={`Permissions for ${selected.label.toLowerCase()}`}
          open
          onOpenChange={(open) => {
            if (!open) setSelected(null);
          }}
        />
      )}
    </>
  );
}

const resources: { resource: ScopedResource; label: string }[] = [
  { resource: "agent", label: "Agents" },
  { resource: "skill", label: "Skills" },
  { resource: "app", label: "Apps" },
  { resource: "llmModel", label: "Models" },
  { resource: "mcpGateway", label: "MCP gateways" },
  { resource: "mcpRegistry", label: "MCP registry entries" },
];
