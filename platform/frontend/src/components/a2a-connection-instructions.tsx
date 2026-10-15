"use client";

import {
  type archestraApiTypes,
  DocsPage,
  getDocsUrl,
} from "@archestra/shared";
import { ChevronDown, Copy, MessageCircle } from "lucide-react";
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
import { CurlExampleSection } from "@/components/curl-example-section";
import { McpOauthManagement } from "@/components/mcp-oauth-management";
import { SECRET_PLACEHOLDER_TOKEN } from "@/components/secret-copy-button";
import {
  SettingsSection,
  SettingsSectionGroup,
} from "@/components/settings-section";
import { ServiceAccountHint } from "@/components/tokens/service-account-hint";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Label } from "@/components/ui/label";
import { WizardStep } from "@/components/wizard-step";
import { copyToClipboard } from "@/lib/clipboard";
import config from "@/lib/config/config";
import { useOrganization } from "@/lib/organization.query";
import { useFetchUserTokenValue, useUserToken } from "@/lib/user-token.query";
import { generateUuid } from "@/lib/uuid";

type InternalAgent = archestraApiTypes.GetAllAgentsResponses["200"][number];

interface A2AConnectionInstructionsProps {
  agent: InternalAgent;
  layout: "page" | "detail";
}

export function A2AConnectionInstructions({
  agent,
  layout,
}: A2AConnectionInstructionsProps) {
  const { data: userToken } = useUserToken();

  // messageId is required by the A2A protocol and must be unique per message,
  // so each example gets a real UUID (fresh per mount).
  const [sendExampleMessageId] = useState(() => generateUuid());
  const [streamExampleMessageId] = useState(() => generateUuid());
  const [replyExampleMessageId] = useState(() => generateUuid());
  const [approvalExampleMessageId] = useState(() => generateUuid());
  const [backgroundExampleMessageId] = useState(() => generateUuid());

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

  const fetchUserTokenMutation = useFetchUserTokenValue();

  // The A2A protocol surface (SendMessage / SendStreamingMessage / the
  // agent-card.json card) lives under /v2.
  const a2aEndpoint = `${toA2ABaseUrl(connectionUrl)}/a2a/${agent.id}`;

  // The examples are written with the caller's own token, masked.
  const tokenForDisplay = userToken
    ? `${userToken.tokenStart}***`
    : SECRET_PLACEHOLDER_TOKEN;

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

  // cURL example for Agent Runtime: get the task handle immediately,
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

  const curlExampleProps = {
    tokenForDisplay,
    hasPersonalToken: !!userToken,
    fetchUserTokenMutation,
  };

  // The caller's own token, masked. Not the block's own copy button: what is
  // on screen is masked, and what belongs on the clipboard is the real value.
  const personalTokenBlock = (
    <CodeBlock
      code={tokenForDisplay}
      language="text"
      wrapLongLines
      contentClassName="overflow-x-hidden"
      contentStyle={{
        fontSize: "0.75rem",
        paddingRight: "3.5rem",
      }}
    >
      <div className="overflow-hidden rounded-md border bg-background/95 shadow-sm backdrop-blur supports-[backdrop-filter]:bg-background/80">
        <Button
          variant="ghost"
          size="icon"
          className="rounded-none"
          aria-label="Copy your platform token"
          disabled={!userToken}
          onClick={async () => {
            const value = (await fetchUserTokenMutation.mutateAsync())?.value;
            if (!value) {
              toast.error("Failed to fetch token");
              return;
            }
            await copyToClipboard(value);
            toast.success("Token copied");
          }}
        >
          <Copy className="size-4" />
        </Button>
      </div>
    </CodeBlock>
  );

  if (layout === "detail") {
    return (
      <SettingsSectionGroup>
        <SettingsSection
          title="Endpoint"
          description="The URL a client calls to reach this agent."
        >
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
        </SettingsSection>

        <SettingsSection
          title="Authentication"
          description={
            <>
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
            </>
          }
        >
          <div className="space-y-2">
            {personalTokenBlock}
            <ServiceAccountHint />
          </div>
        </SettingsSection>

        <SettingsSection
          title="OAuth clients"
          description="Applications that call this agent as themselves, or on behalf of a signed-in user."
        >
          <McpOauthManagement resourceId={agent.id} resourceKind="agent" />
        </SettingsSection>

        <SettingsSection
          title="Examples"
          description={
            <>
              Requests for common workflows, and the link that opens a chat. The{" "}
              <a
                href={getDocsUrl(DocsPage.PlatformAgentTriggersWebhookA2a)}
                target="_blank"
                rel="noreferrer"
                className="underline hover:text-foreground"
              >
                A2A docs
              </a>{" "}
              cover every method.
            </>
          }
        >
          {/* No outer fold: the section is already named, and a box whose
              closed state was one line of text made the reader open something
              to find out what the section they had opened contained. The bulk
              still folds — each request below is its own disclosure. */}
          <div className="space-y-4">
            <div className="space-y-3">
              <CurlExampleSection
                code={agentCardCurlCode}
                {...curlExampleProps}
              />
              <CurlExampleSection code={curlCode} {...curlExampleProps} />
              <CurlExampleSection
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
                    code={manageTasksCurlCode}
                    {...curlExampleProps}
                  />
                </CollapsibleContent>
              </Collapsible>
            </div>
            {chatDeepLinkBlock}
          </div>
        </SettingsSection>
      </SettingsSectionGroup>
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
          {personalTokenBlock}
          <p className="text-xs text-muted-foreground">
            <Link
              href="/account?highlight=personal-token"
              className="underline hover:text-foreground"
            >
              Manage your personal token
            </Link>
          </p>
          <ServiceAccountHint />
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
          <CurlExampleSection code={agentCardCurlCode} {...curlExampleProps} />
          <CurlExampleSection code={curlCode} {...curlExampleProps} />
          <CurlExampleSection code={streamingCurlCode} {...curlExampleProps} />
          <Collapsible className="rounded-lg border">
            <CollapsibleTrigger className="group flex w-full items-center justify-between px-4 py-3 text-sm font-medium">
              Continue the conversation (multi-turn)
              <ChevronDown className="h-4 w-4 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
            </CollapsibleTrigger>
            <CollapsibleContent className="px-4 pb-4">
              <CurlExampleSection code={replyCurlCode} {...curlExampleProps} />
            </CollapsibleContent>
          </Collapsible>
          <Collapsible className="rounded-lg border">
            <CollapsibleTrigger className="group flex w-full items-center justify-between px-4 py-3 text-sm font-medium">
              Approve or deny tool calls
              <ChevronDown className="h-4 w-4 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
            </CollapsibleTrigger>
            <CollapsibleContent className="px-4 pb-4">
              <CurlExampleSection
                code={approvalCurlCode}
                {...curlExampleProps}
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
                code={backgroundTaskCurlCode}
                {...curlExampleProps}
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
                code={subscribeCurlCode}
                {...curlExampleProps}
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
                code={manageTasksCurlCode}
                {...curlExampleProps}
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
