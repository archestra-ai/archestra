"use client";

import { parseFullToolName } from "@archestra/shared";
import { FileText } from "lucide-react";
import { useMemo, useState } from "react";
import { McpLogsDialog } from "@/app/mcp/registry/_parts/mcp-logs-dialog";
import { Button } from "@/components/ui/button";
import { useMcpCatalogDirectory } from "@/lib/mcp/mcp-registry.query";
import {
  useMcpDeploymentStatuses,
  useMcpServers,
} from "@/lib/mcp/mcp-server.query";

interface ToolErrorLogsButtonProps {
  toolName: string;
}

/**
 * Button that opens the MCP server logs dialog for a failed tool call.
 * Only shows when the MCP server can be identified from the tool name.
 */
export function ToolErrorLogsButton({ toolName }: ToolErrorLogsButtonProps) {
  const [isLogsDialogOpen, setIsLogsDialogOpen] = useState(false);
  const { statuses: deploymentStatuses } = useMcpDeploymentStatuses();

  const mcpServerName = parseFullToolName(toolName).serverName;

  // The tool's server prefix is its catalog item's name: resolve the item from
  // the registry's directory, then load that item's installs only.
  const { data: catalogDirectory } = useMcpCatalogDirectory({
    enabled: !!mcpServerName,
  });
  const catalogId = catalogDirectory?.find(
    (item) => item.name === mcpServerName,
  )?.id;
  const { data: catalogServers } = useMcpServers({
    includeAssignedAgents: false,
    catalogId,
    enabled: !!catalogId,
  });

  const serverInstalls = useMemo(
    () =>
      (catalogServers ?? [])
        .filter((server) => server.serverType === "local")
        .map((server) => ({
          id: server.id,
          name: server.name,
          canUseCredential: server.canUseCredential,
        })),
    [catalogServers],
  );

  // Don't show button if no server found or no local installations
  if (!mcpServerName || serverInstalls.length === 0) {
    return null;
  }

  return (
    <>
      <Button
        variant="outline"
        size="xs"
        onClick={() => setIsLogsDialogOpen(true)}
      >
        <FileText className="h-3 w-3" />
        View Server Logs
      </Button>

      <McpLogsDialog
        open={isLogsDialogOpen}
        onOpenChange={setIsLogsDialogOpen}
        serverName={mcpServerName}
        installs={serverInstalls}
        deploymentStatuses={deploymentStatuses}
        hideInstallationSelector
      />
    </>
  );
}
