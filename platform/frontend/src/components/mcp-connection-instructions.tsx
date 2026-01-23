"use client";

import { archestraApiSdk } from "@shared";
import {
  Bot,
  Check,
  Copy,
  Eye,
  EyeOff,
  Layers,
  Loader2,
  X,
  Zap,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { CodeText } from "@/components/code-text";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useProfiles } from "@/lib/agent.query";
import {
  useAgentDelegations,
  useAllProfileTools,
} from "@/lib/agent-tools.query";
import { useHasPermissions } from "@/lib/auth.query";
import { useChatProfileMcpTools } from "@/lib/chat.query";
import config from "@/lib/config";
import { useInternalMcpCatalog } from "@/lib/internal-mcp-catalog.query";
import {
  useMcpServers,
  useMcpServersGroupedByCatalog,
} from "@/lib/mcp-server.query";
import { useTokens } from "@/lib/team-token.query";
import { useUserToken } from "@/lib/user-token.query";

const { internalProxyUrl } = config.api;

interface McpConnectionInstructionsProps {
  agentId: string;
  /** Hide the profile selector (useful when opened from a specific profile's dialog) */
  hideProfileSelector?: boolean;
}

// Special ID for personal token in the dropdown
const PERSONAL_TOKEN_ID = "__personal_token__";

