"use client";

import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useMcpServers } from "@/lib/mcp-server.query";
import { cn } from "@/lib/utils";

interface InstallationSelectProps {
  value?: string | null;
  onValueChange: (value: string | null) => void;
  disabled?: boolean;
  className?: string;
  /** Catalog ID to filter installations - only shows local installations for the same catalog item */
  catalogId: string;
}

/**
 * Self-contained component for selecting execution source (pod) for local MCP tool execution.
 * Shows all local MCP server installations for a given catalog item with owner emails.
 *
 * Unlike TokenSelect, this has no team restrictions - any installation of the same catalog
 * item can handle execution.
 */
export function InstallationSelect({
  value,
  onValueChange,
  disabled,
  className,
  catalogId,
}: InstallationSelectProps) {
  const { data: allServers, isLoading } = useMcpServers();

  // Filter to local servers with matching catalogId
  const installations = allServers?.filter(
    (server) => server.catalogId === catalogId && server.serverType === "local",
  );

  return (
    <Select
      value={value || undefined}
      onValueChange={onValueChange}
      disabled={disabled || isLoading}
    >
      <SelectTrigger
        className={cn(
          "h-fit! w-fit! bg-transparent! border-none! shadow-none! ring-0! outline-none! focus:ring-0! focus:outline-none! focus:border-none! p-0!",
          className,
        )}
        size="sm"
      >
        <SelectValue placeholder="Select installation..." />
      </SelectTrigger>
      <SelectContent>
        {installations && installations.length > 0 ? (
          <SelectGroup>
            <SelectLabel>Available installations</SelectLabel>
            {installations.map((server) => (
              <SelectItem
                key={server.id}
                value={server.id}
                className="cursor-pointer"
              >
                <span className="text-xs">
                  {server.ownerEmail || "Unknown owner"}
                </span>
              </SelectItem>
            ))}
          </SelectGroup>
        ) : (
          <div className="px-2 py-1.5 text-xs text-muted-foreground">
            No installations available
          </div>
        )}
      </SelectContent>
    </Select>
  );
}
