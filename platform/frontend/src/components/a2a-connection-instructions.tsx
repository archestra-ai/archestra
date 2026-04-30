"use client";

import type { archestraApiTypes } from "@shared";
import { Mail } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import {
  resolveAdminDefaultBaseUrl,
  resolveCandidateBaseUrls,
} from "@/app/connection/connection-flow.utils";
import { ConnectionUrlStep } from "@/app/connection/connection-url-step";
import {
  CodeBlock,
  CodeBlockCopyButton,
} from "@/components/ai-elements/code-block";
import { CodeText } from "@/components/code-text";
import { CopyableCode } from "@/components/copyable-code";
import { CurlExampleSection } from "@/components/curl-example-section";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useAgentEmailAddress } from "@/lib/chatops/incoming-email.query";
import config from "@/lib/config/config";
import { useFeature } from "@/lib/config/config.query";
import { useOrganization } from "@/lib/organization.query";
import {
  useFetchTeamTokenValue,
  useTokens,
} from "@/lib/teams/team-token.query";
import { useFetchUserTokenValue, useUserToken } from "@/lib/user-token.query";
import {
  AgentEmailDisabledMessage,
  EmailNotConfiguredMessage,
} from "./email-not-configured-message";

type InternalAgent = archestraApiTypes.GetAllAgentsResponses["200"][number];

// Special ID for personal token in the dropdown
const PERSONAL_TOKEN_ID = "__personal_token__";

interface A2AConnectionInstructionsProps {
  agent: InternalAgent;
}