export function McpConnectionInstructions({
  agentId,
  hideProfileSelector = false,
}: McpConnectionInstructionsProps) {
  const { data: profiles } = useProfiles();
  const { data: mcpServers } = useMcpServers();
  const { data: catalogItems = [] } = useInternalMcpCatalog();
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

  // Fetch subagents (delegations) for the selected profile
  const { data: subagents = [] } = useAgentDelegations(selectedProfileId);

  // Fetch assigned tools with credential source info for the selected profile
  const { data: assignedToolsData } = useAllProfileTools({
    filters: { agentId: selectedProfileId },
    skipPagination: true,
    enabled: !!selectedProfileId,
  });

  // Group tools by MCP server for the selected profile
  const mcpServerToolGroups = useMemo(() => {
    if (!mcpServers || !assignedToolsData?.data) return new Map();

    const groups = new Map<
      string,
      {
        server: (typeof mcpServers)[0];
        tools: Array<{ id: string; name: string; description?: string | null }>;
        credentialSourceMcpServerId?: string | null;
        useDynamicTeamCredential?: boolean;
      }
    >();

    assignedToolsData.data.forEach((agentTool) => {
      const tool = agentTool.tool;
      if (tool.mcpServerId) {
        const server = mcpServers.find((s) => s.id === tool.mcpServerId);
        if (server) {
          const existing = groups.get(tool.mcpServerId);
          const toolName = tool.name.split("__").pop() ?? tool.name;
          const toolData = {
            id: tool.id,
            name: toolName,
            description: tool.description,
          };
          if (existing) {
            existing.tools.push(toolData);
          } else {
            // Get credential source from the agent tool assignment
            const credentialSource =
              agentTool.credentialSourceMcpServerId ??
              agentTool.executionSourceMcpServerId;
            groups.set(tool.mcpServerId, {
              server,
              tools: [toolData],
              credentialSourceMcpServerId: credentialSource,
              useDynamicTeamCredential: agentTool.useDynamicTeamCredential,
            });
          }
        }
      }
    });

    return groups;
  }, [mcpServers, assignedToolsData]);

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
  const mcpUrl = `${internalProxyUrl}/mcp/${selectedProfileId}`;

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
      {/* Profile Selector - hidden when opened from a specific profile's dialog */}
      {!hideProfileSelector && (
        <div className="space-y-2">
          <Label className="text-sm font-medium">Select Profile</Label>
          <Select
            value={selectedProfileId}
            onValueChange={setSelectedProfileId}
          >
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
      )}

      {/* Tools - Read-only display */}
      {selectedProfile && (
        <div className="space-y-2">
          <Label className="text-sm font-medium">Tools</Label>
          {mcpServerToolGroups.size > 0 ? (
            <div className="flex flex-wrap gap-2">
              {Array.from(mcpServerToolGroups.entries()).map(
                ([
                  serverId,
                  {
                    server,
                    tools,
                    credentialSourceMcpServerId,
                    useDynamicTeamCredential,
                  },
                ]) => (
                  <ReadOnlyMcpServerPill
                    key={serverId}
                    server={server}
                    tools={tools}
                    credentialSourceMcpServerId={credentialSourceMcpServerId}
                    catalogItems={catalogItems}
                    useDynamicTeamCredential={useDynamicTeamCredential}
                  />
                ),
              )}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No tools assigned</p>
          )}
        </div>
      )}

      {/* Subagents - Read-only display */}
      {selectedProfile && (
        <div className="space-y-2">
          <Label className="text-sm font-medium">Subagents</Label>
          {subagents.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {subagents.map((agent) => (
                <ReadOnlySubagentPill key={agent.id} agent={agent} />
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              No subagents assigned
            </p>
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
            <div className="flex justify-end gap-2">
              <Button
                variant="ghost"
                size="sm"
                className="gap-2 bg-transparent"
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
                className="gap-2 bg-transparent"
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
            <pre className="text-xs whitespace-pre-wrap break-all">
              <CodeText className="text-sm whitespace pre-wrap break-all">
                {mcpConfig}
              </CodeText>
            </pre>
          </div>
        </div>
      </div>
    </div>
  );
}

// Read-only MCP Server Pill with popover (same structure as Edit dialog)
interface ReadOnlyMcpServerPillProps {
  server: {
    id: string;
    name: string;
    description?: string | null;
    catalogId?: string | null;
  };
  tools: Array<{ id: string; name: string; description?: string | null }>;
  credentialSourceMcpServerId?: string | null;
  catalogItems: Array<{
    id: string;
    name: string;
    description?: string | null;
  }>;
  useDynamicTeamCredential?: boolean;
}

function ReadOnlyMcpServerPill({
  server,
  tools,
  credentialSourceMcpServerId,
  catalogItems,
  useDynamicTeamCredential,
}: ReadOnlyMcpServerPillProps) {
  const [open, setOpen] = useState(false);

  // Find the catalog item to get the clean display name
  const catalogItem = server.catalogId
    ? catalogItems.find((c) => c.id === server.catalogId)
    : null;

  // Use catalog name if available, otherwise fall back to server name
  const displayName = catalogItem?.name ?? server.name;
  const displayDescription =
    catalogItem?.description ?? server.description ?? null;

  // Fetch credentials for this catalog to get owner email/team info
  const groupedCredentials = useMcpServersGroupedByCatalog({
    catalogId: server.catalogId ?? undefined,
  });
  const credentialServers = server.catalogId
    ? (groupedCredentials?.[server.catalogId] ?? [])
    : [];

  // Find the credential server to get owner email/team name
  const credentialServer = credentialSourceMcpServerId
    ? credentialServers.find((s) => s.id === credentialSourceMcpServerId)
    : null;

  // Get credential display text (owner email or team name)
  const credentialDisplayText = useDynamicTeamCredential
    ? null
    : credentialServer
      ? (credentialServer.teamDetails?.name ??
        credentialServer.ownerEmail ??
        "Unknown")
      : null;

  // Check if we should show credential section
  const showCredentialSection =
    useDynamicTeamCredential || credentialDisplayText;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-8 px-3 gap-1.5 text-xs"
        >
          <span className="font-medium">{displayName}</span>
          <span className="text-muted-foreground">({tools.length})</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-[420px] p-0"
        side="bottom"
        align="start"
        sideOffset={8}
        avoidCollisions
      >
        <div className="p-4 border-b flex items-start justify-between gap-2">
          <div>
            <h4 className="font-semibold">{displayName}</h4>
            {displayDescription && (
              <p className="text-sm text-muted-foreground mt-1">
                {displayDescription}
              </p>
            )}
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 w-6 p-0 shrink-0"
            onClick={() => setOpen(false)}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        {/* Credential Selector - Read Only */}
        {showCredentialSection && (
          <div className="p-4 border-b space-y-2 opacity-60">
            <Label className="text-sm font-medium">Credential</Label>
            {useDynamicTeamCredential ? (
              <div className="flex items-center gap-1 text-sm">
                <Zap className="h-3 w-3 text-amber-500" />
                <span className="font-medium">Resolve at call time</span>
              </div>
            ) : (
              <div className="text-sm">{credentialDisplayText}</div>
            )}
          </div>
        )}

        {/* Tool Checklist - Read Only (same structure as Edit dialog) */}
        <div className="opacity-60">
          <div className="px-4 py-2 border-b flex items-center justify-between bg-muted/30">
            <span className="text-xs text-muted-foreground">
              {tools.length} of {tools.length} selected
            </span>
            <div className="flex gap-1">
              <Button
                variant="ghost"
                size="sm"
                className="text-xs h-6 px-2"
                disabled
              >
                Select All
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="text-xs h-6 px-2"
                disabled
              >
                Deselect All
              </Button>
            </div>
          </div>
          <div className="max-h-[350px] overflow-y-auto">
            <div className="p-2 space-y-0.5">
              {tools.map((tool) => (
                <div
                  key={tool.id}
                  className="flex items-start gap-3 p-2 rounded-md bg-primary/10"
                >
                  <Checkbox checked disabled className="mt-0.5" />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium">{tool.name}</div>
                    {tool.description && (
                      <div className="text-xs text-muted-foreground mt-0.5">
                        {tool.description}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

// Read-only Subagent Pill with popover (same structure as Edit dialog)
interface ReadOnlySubagentPillProps {
  agent: {
    id: string;
    name: string;
    systemPrompt?: string | null;
  };
}

function ReadOnlySubagentPill({ agent }: ReadOnlySubagentPillProps) {
  const [open, setOpen] = useState(false);
  const { data: tools = [], isLoading } = useChatProfileMcpTools(agent.id);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-8 px-3 gap-1.5 text-xs"
        >
          <span className="h-2 w-2 rounded-full bg-green-500" />
          <Bot className="h-3 w-3" />
          <span className="font-medium">{agent.name}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-[350px] p-0"
        side="bottom"
        align="start"
        sideOffset={8}
        avoidCollisions
      >
        <div className="p-4 border-b flex items-start justify-between gap-2">
          <div className="flex-1">
            <h4 className="font-semibold">{agent.name}</h4>
            {agent.systemPrompt && (
              <p className="text-sm text-muted-foreground mt-1 line-clamp-2">
                {agent.systemPrompt}
              </p>
            )}
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 w-6 p-0 shrink-0"
            onClick={() => setOpen(false)}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="p-4 border-b opacity-60">
          <div className="flex items-center gap-3">
            <Checkbox checked disabled />
            <span className="text-sm font-medium">Enabled as subagent</span>
          </div>
        </div>

        <div className="p-4">
          {isLoading ? (
            <p className="text-xs text-muted-foreground">Loading tools...</p>
          ) : tools.length === 0 ? (
            <p className="text-xs text-muted-foreground">No tools available</p>
          ) : (
            <div className="space-y-1">
              <p className="text-xs font-medium text-muted-foreground mb-2">
                Available tools ({tools.length}):
              </p>
              <div className="flex flex-wrap gap-1 max-h-[200px] overflow-y-auto">
                {tools.map((tool) => (
                  <span
                    key={tool.name}
                    className="inline-flex items-center gap-1 text-xs bg-muted px-2 py-0.5 rounded"
                  >
                    {tool.name}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
