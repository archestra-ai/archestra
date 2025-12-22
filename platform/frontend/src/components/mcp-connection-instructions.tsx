"use client";

import { archestraApiSdk } from "@shared";
import { Check, Copy, Loader2 } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import { CodeText } from "@/components/code-text";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useHasPermissions } from "@/lib/auth.query";
import config from "@/lib/config";
import { useTokens } from "@/lib/team-token.query";
import { useUserToken } from "@/lib/user-token.query";

const { displayProxyUrl: apiBaseUrl } = config.api;

interface McpConnectionInstructionsProps {
  agentId: string;
}

// Special ID for personal token in the dropdown
const PERSONAL_TOKEN_ID = "__personal_token__";

export function McpConnectionInstructions({
  agentId,
}: McpConnectionInstructionsProps) {
  const { data: tokensData } = useTokens();
  const { data: userToken } = useUserToken();
  const { data: hasProfileAdminPermission } = useHasPermissions({
    profile: ["admin"],
  });

  const tokens = tokensData?.tokens;
  const permissions = tokensData?.permissions;

  const [copiedUrl, setCopiedUrl] = useState(false);
  const [copiedAuth, setCopiedAuth] = useState(false);
  const [copiedConfig, setCopiedConfig] = useState(false);
  const [isCopyingConfig, setIsCopyingConfig] = useState(false);
  const [selectedTokenId, setSelectedTokenId] = useState<string | null>(null);

  // Use the new URL format with profile ID
  const mcpUrl = `${apiBaseUrl}/mcp/${agentId}`;

  // Default to personal token if available, otherwise org token, then first token
  const orgToken = tokens?.find((t) => t.isOrganizationToken);
  const defaultTokenId = userToken
    ? PERSONAL_TOKEN_ID
    : (orgToken?.id ?? tokens?.[0]?.id ?? "");

  // Check if personal token is selected (either explicitly or by default)
  const effectiveTokenId = selectedTokenId ?? defaultTokenId;
  const isPersonalTokenSelected = effectiveTokenId === PERSONAL_TOKEN_ID;

  // Get the selected team token (for non-personal tokens)
  const selectedTeamToken = isPersonalTokenSelected
    ? null
    : tokens?.find((t) => t.id === effectiveTokenId);

  // Determine display token based on selection
  const tokenForDisplay = isPersonalTokenSelected
    ? userToken
      ? `${userToken.tokenStart}...`
      : "ask-admin-for-access-token"
    : hasProfileAdminPermission && selectedTeamToken
      ? `${selectedTeamToken.tokenStart}...`
      : "ask-admin-for-access-token";

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

  const handleCopyAuthWithoutRealToken = async () => {
    await navigator.clipboard.writeText(
      `Authorization: Bearer ${tokenForDisplay}`,
    );
    setCopiedAuth(true);
    toast.success("Authorization header copied (preview only)");
    setTimeout(() => setCopiedAuth(false), 2000);
  };

  const handleCopyAuth = useCallback(async () => {
    try {
      let tokenValue: string;

      if (isPersonalTokenSelected) {
        // Fetch personal token value
        const response = await archestraApiSdk.getUserTokenValue();
        if (response.error || !response.data) {
          throw new Error("Failed to fetch personal token value");
        }
        tokenValue = (response.data as { value: string }).value;
      } else {
        // Fetch team token value
        if (!selectedTeamToken) {
          return;
        }
        const response = await archestraApiSdk.getTokenValue({
          path: { tokenId: selectedTeamToken.id },
        });
        if (response.error || !response.data) {
          throw new Error("Failed to fetch token value");
        }
        tokenValue = (response.data as { value: string }).value;
      }

      await navigator.clipboard.writeText(
        `Authorization: Bearer ${tokenValue}`,
      );
      setCopiedAuth(true);
      toast.success("Authorization header copied");
      setTimeout(() => setCopiedAuth(false), 2000);
    } catch {
      toast.error("Failed to copy authorization header");
    }
  }, [isPersonalTokenSelected, selectedTeamToken]);

  const handleCopyConfigWithoutRealToken = async () => {
    const fullConfig = JSON.stringify(
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
    );

    await navigator.clipboard.writeText(fullConfig);
    setCopiedConfig(true);
    toast.success("Configuration copied (preview only)");
    setTimeout(() => setCopiedConfig(false), 2000);
  };

  const handleCopyConfig = useCallback(async () => {
    setIsCopyingConfig(true);
    try {
      let tokenValue: string;

      if (isPersonalTokenSelected) {
        // Fetch personal token value
        const response = await archestraApiSdk.getUserTokenValue();
        if (response.error || !response.data) {
          throw new Error("Failed to fetch personal token value");
        }
        tokenValue = (response.data as { value: string }).value;
      } else {
        // Fetch team token value
        if (!selectedTeamToken) {
          setIsCopyingConfig(false);
          return;
        }
        const response = await archestraApiSdk.getTokenValue({
          path: { tokenId: selectedTeamToken.id },
        });
        if (response.error || !response.data) {
          throw new Error("Failed to fetch token value");
        }
        tokenValue = (response.data as { value: string }).value;
      }

      const fullConfig = JSON.stringify(
        {
          mcpServers: {
            archestra: {
              url: mcpUrl,
              headers: {
                Authorization: `Bearer ${tokenValue}`,
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
  }, [mcpUrl, isPersonalTokenSelected, selectedTeamToken]);

  return (
    <div className="space-y-6">
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
              Which token to connect with:
            </p>
            <Select value={effectiveTokenId} onValueChange={setSelectedTokenId}>
              <SelectTrigger className="w-[240px] h-8">
                <SelectValue placeholder="Select token" />
              </SelectTrigger>
              <SelectContent>
                {/* Personal Token - always available if user has one */}
                {userToken && (
                  <SelectItem value={PERSONAL_TOKEN_ID}>
                    Personal Token
                  </SelectItem>
                )}

                {/* Available tokens */}
                {tokens?.map((token) => (
                  <SelectItem key={token.id} value={token.id}>
                    {token.isOrganizationToken
                      ? "Organization Token"
                      : token.team?.name
                        ? `${token.team.name} Token`
                        : token.name}
                  </SelectItem>
                ))}

                {/* Disabled options for tokens user doesn't have access to */}
                {permissions && !permissions.canAccessOrgToken && (
                  <SelectGroup>
                    <SelectLabel className="text-xs text-muted-foreground font-normal px-2 py-1.5">
                      Organization Token — Requires Admin role
                    </SelectLabel>
                  </SelectGroup>
                )}
                {permissions && !permissions.canAccessTeamTokens && (
                  <SelectGroup>
                    <SelectLabel className="text-xs text-muted-foreground font-normal px-2 py-1.5">
                      Team Tokens — Requires team:update permission
                    </SelectLabel>
                  </SelectGroup>
                )}
              </SelectContent>
            </Select>
          </div>
          <div className="bg-muted rounded-md p-3 flex items-center justify-between">
            <CodeText className="text-sm break-all">
              Authorization: Bearer {tokenForDisplay}
            </CodeText>
            <Button
              variant="ghost"
              size="icon"
              onClick={
                isPersonalTokenSelected || hasProfileAdminPermission
                  ? handleCopyAuth
                  : handleCopyAuthWithoutRealToken
              }
            >
              {copiedAuth ? (
                <Check className="h-4 w-4 text-green-500" />
              ) : (
                <Copy className="h-4 w-4" />
              )}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            {isPersonalTokenSelected
              ? "Your personal token to authenticate with the MCP Gateway for profiles you have access to through your team memberships."
              : "Select a token above, then click Copy to get the full token value. Manage tokens in Settings → Teams."}
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
              onClick={
                isPersonalTokenSelected || hasProfileAdminPermission
                  ? handleCopyConfig
                  : handleCopyConfigWithoutRealToken
              }
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
