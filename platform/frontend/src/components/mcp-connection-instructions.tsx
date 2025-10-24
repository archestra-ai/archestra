"use client";

import { CodeText } from "@/components/code-text";
import CopyButton from "@/components/copy-button";
import config from "@/lib/config";

const { displayProxyUrl: apiBaseUrl } = config.api;

interface McpConnectionInstructionsProps {
  agentId?: string;
  darkMode?: boolean;
}

export function McpConnectionInstructions({
  agentId,
  darkMode,
}: McpConnectionInstructionsProps) {
  const mcpUrl = agentId
    ? `${apiBaseUrl}/mcp/${agentId}`
    : `${apiBaseUrl}/mcp/:agentId`;
  const bgCodeClass = darkMode ? "bg-slate-900 text-slate-200" : "bg-muted";
  const mcpConfig = JSON.stringify(
    {
      mcpServers: {
        archestra: {
          type: "streamable-http",
          url: mcpUrl,
        },
      },
    },
    null,
    2,
  );

  return (
    <div className="space-y-3">
      <div
        className={`rounded flex items-center justify-between ${bgCodeClass}`}
      >
        <CodeText className={` p-4 text-xs overflow-x-auto ${bgCodeClass}`}>
          {mcpUrl}
        </CodeText>
        <CopyButton text={mcpUrl} />
      </div>

      <div className="space-y-2">
        <p className="text-sm text-muted-foreground">
          Example configuration for MCP clients:
        </p>

        <div className="relative">
          <pre className={`rounded p-4 text-xs overflow-scroll ${bgCodeClass}`}>
            <code>{mcpConfig}</code>
          </pre>
          <CopyButton text={mcpConfig} className="absolute top-2 right-2" />
        </div>

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
