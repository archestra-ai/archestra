"use client";

import type { archestraApiTypes } from "@shared";
import { archestraApiSdk } from "@shared";
import { Check, Copy, Eye, EyeOff, Loader2, Mail } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import { CodeText } from "@/components/code-text";
import {
  type ConnectionType,
  ConnectionTypeSelector,
} from "@/components/connection-type-selector";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { useHasPermissions } from "@/lib/auth.query";
import config from "@/lib/config";
import { useFeatures } from "@/lib/features.query";
import { usePromptEmailAddress } from "@/lib/incoming-email.query";
import { useTokens } from "@/lib/team-token.query";
import { useUserToken } from "@/lib/user-token.query";

const { externalProxyUrl, internalProxyUrl } = config.api;

type Prompt = archestraApiTypes.GetPromptsResponses["200"][number];

// Special ID for personal token in the dropdown
const PERSONAL_TOKEN_ID = "__personal_token__";

interface A2AConnectionInstructionsProps {
  prompt: Prompt;
}

export function A2AConnectionInstructions({
  prompt,
}: A2AConnectionInstructionsProps) {
  // Filter tokens by the profile's teams (prompt.agentId is the profile ID)
  const { data: tokensData } = useTokens({ profileId: prompt.agentId });
  const { data: userToken } = useUserToken();
  const { data: hasProfileAdminPermission } = useHasPermissions({
    profile: ["admin"],
  });
  const { data: features } = useFeatures();

  const tokens = tokensData?.tokens;
  const [copiedUrl, setCopiedUrl] = useState(false);
  const [copiedChatLink, setCopiedChatLink] = useState(false);
  const [copiedCode, setCopiedCode] = useState(false);
  const [copiedEmail, setCopiedEmail] = useState(false);
  const [selectedTokenId, setSelectedTokenId] = useState<string | null>(null);
  const [connectionType, setConnectionType] =
    useState<ConnectionType>("internal");
  const [showExposedToken, setShowExposedToken] = useState(false);
  const [exposedTokenValue, setExposedTokenValue] = useState<string | null>(
    null,
  );
  const [isLoadingToken, setIsLoadingToken] = useState(false);
  const [isCopyingCode, setIsCopyingCode] = useState(false);

  // Email invocation - check both global feature AND prompt-level setting
  const globalEmailEnabled = features?.incomingEmail?.enabled ?? false;
  const promptEmailEnabled = prompt.incomingEmailEnabled ?? false;

  // Fetch the email address only if both global feature is enabled AND this prompt has email enabled
  const { data: emailAddressData } = usePromptEmailAddress(
    globalEmailEnabled && promptEmailEnabled ? prompt.id : null,
  );
  const agentEmailAddress = emailAddressData?.emailAddress ?? null;

  const handleCopyEmail = useCallback(async () => {
    if (!agentEmailAddress) return;
    await navigator.clipboard.writeText(agentEmailAddress);
    setCopiedEmail(true);
    toast.success("Email address copied");
    setTimeout(() => setCopiedEmail(false), 2000);
  }, [agentEmailAddress]);

  // Get base URL from config based on connection type
  const baseUrl =
    connectionType === "internal" ? internalProxyUrl : externalProxyUrl;

  // A2A endpoint
  const a2aEndpoint = `${baseUrl}/a2a/${prompt.id}`;

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

  const handleCopyUrl = useCallback(async () => {
    await navigator.clipboard.writeText(a2aEndpoint);
    setCopiedUrl(true);
    toast.success("A2A endpoint URL copied");
    setTimeout(() => setCopiedUrl(false), 2000);
  }, [a2aEndpoint]);

  const handleCopyChatLink = useCallback(async () => {
    const exampleMessage =
      "Hello!\n\nPlease help me with the following task:\n- Review my code\n- Suggest improvements";
    const chatLink = `${window.location.origin}/chat/new?agent_id=${prompt.id}&user_prompt=${encodeURIComponent(exampleMessage)}`;
    await navigator.clipboard.writeText(chatLink);
    setCopiedChatLink(true);
    toast.success("Chat deep link copied");
    setTimeout(() => setCopiedChatLink(false), 2000);
  }, [prompt.id]);

  // Agent Card URL for discovery
  const agentCardUrl = `${baseUrl}/a2a/${prompt.id}/.well-known/agent.json`;

  // cURL example code for sending messages
  const curlCode = useMemo(
    () => `# Send a message to the A2A agent
curl -X POST "${a2aEndpoint}" \\
  -H "Authorization: Bearer ${tokenForDisplay}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "message/send",
    "params": {
      "message": {
        "parts": [{"kind": "text", "text": "Hello, can you help me?"}]
      }
    }
  }'`,
    [a2aEndpoint, tokenForDisplay],
  );

  // cURL example for fetching agent card
  const agentCardCurlCode = useMemo(
    () => `# Fetch the A2A Agent Card (discovery)
curl -X GET "${agentCardUrl}" \\
  -H "Authorization: Bearer ${tokenForDisplay}"`,
    [agentCardUrl, tokenForDisplay],
  );

  const handleCopyCode = useCallback(
    async (code: string) => {
      setIsCopyingCode(true);
      try {
        // Fetch real token if available
        let tokenValue = tokenForDisplay;

        if (isPersonalTokenSelected || hasProfileAdminPermission) {
          try {
            if (isPersonalTokenSelected) {
              const response = await archestraApiSdk.getUserTokenValue();
              if (response.data) {
                tokenValue = (response.data as { value: string }).value;
              }
            } else if (selectedTeamToken) {
              const response = await archestraApiSdk.getTokenValue({
                path: { tokenId: selectedTeamToken.id },
              });
              if (response.data) {
                tokenValue = (response.data as { value: string }).value;
              }
            }
          } catch {
            // Keep the display token if fetch fails
          }
        }

        const codeWithRealToken = code.replace(tokenForDisplay, tokenValue);
        await navigator.clipboard.writeText(codeWithRealToken);
        setCopiedCode(true);
        toast.success("Code copied with token");
        setTimeout(() => setCopiedCode(false), 2000);
      } finally {
        setIsCopyingCode(false);
      }
    },
    [
      tokenForDisplay,
      isPersonalTokenSelected,
      hasProfileAdminPermission,
      selectedTeamToken,
    ],
  );

  return (
    <div className="space-y-6">
      {/* A2A Endpoint URL */}
      <div className="space-y-2">
        <Label className="text-sm font-medium">A2A Endpoint URL</Label>
        <div className="flex items-center gap-2">
          <div className="flex-1 min-w-0 bg-primary/5 rounded-md px-3 py-2 border border-primary/20 flex items-center gap-2">
            <CodeText className="text-xs text-primary break-all flex-1">
              {a2aEndpoint}
            </CodeText>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 flex-shrink-0"
              onClick={handleCopyUrl}
            >
              {copiedUrl ? (
                <Check className="h-3 w-3 text-green-500" />
              ) : (
                <Copy className="h-3 w-3" />
              )}
            </Button>
          </div>
        </div>
      </div>

      {/* Chat Deep Link */}
      <div className="space-y-2">
        <Label className="text-sm font-medium">Chat Deep Link</Label>
        <p className="text-xs text-muted-foreground">
          Use this URL to open chat with the agent and send a message
          automatically.
        </p>
        <div className="bg-muted rounded-md p-3 pt-10 relative">
          <pre className="text-xs whitespace-pre-wrap break-all overflow-x-auto">
            <code>
              {`${window.location.origin}/chat/new?agent_id=${prompt.id}&user_prompt=${encodeURIComponent("Hello!\n\nPlease help me with the following task:\n- Review my code\n- Suggest improvements")}`}
            </code>
          </pre>
          <div className="absolute top-2 right-2">
            <Button
              variant="ghost"
              size="sm"
              className="gap-2"
              onClick={handleCopyChatLink}
            >
              {copiedChatLink ? (
                <>
                  <Check className="h-4 w-4 text-green-500" />
                  <span>Copied!</span>
                </>
              ) : (
                <>
                  <Copy className="h-4 w-4" />
                  <span>Copy</span>
                </>
              )}
            </Button>
          </div>
        </div>
      </div>

      {/* Token Selector */}
      <div className="space-y-2">
        <Label className="text-sm font-medium">Authentication Token</Label>
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

      {/* Connection Type Selector */}
      <ConnectionTypeSelector
        value={connectionType}
        onChange={setConnectionType}
        gatewayName="A2A Gateway"
        idPrefix="a2a"
      />

      {/* cURL Examples */}
      <div className="space-y-3">
        <Label className="text-sm font-medium">cURL Examples</Label>

        {/* Send message example */}
        <div className="bg-muted rounded-md p-3 pt-12 relative">
          <pre className="text-xs whitespace-pre-wrap break-all overflow-x-auto">
            <code>{curlCode}</code>
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
              onClick={() => handleCopyCode(curlCode)}
              disabled={isCopyingCode}
            >
              {isCopyingCode ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span>Copying...</span>
                </>
              ) : copiedCode ? (
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

        {/* Agent Card discovery example */}
        <div className="bg-muted rounded-md p-3 pt-12 relative">
          <pre className="text-xs whitespace-pre-wrap break-all overflow-x-auto">
            <code>{agentCardCurlCode}</code>
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
              onClick={() => handleCopyCode(agentCardCurlCode)}
              disabled={isCopyingCode}
            >
              {isCopyingCode ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span>Copying...</span>
                </>
              ) : copiedCode ? (
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

      {/* Email Invocation Section - show when global email feature is enabled */}
      {globalEmailEnabled && (
        <>
          <Separator />
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <Mail className="h-4 w-4 text-muted-foreground" />
              <Label className="text-sm font-medium">Email Invocation</Label>
            </div>

            {promptEmailEnabled ? (
              <>
                {/* Security mode description */}
                <div className="bg-muted/50 rounded-md p-3 text-sm text-muted-foreground">
                  {prompt.incomingEmailSecurityMode === "private" && (
                    <p>
                      <strong>Private mode:</strong> Only emails from registered
                      users with access to this agent will be processed.
                    </p>
                  )}
                  {prompt.incomingEmailSecurityMode === "internal" && (
                    <p>
                      <strong>Internal mode:</strong> Only emails from{" "}
                      <span className="font-mono text-xs">
                        @
                        {prompt.incomingEmailAllowedDomain || "your-domain.com"}
                      </span>{" "}
                      will be processed.
                    </p>
                  )}
                  {prompt.incomingEmailSecurityMode === "public" && (
                    <p>
                      <strong>Public mode:</strong> Any email will be processed.
                      Use with caution.
                    </p>
                  )}
                </div>

                {/* Email address */}
                {agentEmailAddress && (
                  <div className="space-y-2">
                    <Label className="text-sm text-muted-foreground">
                      Send an email to invoke this agent. The email body will be
                      used as the first message.
                    </Label>
                    <div className="flex items-center gap-2">
                      <div className="flex-1 min-w-0 bg-primary/5 rounded-md px-3 py-2 border border-primary/20 flex items-center gap-2">
                        <Mail className="h-3 w-3 text-muted-foreground flex-shrink-0" />
                        <CodeText className="text-xs text-primary break-all flex-1">
                          {agentEmailAddress}
                        </CodeText>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6 flex-shrink-0"
                          onClick={handleCopyEmail}
                        >
                          {copiedEmail ? (
                            <Check className="h-3 w-3 text-green-500" />
                          ) : (
                            <Copy className="h-3 w-3" />
                          )}
                        </Button>
                      </div>
                    </div>
                  </div>
                )}
              </>
            ) : (
              <div className="bg-muted/50 rounded-md p-3 text-sm text-muted-foreground">
                <p>
                  Email invocation is not enabled for this agent. Enable it in
                  the agent settings to allow triggering via email.
                </p>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
