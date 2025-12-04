"use client";

import { Check, Copy } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import { CodeText } from "@/components/code-text";
import { ProfileTokenManager } from "@/components/profile-token-manager";
import { Button } from "@/components/ui/button";
import config from "@/lib/config";
import { useProfileTokens } from "@/lib/profile-token.query";

const { displayProxyUrl: apiBaseUrl } = config.api;

interface McpConnectionInstructionsProps {
  agentId: string;
}

export function McpConnectionInstructions({
  agentId,
}: McpConnectionInstructionsProps) {
  const { data: tokens } = useProfileTokens(agentId);

  const [copiedUrl, setCopiedUrl] = useState(false);
  const [copiedAuth, setCopiedAuth] = useState(false);
  const [copiedConfig, setCopiedConfig] = useState(false);

  // Use the new URL format with profile ID
  const mcpUrl = `${apiBaseUrl}/mcp/${agentId}`;

  // Get the first token for the example configuration
  const firstToken = tokens?.[0];
  const tokenForDisplay = firstToken?.tokenStart
    ? `${firstToken.tokenStart}...`
    : "your-token-here";

  const mcpConfig = useMemo(
    () =>
      JSON.stringify(
        {
          mcpServers: {
            archestra: {
              url: mcpUrl,
              headers: {
                Authorization: `Bearer ${tokenForDisplay}`,
              },
            },
          },
        },
        null,
        2,
      ),
    [mcpUrl, tokenForDisplay],
  );

  const handleCopyUrl = useCallback(async () => {
    await navigator.clipboard.writeText(mcpUrl);
    setCopiedUrl(true);
    toast.success("URL copied to clipboard");
    setTimeout(() => setCopiedUrl(false), 2000);
  }, [mcpUrl]);

  const handleCopyAuth = useCallback(async () => {
    await navigator.clipboard.writeText(
      `Authorization: Bearer ${tokenForDisplay}`,
    );
    setCopiedAuth(true);
    toast.success("Authorization header copied to clipboard");
    setTimeout(() => setCopiedAuth(false), 2000);
  }, [tokenForDisplay]);

  const handleCopyConfig = useCallback(async () => {
    await navigator.clipboard.writeText(mcpConfig);
    setCopiedConfig(true);
    toast.success("Configuration copied to clipboard");
    setTimeout(() => setCopiedConfig(false), 2000);
  }, [mcpConfig]);

  return (
    <div className="space-y-6">
      <ProfileTokenManager profileId={agentId} />

      <div className="space-y-3">
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">MCP Gateway URL:</p>
          <div className="bg-muted rounded-md p-3 flex items-center justify-between">
            <CodeText className="text-sm break-all">{mcpUrl}</CodeText>
            <Button variant="ghost" size="icon" onClick={handleCopyUrl}>
              {copiedUrl ? (
                <Check className="h-4 w-4 text-green-500" />
              ) : (
                <Copy className="h-4 w-4" />
              )}
            </Button>
          </div>
        </div>

        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">Authorization Header:</p>
          <div className="bg-muted rounded-md p-3 flex items-center justify-between">
            <CodeText className="text-sm break-all">
              Authorization: Bearer {tokenForDisplay}
            </CodeText>
            <Button variant="ghost" size="icon" onClick={handleCopyAuth}>
              {copiedAuth ? (
                <Check className="h-4 w-4 text-green-500" />
              ) : (
                <Copy className="h-4 w-4" />
              )}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Create and manage tokens above, then use a token value here.
          </p>
        </div>

        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">
            Example configuration for MCP clients:
          </p>

          <div className="bg-muted rounded-md p-3 relative">
            <pre className="text-xs whitespace-pre-wrap break-all">
              <CodeText className="text-sm whitespace pre-wrap break-all">
                {mcpConfig}
              </CodeText>
            </pre>
            <Button
              variant="ghost"
              size="icon"
              className="absolute top-2 right-2"
              onClick={handleCopyConfig}
            >
              {copiedConfig ? (
                <Check className="h-4 w-4 text-green-500" />
              ) : (
                <Copy className="h-4 w-4" />
              )}
            </Button>
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
            to access tools assigned to this profile.
          </p>

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
            href="https://archestra.ai/docs/platform-deployment#environment-variables"
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-500"
          >
            here
          </a>{" "}
          for more details.
        </p>
      </div>
    </div>
  );
}
