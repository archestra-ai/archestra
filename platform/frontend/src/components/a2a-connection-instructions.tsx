"use client";

import {
  type archestraApiTypes,
  DocsPage,
  getDocsUrl,
} from "@archestra/shared";
import { ChevronDown, KeyRound, MessageCircle } from "lucide-react";
import Link from "next/link";
import { useId, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  resolveAdminDefaultBaseUrl,
  resolveCandidateBaseUrls,
} from "@/app/connection/connection-flow.utils";
import { ConnectionUrlStep } from "@/app/connection/connection-url-step";
import { AgentChatApps } from "@/components/agent-chat-apps";
import {
  CodeBlock,
  CodeBlockCopyButton,
} from "@/components/ai-elements/code-block";
import { CurlExampleSection } from "@/components/curl-example-section";
import { McpOauthManagement } from "@/components/mcp-oauth-management";
import { getManageTokenLink } from "@/components/tokens/manage-token-link";
import { Button } from "@/components/ui/button";
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
import config from "@/lib/config/config";
import { useOrganization } from "@/lib/organization.query";
import {
  useFetchTeamTokenValue,
  useTokens,
} from "@/lib/teams/team-token.query";
import { useFetchUserTokenValue, useUserToken } from "@/lib/user-token.query";
import { generateUuid } from "@/lib/uuid";

type InternalAgent = archestraApiTypes.GetAllAgentsResponses["200"][number];

// Special ID for personal token in the dropdown
const PERSONAL_TOKEN_ID = "__personal_token__";

interface A2AConnectionInstructionsProps {
  agent: InternalAgent;
  layout: "page" | "detail";
}

