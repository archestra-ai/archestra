"use client";

import {
  type archestraApiTypes,
  DocsPage,
  getDocsUrl,
} from "@archestra/shared";
import { ChevronDown, Mail, MessageCircle, MessagesSquare } from "lucide-react";
import Link from "next/link";
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
import { getManageTokenLink } from "@/components/tokens/manage-token-link";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { WizardStep } from "@/components/wizard-step";
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
  /**
   * "dialog" collapses the secondary channels (chat deep link, email) behind
   * a disclosure; "page" (the Messaging Channels → A2A page) keeps everything
   * expanded.
   */
  layout?: "dialog" | "page";
}

export function A2AConnectionInstructions({
  agent,
  layout = "dialog",
}: A2AConnectionInstructionsProps) {
  // Filter tokens by the agent's teams (internal agents are profiles)
  const { data: tokensData } = useTokens({ profileId: agent.id });
  const { data: userToken } = useUserToken();
  const { data: hasAdminPermission } = useHasPermissions({
    agent: ["admin"],
  });
  // The link opens the create dialog on the OAuth clients page, so it needs
  // create (to submit) on top of read (to see the page at all).
  const { data: canCreateOauthClients } = useHasPermissions({
    mcpOauthClient: ["read", "create"],
  });
  // The Messaging Channels pages are gated on agentTrigger:read.
  const { data: canReadAgentTriggers } = useHasPermissions({
    agentTrigger: ["read"],
  });
  const incomingEmail = useFeature("incomingEmail");

  const tokens = tokensData?.tokens;
  const [selectedTokenId, setSelectedTokenId] = useState<string | null>(null);

  // messageId is required by the A2A protocol and must be unique per message,
  // so each example gets a real UUID (fresh per dialog open).
  const [sendExampleMessageId] = useState(() => crypto.randomUUID());
  const [streamExampleMessageId] = useState(() => crypto.randomUUID());
  const [replyExampleMessageId] = useState(() => crypto.randomUUID());
  const [approvalExampleMessageId] = useState(() => crypto.randomUUID());

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

  // The A2A protocol surface (SendMessage / SendStreamingMessage / the
  // agent-card.json card) lives under /v2.
  const a2aEndpoint = `${toA2ABaseUrl(connectionUrl)}/a2a/${agent.id}`;

  // Default to personal token if available, otherwise org token, then the
  // first token that can actually authenticate against this agent.
  const orgToken = tokens?.find((t) => t.isOrganizationToken);
  const firstUsableToken = tokens?.find((t) => t.worksWithProfile !== false);
  const defaultTokenId = userToken
    ? PERSONAL_TOKEN_ID
    : (orgToken?.id ?? firstUsableToken?.id ?? "");

  // Unusable tokens stay listed but greyed out with the reason.
  const unusableTokenReason =
    agent.scope === "personal"
      ? "Team tokens can't access personal agents"
      : "This agent isn't assigned to this team";

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

  // Deep link to the settings surface where the selected token is managed.
  const manageTokenLink = getManageTokenLink({
    isPersonalTokenSelected,
    selectedTeamToken: selectedTeamToken ?? null,
  });

  // Agent Card URL for discovery
  const agentCardUrl = `${a2aEndpoint}/.well-known/agent-card.json`;
  const chatDeepLink = `${window.location.origin}/chat/new?agent_id=${agent.id}&user_prompt=${encodeURIComponent(
    "Hello!\n\nPlease help me with the following task:\n- Review my code\n- Suggest improvements",
  )}`;

  // cURL example for fetching the agent card (verifies endpoint + credential)
  const agentCardCurlCode = useMemo(
    () => `# Verify: fetch the A2A Agent Card
curl "${agentCardUrl}" \\
  -H "Authorization: Bearer ${tokenForDisplay}"`,
    [agentCardUrl, tokenForDisplay],
  );

  // cURL example code for sending messages
  const curlCode = useMemo(
    () => `# Send a message and wait for the full reply
curl -X POST "${a2aEndpoint}" \\
  -H "Authorization: Bearer ${tokenForDisplay}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "SendMessage",
    "params": {
      "message": {
        "messageId": "${sendExampleMessageId}",
        "role": "ROLE_USER",
        "parts": [{"text": "Hello, can you help me?"}]
      }
    }
  }'`,
    [a2aEndpoint, tokenForDisplay, sendExampleMessageId],
  );

  // cURL example for streaming the reply as Server-Sent Events
  const streamingCurlCode = useMemo(
    () => `# Stream the reply as Server-Sent Events
curl -N -X POST "${a2aEndpoint}" \\
  -H "Authorization: Bearer ${tokenForDisplay}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "jsonrpc": "2.0",
    "id": 2,
    "method": "SendStreamingMessage",
    "params": {
      "message": {
        "messageId": "${streamExampleMessageId}",
        "role": "ROLE_USER",
        "parts": [{"text": "Hello, can you help me?"}]
      }
    }
  }'`,
    [a2aEndpoint, tokenForDisplay, streamExampleMessageId],
  );

  // cURL example for continuing the same conversation across turns
  const replyCurlCode = useMemo(
    () => `# Continue the conversation: copy contextId from the previous reply
curl -X POST "${a2aEndpoint}" \\
  -H "Authorization: Bearer ${tokenForDisplay}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "jsonrpc": "2.0",
    "id": 3,
    "method": "SendMessage",
    "params": {
      "message": {
        "messageId": "${replyExampleMessageId}",
        "contextId": "<contextId from the previous reply>",
        "role": "ROLE_USER",
        "parts": [{"text": "Do you remember my earlier question?"}]
      }
    }
  }'`,
    [a2aEndpoint, tokenForDisplay, replyExampleMessageId],
  );

  // cURL example for answering a tool-approval request
  const approvalCurlCode = useMemo(
    () => `# Approve or deny tool calls. When a tool needs approval, the reply
# is a task with status.state TASK_STATE_INPUT_REQUIRED and
# metadata.approvalRequests — answer each approvalId with a decision.
curl -X POST "${a2aEndpoint}" \\
  -H "Authorization: Bearer ${tokenForDisplay}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "jsonrpc": "2.0",
    "id": 4,
    "method": "SendMessage",
    "params": {
      "message": {
        "messageId": "${approvalExampleMessageId}",
        "taskId": "<task.id from the reply>",
        "contextId": "<contextId from the reply>",
        "role": "ROLE_USER",
        "parts": [],
        "metadata": {
          "taskOps": {
            "approvalDecisions": [
              {"approvalId": "<approvalId from approvalRequests>", "approved": true}
            ]
          }
        }
      }
    }
  }'`,
    [a2aEndpoint, tokenForDisplay, approvalExampleMessageId],
  );

  const chatDeepLinkBlock = (
    <div className="space-y-6">
      {/* Chat Deep Link */}
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <MessageCircle className="h-4 w-4 text-muted-foreground" />
          <Label className="text-sm font-medium">Chat Deep Link</Label>
        </div>
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
    </div>
  );

  // Email and the chat-app channels are tabs on the Messaging Channels page,
  // so the standalone A2A tab (layout="page") doesn't repeat them here.
  const dialogOnlyChannels = (
    <div className="space-y-6">
      {/* Chat apps (ChatOps channels) */}
      {canReadAgentTriggers && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <MessagesSquare className="h-4 w-4 text-muted-foreground" />
            <Label className="text-sm font-medium">Chat Apps</Label>
          </div>
          <p className="text-xs text-muted-foreground">
            Talk to this agent from chat apps like Slack — set it up under{" "}
            <Link
              href="/messaging-channels"
              className="underline hover:text-foreground"
            >
              Messaging Channels
            </Link>
            .
          </p>
        </div>
      )}

      {/* Email Invocation - always show, with configuration guidance when not enabled */}
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

  return (
    <div>
      <WizardStep n={1} title="Endpoint">
        <div className="space-y-3">
          <ConnectionUrlStep
            bare
            candidateUrls={candidateBaseUrls}
            metadata={connectionBaseUrls}
            value={connectionUrl}
            onChange={setUserBaseUrl}
          />
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
        </div>
      </WizardStep>

      <WizardStep n={2} title="Authentication">
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            A2A agents accept your platform tokens — the same tokens the MCP
            Gateway uses — or OAuth clients. LLM API keys and virtual keys will
            not work here.
          </p>
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
                .map((token) => {
                  const unusable = token.worksWithProfile === false;
                  return (
                    <SelectItem
                      key={token.id}
                      value={token.id}
                      disabled={unusable}
                    >
                      <div className="flex flex-col gap-0.5 items-start">
                        <div>
                          {token.team?.name
                            ? `Team Token (${token.team.name})`
                            : token.name}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {unusable
                            ? unusableTokenReason
                            : "To share with your teammates"}
                        </div>
                      </div>
                    </SelectItem>
                  );
                })}
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
          <p className="text-xs text-muted-foreground">
            <Link
              href={manageTokenLink.href}
              className="underline hover:text-foreground"
            >
              {manageTokenLink.label}
            </Link>
            {canCreateOauthClients && (
              <>
                {" "}
                · For machine-to-machine or user-delegated OAuth,{" "}
                <Link
                  // Deep link: opens the create dialog with the client type
                  // and this agent pre-selected.
                  href={`/credentials/oauth-clients?create=true&clientType=mcp&gatewayId=${agent.id}`}
                  className="underline hover:text-foreground"
                >
                  create an OAuth client for this agent
                </Link>
              </>
            )}
          </p>
          {agent.identityProviderId && (
            <p className="text-xs text-muted-foreground">
              This agent is bound to an external identity provider — JWTs it
              issues are also accepted as bearer tokens.
            </p>
          )}
        </div>
      </WizardStep>

      <WizardStep n={3} title="Call the agent" last>
        <div className="space-y-3">
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
          <CurlExampleSection
            key={`stream-${effectiveTokenId}`}
            code={streamingCurlCode}
            tokenForDisplay={tokenForDisplay}
            isPersonalTokenSelected={isPersonalTokenSelected}
            hasAdminPermission={hasAdminPermission ?? false}
            selectedTeamToken={selectedTeamToken ?? null}
            fetchUserTokenMutation={fetchUserTokenMutation}
            fetchTeamTokenMutation={fetchTeamTokenMutation}
          />
          <Collapsible className="rounded-lg border">
            <CollapsibleTrigger className="group flex w-full items-center justify-between px-4 py-3 text-sm font-medium">
              Continue the conversation (multi-turn)
              <ChevronDown className="h-4 w-4 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
            </CollapsibleTrigger>
            <CollapsibleContent className="px-4 pb-4">
              <CurlExampleSection
                key={`reply-${effectiveTokenId}`}
                code={replyCurlCode}
                tokenForDisplay={tokenForDisplay}
                isPersonalTokenSelected={isPersonalTokenSelected}
                hasAdminPermission={hasAdminPermission ?? false}
                selectedTeamToken={selectedTeamToken ?? null}
                fetchUserTokenMutation={fetchUserTokenMutation}
                fetchTeamTokenMutation={fetchTeamTokenMutation}
              />
            </CollapsibleContent>
          </Collapsible>
          <Collapsible className="rounded-lg border">
            <CollapsibleTrigger className="group flex w-full items-center justify-between px-4 py-3 text-sm font-medium">
              Approve or deny tool calls
              <ChevronDown className="h-4 w-4 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
            </CollapsibleTrigger>
            <CollapsibleContent className="px-4 pb-4">
              <CurlExampleSection
                key={`approval-${effectiveTokenId}`}
                code={approvalCurlCode}
                tokenForDisplay={tokenForDisplay}
                isPersonalTokenSelected={isPersonalTokenSelected}
                hasAdminPermission={hasAdminPermission ?? false}
                selectedTeamToken={selectedTeamToken ?? null}
                fetchUserTokenMutation={fetchUserTokenMutation}
                fetchTeamTokenMutation={fetchTeamTokenMutation}
              />
            </CollapsibleContent>
          </Collapsible>
          <p className="text-xs text-muted-foreground">
            Full protocol reference — streaming, multi-turn conversations, and
            tool approvals — in the{" "}
            <a
              href={getDocsUrl(DocsPage.PlatformAgentTriggersWebhookA2a)}
              target="_blank"
              rel="noreferrer"
              className="underline hover:text-foreground"
            >
              A2A docs
            </a>
            .
          </p>
        </div>
      </WizardStep>

      <div className="mt-6 space-y-6 border-t pt-6">
        <h3 className="text-[17px] font-bold tracking-tight text-foreground">
          Other ways to reach this agent
        </h3>
        {chatDeepLinkBlock}
        {layout === "dialog" && dialogOnlyChannels}
      </div>
    </div>
  );
}

// ===
// Internal helpers
// ===

/**
 * Connection base URLs carry a /v1 suffix (see getExternalProxyUrls); the A2A
 * protocol surface lives under /v2.
 */
function toA2ABaseUrl(connectionUrl: string): string {
  return connectionUrl.endsWith("/v1")
    ? `${connectionUrl.slice(0, -"/v1".length)}/v2`
    : `${connectionUrl}/v2`;
}
