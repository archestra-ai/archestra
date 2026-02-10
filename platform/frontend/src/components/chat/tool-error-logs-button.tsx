"use client";

import { parseFullToolName } from "@shared";
import { FileText } from "lucide-react";
import { useMemo, useState } from "react";
import { McpLogsDialog } from "@/app/mcp-catalog/_parts/mcp-logs-dialog";
import { Button } from "@/components/ui/button";
import { useMcpServers } from "@/lib/mcp-server.query";

interface ToolErrorLogsButtonProps {
  toolName: string;
}

/**
 * Button that opens the MCP server logs dialog for a failed tool call.
 * Only shows when the MCP server can be identified from the tool name.
 */
export function ToolErrorLogsButton({ toolName }: ToolErrorLogsButtonProps) {
  const [isLogsDialogOpen, setIsLogsDialogOpen] = useState(false);
  const { data: allMcpServers } = useMcpServers();

  const mcpServerName = parseFullToolName(toolName).serverName;

  // Find all installations for this MCP server by catalog name
  const serverInstalls = useMemo(() => {
    if (!mcpServerName || !allMcpServers) return [];

    // Find servers where the catalog name matches the tool's server name prefix
    return allMcpServers
      .filter((server) => {
        // Match by catalogName (which is the server name used in tool naming)
        return (
          server.catalogName === mcpServerName && server.serverType === "local"
        );
      })
      .map((server) => ({
        id: server.id,
        name: server.name,
      }));
  }, [mcpServerName, allMcpServers]);

  // Don't show button if no server found or no local installations
  if (!mcpServerName || serverInstalls.length === 0) {
    return null;
  }

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        className="h-6 text-xs gap-1"
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
        hideInstallationSelector
      />
    </>
  );
}