export function A2AConnectionInstructions({
  agent,
  layout,
}: A2AConnectionInstructionsProps) {
  const { data: tokensData } = useTokens({
    profileId: agent.id,
  });
  const { data: userToken } = useUserToken();
  const { data: hasAdminPermission } = useHasPermissions({
    agent: ["admin"],
  });
  // The Messaging Channels pages are gated on agentTrigger:read.
  const { data: canReadAgentTriggers } = useHasPermissions({
    agentTrigger: ["read"],
  });

  const tokens = tokensData?.tokens;
  const [selectedTokenId, setSelectedTokenId] = useState<string | null>(null);

  // messageId is required by the A2A protocol and must be unique per message,
  // so each example gets a real UUID (fresh per mount).
  const [sendExampleMessageId] = useState(() => generateUuid());
  const [streamExampleMessageId] = useState(() => generateUuid());
  const [replyExampleMessageId] = useState(() => generateUuid());
  const [approvalExampleMessageId] = useState(() => generateUuid());
  const [backgroundExampleMessageId] = useState(() => generateUuid());
  const endpointHeadingId = useId();
  const examplesHeadingId = useId();
  const exampleTokenSelectId = useId();

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

  // cURL example for background execution: get the task handle immediately,
  // then poll it. Useful for runs that outlive a request timeout.
  const backgroundTaskCurlCode = useMemo(
    () => `# Start the run in the background — returns a task straight away
curl -X POST "${a2aEndpoint}" \\
  -H "Authorization: Bearer ${tokenForDisplay}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "jsonrpc": "2.0",
    "id": 5,
    "method": "SendMessage",
    "params": {
      "message": {
        "messageId": "${backgroundExampleMessageId}",
        "role": "ROLE_USER",
        "parts": [{"text": "Summarize every open PR in the repo."}]
      },
      "configuration": {"returnImmediately": true}
    }
  }'

# Poll it until status.state is TASK_STATE_COMPLETED.
# The answer arrives in artifacts[]; historyLength: 0 keeps the reply small.
curl -X POST "${a2aEndpoint}" \\
  -H "Authorization: Bearer ${tokenForDisplay}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "jsonrpc": "2.0",
    "id": 6,
    "method": "GetTask",
    "params": {"id": "<task.id from the reply>", "historyLength": 0}
  }'`,
    [a2aEndpoint, tokenForDisplay, backgroundExampleMessageId],
  );

  // cURL example for re-joining a running task's event stream.
  const subscribeCurlCode = useMemo(
    () => `# Re-join a running task — after a dropped stream, for example.
# A disconnect never cancels the run, so the task keeps going without you.
# The first frame is the task snapshot; live events follow until it settles.
curl -N -X POST "${a2aEndpoint}" \\
  -H "Authorization: Bearer ${tokenForDisplay}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "jsonrpc": "2.0",
    "id": 7,
    "method": "SubscribeToTask",
    "params": {"id": "<task.id>"}
  }'`,
    [a2aEndpoint, tokenForDisplay],
  );

  // cURL example for listing and cancelling tasks.
  const manageTasksCurlCode = useMemo(
    () => `# List this agent's tasks, newest status change first
curl -X POST "${a2aEndpoint}" \\
  -H "Authorization: Bearer ${tokenForDisplay}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "jsonrpc": "2.0",
    "id": 8,
    "method": "ListTasks",
    "params": {"pageSize": 20, "status": "TASK_STATE_WORKING"}
  }'

# Stop one. The task settles as TASK_STATE_CANCELED right away.
curl -X POST "${a2aEndpoint}" \\
  -H "Authorization: Bearer ${tokenForDisplay}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "jsonrpc": "2.0",
    "id": 9,
    "method": "CancelTask",
    "params": {"id": "<task.id>"}
  }'`,
    [a2aEndpoint, tokenForDisplay],
  );

  const chatDeepLinkBlock = (
    <div className="space-y-6">
      {/* Chat Deep Link */}
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <MessageCircle className="h-4 w-4 text-muted-foreground" />
          <Label className="text-sm font-medium">Chat Deep Link</Label>
        </div>
        <p className={CHANNEL_PROSE_CLASS}>
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
  // so the standalone A2A page doesn't repeat them here.
  const secondaryChannels = (
    <div className="space-y-6">
      {/* Chat app assignments live with the agent; provider credentials live in Settings. */}
      {canReadAgentTriggers && <AgentChatApps agent={agent} />}
    </div>
  );

  const curlExampleProps = {
    tokenForDisplay,
    isPersonalTokenSelected,
    hasAdminPermission: hasAdminPermission ?? false,
    selectedTeamToken: selectedTeamToken ?? null,
    fetchUserTokenMutation,
    fetchTeamTokenMutation,
  };

  if (layout === "detail") {
    return (
      <div className="space-y-4">
        <section
          aria-labelledby={examplesHeadingId}
          className="rounded-lg border bg-card"
        >
          <div className="space-y-1 p-4">
            <h3 id={examplesHeadingId} className="text-sm font-semibold">
              Call via API
            </h3>
            <p className="text-sm text-muted-foreground">
              Connect a custom integration through the Agent-to-Agent (A2A) API.
            </p>
          </div>

          <section
            aria-labelledby={endpointHeadingId}
            className="space-y-4 border-t p-4"
          >
            <h4 id={endpointHeadingId} className="text-sm font-semibold">
              Agent Endpoint
            </h4>
            <ConnectionUrlStep
              bare
              candidateUrls={candidateBaseUrls}
              metadata={connectionBaseUrls}
              value={connectionUrl}
              onChange={setUserBaseUrl}
            />
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
          </section>

          <section
            aria-labelledby="a2a-authentication-heading"
            className="space-y-4 border-t p-4"
          >
            <div className="space-y-1">
              <h4
                id="a2a-authentication-heading"
                className="text-sm font-semibold"
              >
                Authentication
              </h4>
              <p className="text-sm text-muted-foreground">
                A2A accepts platform tokens, OAuth access tokens, and configured
                identity-provider JWTs. LLM API keys are not accepted.{" "}
                <a
                  href={`${getDocsUrl(DocsPage.PlatformAgentTriggersWebhookA2a)}#authentication`}
                  target="_blank"
                  rel="noreferrer"
                  className="whitespace-nowrap underline hover:text-foreground"
                >
                  Learn more
                </a>
              </p>
            </div>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="space-y-1">
                <h5 className="text-xs font-medium">Platform tokens</h5>
                <p className="text-xs text-muted-foreground">
                  Use a personal token for your own integration, or a team or
                  organization token for shared access.
                </p>
              </div>
              <Button
                asChild
                variant="outline"
                size="sm"
                className="shrink-0 self-start"
              >
                <Link href={manageTokenLink.href}>
                  <KeyRound className="size-4" />
                  {manageTokenLink.label}
                </Link>
              </Button>
            </div>
            <div className="border-t pt-4">
              <McpOauthManagement
                resourceId={agent.id}
                resourceKind="agent"
                heading={{
                  title: "OAuth clients",
                  description:
                    "Register applications that call this agent as themselves or on behalf of signed-in users.",
                }}
              />
            </div>
          </section>

          <Collapsible className="border-t">
            <CollapsibleTrigger className="group flex w-full items-center justify-between gap-4 px-4 pb-1 pt-4 text-left transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
              <span className="text-sm font-semibold">Request examples</span>
              <ChevronDown className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
            </CollapsibleTrigger>
            <p className="px-4 pb-4 text-xs text-muted-foreground">
              Copy A2A requests for common integration workflows. The{" "}
              <a
                href={getDocsUrl(DocsPage.PlatformAgentTriggersWebhookA2a)}
                target="_blank"
                rel="noreferrer"
                className="underline hover:text-foreground"
              >
                A2A docs
              </a>{" "}
              cover every method.
            </p>
            <CollapsibleContent className="space-y-4 border-t px-4 pb-4 pt-4">
              <div className="space-y-2">
                <div className="space-y-1">
                  <Label htmlFor={exampleTokenSelectId}>
                    Token for examples
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    Select the platform token used when revealing or copying a
                    request.
                  </p>
                </div>
                <Select
                  value={effectiveTokenId}
                  onValueChange={setSelectedTokenId}
                >
                  <SelectTrigger
                    id={exampleTokenSelectId}
                    className="min-h-[60px] w-full py-2.5"
                  >
                    <SelectValue placeholder="Select token">
                      {effectiveTokenId && (
                        <div className="flex flex-col items-start gap-0.5 text-left">
                          <div>{getTokenDisplayName()}</div>
                          <div className="text-xs text-muted-foreground">
                            {isPersonalTokenSelected
                              ? "For your own integrations"
                              : selectedTeamToken?.isOrganizationToken
                                ? "Shared across the organization"
                                : "Shared with this team"}
                          </div>
                        </div>
                      )}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {userToken && (
                      <SelectItem value={PERSONAL_TOKEN_ID}>
                        <div className="flex flex-col items-start gap-0.5">
                          <div>Personal Token</div>
                          <div className="text-xs text-muted-foreground">
                            For your own integrations
                          </div>
                        </div>
                      </SelectItem>
                    )}
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
                            <div className="flex flex-col items-start gap-0.5">
                              <div>
                                {token.team?.name
                                  ? `Team Token (${token.team.name})`
                                  : token.name}
                              </div>
                              <div className="text-xs text-muted-foreground">
                                {unusable
                                  ? unusableTokenReason
                                  : "Shared with this team"}
                              </div>
                            </div>
                          </SelectItem>
                        );
                      })}
                    {tokens
                      ?.filter((token) => token.isOrganizationToken)
                      .map((token) => (
                        <SelectItem key={token.id} value={token.id}>
                          <div className="flex flex-col items-start gap-0.5">
                            <div>Organization Token</div>
                            <div className="text-xs text-muted-foreground">
                              Shared across the organization
                            </div>
                          </div>
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-3 border-t pt-4">
                <CurlExampleSection
                  key={`card-${effectiveTokenId}`}
                  code={agentCardCurlCode}
                  {...curlExampleProps}
                />
                <CurlExampleSection
                  key={`send-${effectiveTokenId}`}
                  code={curlCode}
                  {...curlExampleProps}
                />
                <CurlExampleSection
                  key={`stream-${effectiveTokenId}`}
                  code={streamingCurlCode}
                  {...curlExampleProps}
                />
                <Collapsible className="rounded-lg border">
                  <CollapsibleTrigger className="group flex w-full items-center justify-between px-4 py-3 text-left text-sm font-medium">
                    Continue the conversation
                    <ChevronDown className="size-4 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
                  </CollapsibleTrigger>
                  <CollapsibleContent className="px-4 pb-4">
                    <CurlExampleSection
                      key={`reply-${effectiveTokenId}`}
                      code={replyCurlCode}
                      {...curlExampleProps}
                    />
                  </CollapsibleContent>
                </Collapsible>
                <Collapsible className="rounded-lg border">
                  <CollapsibleTrigger className="group flex w-full items-center justify-between px-4 py-3 text-left text-sm font-medium">
                    Approve or deny tool calls
                    <ChevronDown className="size-4 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
                  </CollapsibleTrigger>
                  <CollapsibleContent className="px-4 pb-4">
                    <CurlExampleSection
                      key={`approval-${effectiveTokenId}`}
                      code={approvalCurlCode}
                      {...curlExampleProps}
                    />
                  </CollapsibleContent>
                </Collapsible>
                <Collapsible className="rounded-lg border">
                  <CollapsibleTrigger className="group flex w-full items-center justify-between px-4 py-3 text-left text-sm font-medium">
                    Run in the background
                    <ChevronDown className="size-4 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
                  </CollapsibleTrigger>
                  <CollapsibleContent className="px-4 pb-4">
                    <CurlExampleSection
                      key={`background-${effectiveTokenId}`}
                      code={backgroundTaskCurlCode}
                      {...curlExampleProps}
                    />
                  </CollapsibleContent>
                </Collapsible>
                <Collapsible className="rounded-lg border">
                  <CollapsibleTrigger className="group flex w-full items-center justify-between px-4 py-3 text-left text-sm font-medium">
                    Reconnect to a running task
                    <ChevronDown className="size-4 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
                  </CollapsibleTrigger>
                  <CollapsibleContent className="px-4 pb-4">
                    <CurlExampleSection
                      key={`subscribe-${effectiveTokenId}`}
                      code={subscribeCurlCode}
                      {...curlExampleProps}
                    />
                  </CollapsibleContent>
                </Collapsible>
                <Collapsible className="rounded-lg border">
                  <CollapsibleTrigger className="group flex w-full items-center justify-between px-4 py-3 text-left text-sm font-medium">
                    List and cancel tasks
                    <ChevronDown className="size-4 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
                  </CollapsibleTrigger>
                  <CollapsibleContent className="px-4 pb-4">
                    <CurlExampleSection
                      key={`manage-${effectiveTokenId}`}
                      code={manageTasksCurlCode}
                      {...curlExampleProps}
                    />
                  </CollapsibleContent>
                </Collapsible>
              </div>
            </CollapsibleContent>
          </Collapsible>
        </section>

        <section className="space-y-4 rounded-lg border bg-card p-4">
          <h3 className="text-sm font-semibold">
            Other ways to reach this agent
          </h3>
          {chatDeepLinkBlock}
          <div className="border-t pt-4">{secondaryChannels}</div>
        </section>
      </div>
    );
  }

  return (
    <div>
      <WizardStep n={1} title="Agent Endpoint">
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
            Use a platform token for direct A2A calls. OAuth access tokens and
            configured identity-provider JWTs are also accepted. LLM API keys
            and virtual keys will not work here.
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
                        ? "For your own integrations"
                        : selectedTeamToken?.isOrganizationToken
                          ? "Shared across the organization"
                          : "Shared with this team"}
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
                      For your own integrations
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
                            : "Shared with this team"}
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
                        Shared across the organization
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
          <Collapsible className="rounded-lg border">
            <CollapsibleTrigger className="group flex w-full items-center justify-between px-4 py-3 text-sm font-medium">
              Run in the background (long tasks)
              <ChevronDown className="h-4 w-4 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
            </CollapsibleTrigger>
            <CollapsibleContent className="px-4 pb-4">
              <CurlExampleSection
                key={`background-${effectiveTokenId}`}
                code={backgroundTaskCurlCode}
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
              Reconnect to a running task
              <ChevronDown className="h-4 w-4 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
            </CollapsibleTrigger>
            <CollapsibleContent className="px-4 pb-4">
              <CurlExampleSection
                key={`subscribe-${effectiveTokenId}`}
                code={subscribeCurlCode}
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
              List and cancel tasks
              <ChevronDown className="h-4 w-4 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
            </CollapsibleTrigger>
            <CollapsibleContent className="px-4 pb-4">
              <CurlExampleSection
                key={`manage-${effectiveTokenId}`}
                code={manageTasksCurlCode}
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
            Every method — streaming, background tasks, cancellation, artifacts,
            and tool approvals — is covered in the{" "}
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
      </div>
    </div>
  );
}

// ===
// Internal helpers
// ===

/**
 * The one line of prose each channel under "Other ways to reach this agent"
 * gets between its label and its copyable value. Shared so the three channels
 * cannot drift apart again.
 */
const CHANNEL_PROSE_CLASS = "text-xs text-muted-foreground";

/**
 * Connection base URLs carry a /v1 suffix (see getExternalProxyUrls); the A2A
 * protocol surface lives under /v2.
 */
function toA2ABaseUrl(connectionUrl: string): string {
  return connectionUrl.endsWith("/v1")
    ? `${connectionUrl.slice(0, -"/v1".length)}/v2`
    : `${connectionUrl}/v2`;
}