export function A2AConnectionInstructions({
  agent,
}: A2AConnectionInstructionsProps) {
  // Filter tokens by the agent's teams (internal agents are profiles)
  const { data: tokensData } = useTokens({ profileId: agent.id });
  const { data: userToken } = useUserToken();
  const { data: hasAdminPermission } = useHasPermissions({
    agent: ["admin"],
  });
  const incomingEmail = useFeature("incomingEmail");

  const tokens = tokensData?.tokens;
  const [selectedTokenId, setSelectedTokenId] = useState<string | null>(null);

  // Mirror the /connection page's base-URL fallback chain so the A2A panel
  // honors the same admin curation (descriptions, default flag, hidden URLs).
  const { data: organization } = useOrganization();
  const connectionBaseUrls = organization?.connectionBaseUrls ?? null;
  const candidateBaseUrls = useMemo(
    () =>
      resolveCandidateBaseUrls({
        externalProxyUrls: config.api.externalProxyUrls,
        internalProxyUrl: config.api.internalProxyUrl,
        metadata: connectionBaseUrls,
      }),
    [connectionBaseUrls],
  );
  const adminDefaultBaseUrl = useMemo(
    () => resolveAdminDefaultBaseUrl(connectionBaseUrls),
    [connectionBaseUrls],
  );
  const [userBaseUrl, setUserBaseUrl] = useState<string | null>(null);
  const connectionUrl =
    (userBaseUrl && candidateBaseUrls.includes(userBaseUrl) && userBaseUrl) ||
    (adminDefaultBaseUrl &&
      candidateBaseUrls.includes(adminDefaultBaseUrl) &&
      adminDefaultBaseUrl) ||
    candidateBaseUrls[0];

  // Mutations for fetching token values
  const fetchUserTokenMutation = useFetchUserTokenValue();
  const fetchTeamTokenMutation = useFetchTeamTokenValue();

  // Email invocation - check both global feature AND agent-level setting
  const globalEmailEnabled = incomingEmail?.enabled ?? false;
  const agentEmailEnabled = agent.incomingEmailEnabled ?? false;
  const emailEnabled = globalEmailEnabled && agentEmailEnabled;

  // Fetch the email address from the backend (uses correct mailbox local part)
  const { data: emailAddressData } = useAgentEmailAddress(
    emailEnabled ? agent.id : null,
  );
  const agentEmailAddress = emailAddressData?.emailAddress ?? null;

  // A2A endpoint
  const a2aEndpoint = `${connectionUrl}/a2a/${agent.id}`;

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

  // Determine display token based on selection (masked)
  const tokenForDisplay = isPersonalTokenSelected
    ? userToken
      ? `${userToken.tokenStart}***`
      : "ask-admin-for-access-token"
    : hasAdminPermission && selectedTeamToken
      ? `${selectedTeamToken.tokenStart}***`
      : "ask-admin-for-access-token";

  // Agent Card URL for discovery
  const agentCardUrl = `${connectionUrl}/a2a/${agent.id}/.well-known/agent.json`;
  const chatDeepLink = `${window.location.origin}/chat/new?agent_id=${agent.id}&user_prompt=${encodeURIComponent(
    "Hello!\n\nPlease help me with the following task:\n- Review my code\n- Suggest improvements",
  )}`;

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

  return (
    <div className="space-y-6">
      <ConnectionUrlStep
        candidateUrls={candidateBaseUrls}
        metadata={connectionBaseUrls}
        value={connectionUrl}
        onChange={setUserBaseUrl}
      />
      {/* A2A Endpoint URL */}
      <div className="space-y-2">
        <Label className="text-sm font-medium">A2A Endpoint URL</Label>
        <CodeBlock
          code={a2aEndpoint}
          language="text"
          wrapLongLines
          contentClassName="overflow-x-hidden"
          contentStyle={{
            fontSize: "0.75rem",
            paddingRight: "3.5rem",
          }}
        >
          <div className="overflow-hidden rounded-md border bg-background/95 shadow-sm backdrop-blur supports-[backdrop-filter]:bg-background/80">
            <CodeBlockCopyButton
              title="Copy A2A endpoint URL"
              className="rounded-none"
              onCopy={() => toast.success("A2A endpoint URL copied")}
              onError={() => toast.error("Failed to copy A2A endpoint URL")}
            />
          </div>
        </CodeBlock>
      </div>

      {/* Chat Deep Link */}
      <div className="space-y-2">
        <Label className="text-sm font-medium">Chat Deep Link</Label>
        <p className="text-xs text-muted-foreground">
          Use this URL to open chat with the agent and send a message
          automatically.
        </p>
        <CodeBlock
          code={chatDeepLink}
          language="text"
          wrapLongLines
          contentClassName="overflow-x-hidden"
          contentStyle={{
            fontSize: "0.75rem",
            paddingRight: "3.5rem",
          }}
        >
          <div className="overflow-hidden rounded-md border bg-background/95 shadow-sm backdrop-blur supports-[backdrop-filter]:bg-background/80">
            <CodeBlockCopyButton
              title="Copy chat deep link"
              className="rounded-none"
              onCopy={() => toast.success("Chat deep link copied")}
              onError={() => toast.error("Failed to copy chat deep link")}
            />
          </div>
        </CodeBlock>
      </div>

      {/* Token Selector */}
      <div className="space-y-2">
        <Label className="text-sm font-medium">Authentication Token</Label>
        <Select
          value={effectiveTokenId}
          onValueChange={(value) => {
            setSelectedTokenId(value);
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

      {/* cURL Examples */}
      <div className="space-y-3">
        <Label className="text-sm font-medium">cURL Examples</Label>

        {/* Send message example */}
        <CurlExampleSection
          key={`send-${effectiveTokenId}`}
          code={curlCode}
          tokenForDisplay={tokenForDisplay}
          isPersonalTokenSelected={isPersonalTokenSelected}
          hasAdminPermission={hasAdminPermission ?? false}
          selectedTeamToken={selectedTeamToken ?? null}
          fetchUserTokenMutation={fetchUserTokenMutation}
          fetchTeamTokenMutation={fetchTeamTokenMutation}
        />

        {/* Agent Card discovery example */}
        <CurlExampleSection
          key={`card-${effectiveTokenId}`}
          code={agentCardCurlCode}
          tokenForDisplay={tokenForDisplay}
          isPersonalTokenSelected={isPersonalTokenSelected}
          hasAdminPermission={hasAdminPermission ?? false}
          selectedTeamToken={selectedTeamToken ?? null}
          fetchUserTokenMutation={fetchUserTokenMutation}
          fetchTeamTokenMutation={fetchTeamTokenMutation}
        />
      </div>

      {/* Email Invocation Section - always show, with configuration guidance when not enabled */}
      <Separator />
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <Mail className="h-4 w-4 text-muted-foreground" />
          <Label className="text-sm font-medium">Email Invocation</Label>
        </div>

        {!globalEmailEnabled ? (
          <div className="bg-muted/50 rounded-md p-3">
            <EmailNotConfiguredMessage />
          </div>
        ) : agentEmailEnabled ? (
          <>
            {/* Security mode description */}
            <div className="bg-muted/50 rounded-md p-3 text-sm text-muted-foreground">
              {agent.incomingEmailSecurityMode === "private" && (
                <p>
                  <strong>Private mode:</strong> Only emails from registered
                  users with access to this agent will be processed.
                </p>
              )}
              {agent.incomingEmailSecurityMode === "internal" && (
                <p>
                  <strong>Internal mode:</strong> Only emails from{" "}
                  <span className="font-mono text-xs">
                    @{agent.incomingEmailAllowedDomain || "your-domain.com"}
                  </span>{" "}
                  will be processed.
                </p>
              )}
              {agent.incomingEmailSecurityMode === "public" && (
                <p>
                  <strong>Public mode:</strong> Any email will be processed. Use
                  with caution.
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
                <CopyableCode
                  value={agentEmailAddress}
                  toastMessage="Email address copied"
                  variant="primary"
                >
                  <div className="flex items-center gap-2">
                    <Mail className="h-3 w-3 text-muted-foreground shrink-0" />
                    <CodeText className="text-xs text-primary break-all">
                      {agentEmailAddress}
                    </CodeText>
                  </div>
                </CopyableCode>
              </div>
            )}
          </>
        ) : (
          <div className="bg-muted/50 rounded-md p-3 text-sm text-muted-foreground">
            <AgentEmailDisabledMessage />
          </div>
        )}
      </div>
    </div>
  );
}
