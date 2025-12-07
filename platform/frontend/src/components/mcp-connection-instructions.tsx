"use client";

import { archestraApiSdk } from "@shared";
import { Check, Copy, Loader2 } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import { CodeText } from "@/components/code-text";
import { ProfileTokenManager } from "@/components/profile-token-manager";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
  const [isCopyingConfig, setIsCopyingConfig] = useState(false);
  const [selectedTokenId, setSelectedTokenId] = useState<string | null>(null);

  // Use the new URL format with profile ID
  const mcpUrl = `${apiBaseUrl}/mcp/${agentId}`;

  // Find org token as default, fallback to first token
  const orgToken = tokens?.find((t) => t.isOrganizationToken);
  const defaultToken = orgToken ?? tokens?.[0];

  // Get the selected token or default to org token
  const selectedToken = selectedTokenId
    ? tokens?.find((t) => t.id === selectedTokenId)
    : defaultToken;

  const tokenForDisplay = selectedToken?.tokenStart
    ? `${selectedToken.tokenStart}...`
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
    if (!selectedToken) {
      toast.error("No token selected");
      return;
    }

    try {
      // Fetch the full token value from backend
      const response = await archestraApiSdk.getProfileTokenValue({
        path: { profileId: agentId, tokenId: selectedToken.id },
      });

      if (response.error || !response.data) {
        throw new Error("Failed to fetch token value");
      }

      await navigator.clipboard.writeText(
        `Authorization: Bearer ${response.data.value}`,
      );
      setCopiedAuth(true);
      toast.success("Authorization header copied");
      setTimeout(() => setCopiedAuth(false), 2000);
    } catch {
      toast.error("Failed to copy authorization header");
    }
  }, [agentId, selectedToken]);

  const handleCopyConfig = useCallback(async () => {
    if (!selectedToken) {
      toast.error("No token selected");
      return;
    }

    setIsCopyingConfig(true);
    try {
      // Fetch the full token value from backend
      const response = await archestraApiSdk.getProfileTokenValue({
        path: { profileId: agentId, tokenId: selectedToken.id },
      });

      if (response.error || !response.data) {
        throw new Error("Failed to fetch token value");
      }

      const fullConfig = JSON.stringify(
        {
          mcpServers: {
            archestra: {
              url: mcpUrl,
              headers: {
                Authorization: `Bearer ${response.data.value}`,
              },
            },
          },
        },
        null,
        2,
      );

      await navigator.clipboard.writeText(fullConfig);
      setCopiedConfig(true);
      toast.success("Configuration copied");
      setTimeout(() => setCopiedConfig(false), 2000);
    } catch {
      toast.error("Failed to copy configuration");
    } finally {
      setIsCopyingConfig(false);
    }
  }, [agentId, mcpUrl, selectedToken]);

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
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">
              Authorization Header:
            </p>
            {tokens && tokens.length > 0 && (
              <Select
                value={selectedTokenId ?? defaultToken?.id ?? ""}
                onValueChange={setSelectedTokenId}
              >
                <SelectTrigger className="w-[200px] h-8">
                  <SelectValue placeholder="Select token" />
                </SelectTrigger>
                <SelectContent>
                  {tokens.map((token) => (
                    <SelectItem key={token.id} value={token.id}>
                      {token.isOrganizationToken
                        ? "Organization Token"
                        : token.team?.name
                          ? `${token.team.name} Token`
                          : token.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
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
            Select a token above, then click Copy to get the full token value.
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
              disabled={isCopyingConfig}
            >
              {isCopyingConfig ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : copiedConfig ? (
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
