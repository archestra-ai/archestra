"use client";

import { archestraApiSdk } from "@shared";
import {
  Check,
  Copy,
  Eye,
  EyeOff,
  Layers,
  Loader2,
  Package,
  Server,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { CodeText } from "@/components/code-text";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useProfiles } from "@/lib/agent.query";
import { useHasPermissions } from "@/lib/auth.query";
import config from "@/lib/config";
import { useMcpServers } from "@/lib/mcp-server.query";
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
  const { data: profiles } = useProfiles();
  const { data: mcpServers } = useMcpServers();
  const { data: userToken } = useUserToken();
  const { data: hasProfileAdminPermission } = useHasPermissions({
    profile: ["admin"],
  });

  const [copiedConfig, setCopiedConfig] = useState(false);
  const [isCopyingConfig, setIsCopyingConfig] = useState(false);
  const [selectedTokenId, setSelectedTokenId] = useState<string | null>(null);
  const [selectedProfileId, setSelectedProfileId] = useState<string>(agentId);

  // Fetch tokens filtered by the selected profile's teams
  const { data: tokensData } = useTokens({ profileId: selectedProfileId });
  const tokens = tokensData?.tokens;
  const [showExposedToken, setShowExposedToken] = useState(false);
  const [exposedTokenValue, setExposedTokenValue] = useState<string | null>(
    null,
  );
  const [isLoadingToken, setIsLoadingToken] = useState(false);

  // Update selected profile when agentId changes
  useEffect(() => {
    setSelectedProfileId(agentId);
  }, [agentId]);

  // Get the selected profile
  const selectedProfile = profiles?.find((p) => p.id === selectedProfileId);

  // Group tools by MCP server for the selected profile
  const mcpServerToolCounts = useMemo(() => {
    if (!selectedProfile || !mcpServers) return new Map();

    const counts = new Map<
      string,
      { server: (typeof mcpServers)[0]; toolCount: number }
    >();

    selectedProfile.tools.forEach((tool) => {
      if (tool.mcpServerId) {
        const server = mcpServers.find((s) => s.id === tool.mcpServerId);
        if (server) {
          const existing = counts.get(tool.mcpServerId);
          if (existing) {
            existing.toolCount++;
          } else {
            counts.set(tool.mcpServerId, { server, toolCount: 1 });
          }
        }
      }
    });

    return counts;
  }, [selectedProfile, mcpServers]);

  const getToolsCountForProfile = useCallback(
    (profile: (typeof profiles)[number]) => {
      return profile.tools.reduce((acc, curr) => {
        if (curr.mcpServerId) {
          const server = mcpServers?.find((s) => s.id === curr.mcpServerId);
          if (server) {
            acc++;
          }
        }
        return acc;
      }, 0);
    },
    [mcpServers],
  );

  // Use the new URL format with selected profile ID
  const mcpUrl = `${apiBaseUrl}/mcp/${selectedProfileId}`;

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

  // Get display name for selected token
  const getTokenDisplayName = () => {
    if (isPersonalTokenSelected) {
      return "Personal Token";
    }
    if (selectedTeamToken) {
      if (selectedTeamToken.isOrganizationToken) {
        return "Organization Token";
      }
      if (selectedTeamToken.team?.name) {
        return `Team Token (${selectedTeamToken.team.name})`;
      }
      return selectedTeamToken.name;
    }
    return "Select token";
  };

  // Determine display token based on selection
  const tokenForDisplay =
    showExposedToken && exposedTokenValue
      ? exposedTokenValue
      : isPersonalTokenSelected
        ? userToken
          ? `${userToken.tokenStart}***`
          : "ask-admin-for-access-token"
        : hasProfileAdminPermission && selectedTeamToken
          ? `${selectedTeamToken.tokenStart}***`
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

  const handleExposeToken = useCallback(async () => {
    if (showExposedToken) {
      // Hide token
      setShowExposedToken(false);
      setExposedTokenValue(null);
      return;
    }

    setIsLoadingToken(true);
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
          setIsLoadingToken(false);
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

      setExposedTokenValue(tokenValue);
      setShowExposedToken(true);
    } catch (error) {
      toast.error("Failed to fetch token");
      console.error(error);
    } finally {
      setIsLoadingToken(false);
    }
  }, [isPersonalTokenSelected, selectedTeamToken, showExposedToken]);

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
      {/* Profile Selector */}
      <div className="space-y-2">
        <Label className="text-sm font-medium">Select Profile</Label>
        <Select value={selectedProfileId} onValueChange={setSelectedProfileId}>
          <SelectTrigger className="w-full">
            <SelectValue placeholder="Select a profile">
              {selectedProfile && (
                <div className="flex items-center gap-2">
                  <Layers className="h-4 w-4" />
                  <span>{selectedProfile.name}</span>
                  <span className="text-muted-foreground ml-auto">
                    {getToolsCountForProfile(selectedProfile)} tools
                  </span>
                </div>
              )}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {profiles?.map((profile) => (
              <SelectItem key={profile.id} value={profile.id}>
                <div className="flex items-center justify-between w-full">
                  <div className="flex items-center gap-2">
                    <Layers className="h-4 w-4" />
                    <span>{profile.name}</span>
                  </div>
                  <span className="text-sm text-muted-foreground ml-4">
                    {getToolsCountForProfile(profile)} tools
                  </span>
                </div>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* MCP Server Tiles */}
      {selectedProfile && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <Label className="text-sm font-medium">
              MCP servers assigned to this profile and accessible via gateway
            </Label>
            <span className="text-xs text-muted-foreground">
              {mcpServerToolCounts.size}{" "}
              {mcpServerToolCounts.size === 1 ? "server" : "servers"}
            </span>
          </div>

          {mcpServerToolCounts.size > 0 ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-2">
              {Array.from(mcpServerToolCounts.entries()).map(
                ([serverId, { server, toolCount }]) => (
                  <Card
                    key={serverId}
                    className="p-3 hover:shadow-sm transition-all duration-200 border-border/40 bg-card/50"
                  >
                    <div className="flex items-center gap-2.5">
                      <div className="p-1.5 rounded-lg bg-primary/10 shrink-0">
                        <Server className="h-3.5 w-3.5 text-primary" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <h4 className="font-medium text-xs truncate">
                          {server.name}
                        </h4>
                        <div className="flex items-center gap-1 mt-0.5">
                          <Package className="h-3 w-3 text-muted-foreground" />
                          <span className="text-[11px] text-muted-foreground">
                            {toolCount} {toolCount === 1 ? "tool" : "tools"}
                          </span>
                        </div>
                      </div>
                    </div>
                  </Card>
                ),
              )}
            </div>
          ) : (
            <Card className="p-6 text-center border-dashed bg-muted/5">
              <div className="flex flex-col items-center gap-2">
                <div className="p-2 rounded-full bg-muted/30">
                  <Server className="h-5 w-5 text-muted-foreground" />
                </div>
                <div className="space-y-0.5">
                  <p className="text-xs font-medium text-muted-foreground">
                    No MCP servers assigned
                  </p>
                  <p className="text-[11px] text-muted-foreground max-w-xs">
                    Assign servers from Tools or MCP Catalog sections
                  </p>
                </div>
              </div>
            </Card>
          )}
        </div>
      )}

      {/* Token Selector */}
      <div className="space-y-2">
        <Label className="text-sm font-medium">Select token</Label>
        <Select
          value={effectiveTokenId}
          onValueChange={(value) => {
            setSelectedTokenId(value);
            // Reset exposed token state when changing token selection
            setShowExposedToken(false);
            setExposedTokenValue(null);
          }}
        >
          <SelectTrigger className="w-full min-h-[60px] py-2.5">
            <SelectValue placeholder="Select token">
              {effectiveTokenId && (
                <div className="flex flex-col gap-0.5 items-start text-left">
                  <div>{getTokenDisplayName()}</div>
                  <div className="text-xs text-muted-foreground">
                    {isPersonalTokenSelected
                      ? "The most secure option."
                      : selectedTeamToken?.isOrganizationToken
                        ? "To share org-wide"
                        : "To share with your teammates"}
                  </div>
                </div>
              )}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {userToken && (
              <SelectItem value={PERSONAL_TOKEN_ID}>
                <div className="flex flex-col gap-0.5 items-start">
                  <div>Personal Token</div>
                  <div className="text-xs text-muted-foreground">
                    The most secure option.
                  </div>
                </div>
              </SelectItem>
            )}
            {/* Team tokens (non-organization) */}
            {tokens
              ?.filter((token) => !token.isOrganizationToken)
              .map((token) => (
                <SelectItem key={token.id} value={token.id}>
                  <div className="flex flex-col gap-0.5 items-start">
                    <div>
                      {token.team?.name
                        ? `Team Token (${token.team.name})`
                        : token.name}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      To share with your teammates
                    </div>
                  </div>
                </SelectItem>
              ))}
            {/* Organization token */}
            {tokens
              ?.filter((token) => token.isOrganizationToken)
              .map((token) => (
                <SelectItem key={token.id} value={token.id}>
                  <div className="flex flex-col gap-0.5 items-start">
                    <div>Organization Token</div>
                    <div className="text-xs text-muted-foreground">
                      To share org-wide
                    </div>
                  </div>
                </SelectItem>
              ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-3">
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">
            Configuration for MCP clients:
          </p>

          <div className="bg-muted rounded-md p-3 relative">
            <pre className="text-xs whitespace-pre-wrap break-all">
              <CodeText className="text-sm whitespace pre-wrap break-all">
                {mcpConfig}
              </CodeText>
            </pre>
            <div className="absolute top-2 right-2 flex gap-2">
              <Button
                variant="ghost"
                size="sm"
                className="gap-2"
                onClick={handleExposeToken}
                disabled={
                  isLoadingToken ||
                  (!isPersonalTokenSelected && !hasProfileAdminPermission)
                }
              >
                {isLoadingToken ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    <span>Loading...</span>
                  </>
                ) : showExposedToken ? (
                  <>
                    <EyeOff className="h-4 w-4" />
                    <span>Hide token</span>
                  </>
                ) : (
                  <>
                    <Eye className="h-4 w-4" />
                    <span>Expose token</span>
                  </>
                )}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="gap-2"
                onClick={
                  isPersonalTokenSelected || hasProfileAdminPermission
                    ? handleCopyConfig
                    : handleCopyConfigWithoutRealToken
                }
                disabled={isCopyingConfig}
              >
                {isCopyingConfig ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    <span>Copying...</span>
                  </>
                ) : copiedConfig ? (
                  <>
                    <Check className="h-4 w-4 text-green-500" />
                    <span>Copied!</span>
                  </>
                ) : (
                  <>
                    <Copy className="h-4 w-4" />
                    <span>Copy with exposed token</span>
                  </>
                )}
              </Button>
            </div>
          </div>
        </div>

        <p className="text-sm text-muted-foreground">
          The URL is configurable via the{" "}
          <CodeText className="text-xs">
            ARCHESTRA_API_EXTERNAL_BASE_URL
          </CodeText>{" "}
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
