"use client";

import { Check, Copy } from "lucide-react";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import { CodeText } from "@/components/code-text";
import { Button } from "@/components/ui/button";
import config from "@/lib/config";

const { displayProxyUrl: apiBaseUrl } = config.api;

interface McpConnectionInstructionsProps {
  agentId?: string;
}

export function McpConnectionInstructions({
  agentId,
}: McpConnectionInstructionsProps) {
  const [copied, setCopied] = useState(false);

  const mcpUrl = agentId
    ? `${apiBaseUrl}/mcp/${agentId}`
    : `${apiBaseUrl}/mcp/:agentId`;

  const handleCopy = useCallback(async () => {
    await navigator.clipboard.writeText(mcpUrl);
    setCopied(true);
    toast.success("MCP URL copied to clipboard");
    setTimeout(() => setCopied(false), 2000);
  }, [mcpUrl]);

  return (
    <div className="space-y-3">
      <div className="bg-muted rounded-md p-3 flex items-center justify-between">
        <CodeText className="text-sm">{mcpUrl}</CodeText>
        <Button variant="ghost" size="icon" onClick={handleCopy}>
          {copied ? (
            <Check className="h-4 w-4 text-green-500" />
          ) : (
            <Copy className="h-4 w-4" />
          )}
        </Button>
      </div>

      <div className="space-y-2">
        <p className="text-sm text-muted-foreground">
          Connect using the{" "}
          <a
            href="https://modelcontextprotocol.io/"
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-500"
          >
            Model Context Protocol (MCP)
          </a>{" "}
          to access tools assigned to this agent.
        </p>

        <p className="text-sm text-muted-foreground">
          The MCP server supports:
        </p>

        <ul className="text-sm text-muted-foreground list-disc list-inside space-y-1 ml-2">
          <li>
            <CodeText className="text-xs">initialize</CodeText> - Protocol
            handshake
          </li>
          <li>
            <CodeText className="text-xs">tools/list</CodeText> - List available
            tools
          </li>
          <li>
            <CodeText className="text-xs">tools/call</CodeText> - Execute tools
          </li>
        </ul>

        <p className="text-sm text-muted-foreground">
          Use this endpoint in MCP-compatible applications like{" "}
          <a
            href="https://docs.cursor.com/"
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-500"
          >
            Cursor
          </a>
          ,{" "}
          <a
            href="https://claude.ai/"
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-500"
          >
            Claude Desktop
          </a>
          , or any MCP client.
        </p>
      </div>

      <p className="text-sm text-muted-foreground">
        The host/port is configurable via the{" "}
        <CodeText className="text-xs">ARCHESTRA_API_BASE_URL</CodeText>{" "}
        environment variable. See{" "}
        <a
          href="https://www.archestra.ai/docs/platform-deployment#environment-variables"
          target="_blank"
          rel="noopener noreferrer"
          className="text-blue-500"
        >
          here
        </a>{" "}
        for more details.
      </p>
    </div>
  );
}
