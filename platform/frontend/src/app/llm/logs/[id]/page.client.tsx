"use client";

import {
  type archestraApiTypes,
  DynamicInteraction,
  isLockedChatUnavailableContent,
} from "@archestra/shared";
import { Database, Layers } from "lucide-react";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { BilledCost } from "@/components/billed-cost";
import { type DetailFact, DetailFacts } from "@/components/detail-facts";
import { JsonCodeBlock } from "@/components/json-code-block";
import { LoadingState } from "@/components/loading";
import { LockedChatContentUnavailable } from "@/components/locked-chat-content-unavailable";
import MessageThread from "@/components/message-thread";
import { PageBackLink } from "@/components/page-back-link";
import { PageLayout } from "@/components/page-layout";
import { QueryLoadError } from "@/components/query-load-error";
import { SourceBadge } from "@/components/source-badge";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { TooltipProvider } from "@/components/ui/tooltip";
import { describeKey } from "@/components/virtual-key-badge";
import { useProfiles } from "@/lib/agent.query";
import { typeRole } from "@/lib/design/type-scale";
import { useInteraction } from "@/lib/interactions/interaction.query";
import { cn, formatDate } from "@/lib/utils";

export function ChatPage({
  initialData,
  id,
}: {
  initialData?: {
    interaction: archestraApiTypes.GetInteractionResponses["200"] | undefined;
  };
  id: string;
}) {
  return (
    <ErrorBoundary>
      <LogDetail initialData={initialData} id={id} />
    </ErrorBoundary>
  );
}

function LogDetail({
  initialData,
  id,
}: {
  initialData?: {
    interaction: archestraApiTypes.GetInteractionResponses["200"] | undefined;
  };
  id: string;
}) {
  const {
    data: dynamicInteraction,
    isPending,
    isLoadingError,
    refetch,
  } = useInteraction({
    interactionId: id,
    initialData: initialData?.interaction,
  });

  const { data: agents } = useProfiles();

  // Header first, content second: this page owns its own chrome now, so the
  // loading and failure states keep the title and the way back rather than
  // dropping the reader onto a bare spinner.
  if (isPending) {
    return (
      <InteractionShell>
        <LoadingState label="Loading interaction…" />
      </InteractionShell>
    );
  }

  if (isLoadingError) {
    return (
      <InteractionShell>
        <QueryLoadError
          title="Couldn't load this interaction"
          onRetry={() => refetch()}
        />
      </InteractionShell>
    );
  }

  if (!dynamicInteraction) {
    return (
      <InteractionShell>
        <div className="text-muted-foreground">Interaction not found</div>
      </InteractionShell>
    );
  }

  const interaction = new DynamicInteraction(dynamicInteraction);
  const agent = agents?.find((a) => a.id === interaction.profileId);
  const toolsUsed = interaction.getToolNamesUsed();
  const toolsBlocked = interaction.getToolNamesRefused();
  const isDualLlmRelevant = interaction.isLastMessageToolCall();
  const lastToolCallId = interaction.getLastToolCallId();
  const allDualLlmAnalyses = dynamicInteraction.dualLlmAnalyses ?? [];
  const dualLlmResult = allDualLlmAnalyses.find(
    (r) => r.toolCallId === lastToolCallId,
  );

  const requestMessages = new DynamicInteraction(
    dynamicInteraction,
  ).mapToUiMessages(allDualLlmAnalyses);
  const chatErrors = dynamicInteraction.chatErrors ?? [];
  const authMethod = dynamicInteraction.authMethod
    ? formatAuthMethod(dynamicInteraction.authMethod)
    : null;
  // Both key columns, in the order they answer "who was this?": the
  // passthrough key carries the acting user's identity, the standard key only
  // supplied the provider credential.
  const virtualKeys = [
    dynamicInteraction.passthroughVirtualKey,
    dynamicInteraction.virtualKey,
  ].filter((key) => key != null);

  const backHref = dynamicInteraction.sessionId
    ? `/llm/logs/session/${encodeURIComponent(dynamicInteraction.sessionId)}`
    : "/llm/logs";
  const backLabel = dynamicInteraction.sessionId
    ? "Back to Session"
    : "Back to Sessions";

  const facts: DetailFact[] = [
    {
      label: "Tokens",
      value: (
        <div className="space-y-0.5">
          <div className="font-mono tabular-nums">
            {(dynamicInteraction.inputTokens ?? 0).toLocaleString()} in /{" "}
            {(dynamicInteraction.outputTokens ?? 0).toLocaleString()} out
          </div>
          {((dynamicInteraction.cacheReadTokens ?? 0) > 0 ||
            (dynamicInteraction.cacheWriteTokens ?? 0) > 0) && (
            <div className={cn(typeRole({ role: "meta" }), "font-mono")}>
              {(dynamicInteraction.cacheReadTokens ?? 0).toLocaleString()} cache
              read /{" "}
              {(dynamicInteraction.cacheWriteTokens ?? 0).toLocaleString()}{" "}
              cache write
            </div>
          )}
        </div>
      ),
    },
    {
      label: "Cost",
      value: dynamicInteraction.cost ? (
        <TooltipProvider>
          <BilledCost
            cost={dynamicInteraction.cost}
            billingMode={dynamicInteraction.billingMode}
            baselineCost={
              dynamicInteraction.baselineCost || dynamicInteraction.cost
            }
            toonCostSavings={dynamicInteraction.toonCostSavings}
            toonTokensBefore={dynamicInteraction.toonTokensBefore}
            toonTokensAfter={dynamicInteraction.toonTokensAfter}
            toonSkipReason={dynamicInteraction.toonSkipReason}
            format="percent"
            tooltip="always"
            variant="interaction"
            baselineModel={dynamicInteraction.baselineModel}
            actualModel={dynamicInteraction.model}
          />
        </TooltipProvider>
      ) : (
        <span className="font-mono tabular-nums">-</span>
      ),
    },
    { label: "Provider", value: interaction.provider },
    ...(dynamicInteraction.connectorId
      ? [
          {
            label: "KB connector",
            value: (
              <Badge variant="secondary" className="text-xs">
                {dynamicInteraction.connectorName ?? "Deleted connector"}
              </Badge>
            ),
          },
        ]
      : []),
    {
      label: "Timestamp",
      value: (
        <span className="font-mono tabular-nums">
          {formatDate({ date: interaction.createdAt })}
        </span>
      ),
    },
    ...(authMethod
      ? [{ label: "Auth method", value: <span>{authMethod}</span> }]
      : []),
    ...(virtualKeys.length > 0
      ? [
          {
            label: "Virtual API key",
            value: (
              <div className="space-y-1.5">
                {virtualKeys.map((key) => (
                  <div key={key.id} className="space-y-0.5">
                    <div className="font-mono">{key.name}</div>
                    <div className={typeRole({ role: "meta" })}>
                      {describeKey(key)}
                    </div>
                  </div>
                ))}
              </div>
            ),
          },
        ]
      : []),
    ...(dynamicInteraction.authenticatedAppName
      ? [
          {
            label: "OAuth client",
            value: (
              <div className="space-y-0.5">
                <div className="font-mono">
                  {dynamicInteraction.authenticatedAppName}
                </div>
                {dynamicInteraction.authenticatedAppId && (
                  <div className={cn(typeRole({ role: "meta" }), "font-mono")}>
                    {dynamicInteraction.authenticatedAppId}
                  </div>
                )}
              </div>
            ),
          },
        ]
      : []),
    ...(dynamicInteraction.externalAgentId
      ? [
          {
            label: "External agent",
            value: (
              <span className="font-mono">
                {dynamicInteraction.externalAgentId}
              </span>
            ),
          },
        ]
      : []),
    ...(dynamicInteraction.executionId
      ? [
          {
            label: "Execution ID",
            value: (
              <span className="font-mono">
                {dynamicInteraction.executionId}
              </span>
            ),
          },
        ]
      : []),
    {
      label: "Tools used",
      value:
        toolsUsed.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {toolsUsed.map((toolName) => (
              <Badge key={toolName} variant="secondary" className="text-xs">
                {toolName}
              </Badge>
            ))}
          </div>
        ) : (
          <span className="text-muted-foreground">None</span>
        ),
    },
    ...(toolsBlocked.length > 0
      ? [
          {
            label: "Tools blocked",
            value: (
              <div className="flex flex-wrap gap-1">
                {toolsBlocked.map((toolName) => (
                  <Badge
                    key={toolName}
                    variant="destructive"
                    className="text-xs"
                  >
                    {toolName}
                  </Badge>
                ))}
              </div>
            ),
          },
        ]
      : []),
    ...(isDualLlmRelevant
      ? [
          {
            label: "Dual LLM analysis",
            value: dualLlmResult ? (
              <Badge className="bg-green-600">Analyzed</Badge>
            ) : (
              <span className="text-muted-foreground">Not analyzed</span>
            ),
          },
        ]
      : []),
  ];

  return (
    <PageLayout
      title={<span className="font-mono">{interaction.modelName}</span>}
      documentTitle={interaction.modelName}
      backLink={<PageBackLink href={backHref}>{backLabel}</PageBackLink>}
      description={
        <div className="flex flex-wrap items-center gap-2">
          <SourceBadge source={dynamicInteraction.source} />
          <Badge variant="secondary" className="text-xs">
            {dynamicInteraction.source?.startsWith("knowledge:") ? (
              <>
                <Database className="h-3 w-3 mr-1" />
                <span>Knowledge Base</span>
              </>
            ) : (
              <>
                <Layers className="h-3 w-3 mr-1" />
                <span>
                  {agent?.name ??
                    (interaction.profileId === null
                      ? "Deleted LLM Proxy"
                      : "Unknown")}
                </span>
              </>
            )}
          </Badge>
        </div>
      }
    >
      <div className="space-y-8">
        <DetailFacts facts={facts} className="border-b pb-6" />

        {requestMessages.length > 0 && (
          <div className="mb-8">
            <h2 className="text-xl font-semibold mb-4">Conversation</h2>
            <div className="border border-border rounded-lg bg-background overflow-hidden">
              <MessageThread
                messages={requestMessages}
                chatErrors={chatErrors}
                conversationId={dynamicInteraction.sessionId ?? undefined}
                containerClassName="h-auto"
                hideDivider={true}
                profileId={agent?.id}
                agentName={agent?.name ?? undefined}
                selectedModel={interaction.modelName}
                unsafeContextBoundary={dynamicInteraction.unsafeContextBoundary}
              />
            </div>
          </div>
        )}

        <div>
          <h2 className="text-xl font-semibold mb-4">Raw Data</h2>
          <Accordion type="single" collapsible defaultValue="response">
            <AccordionItem value="request" className="border rounded-lg mb-2">
              <AccordionTrigger className="px-6 py-4 hover:no-underline">
                <span className="text-base font-semibold">
                  Raw Request (Original)
                </span>
              </AccordionTrigger>
              <AccordionContent className="px-6 pb-4">
                {isLockedChatUnavailableContent(dynamicInteraction.request) ? (
                  <LockedChatContentUnavailable
                    value={dynamicInteraction.request}
                  />
                ) : (
                  <JsonCodeBlock value={dynamicInteraction.request} />
                )}
              </AccordionContent>
            </AccordionItem>

            {dynamicInteraction.processedRequest && (
              <AccordionItem
                value="processedRequest"
                className="border rounded-lg mb-2"
              >
                <AccordionTrigger className="px-6 py-4 hover:no-underline">
                  <span className="text-base font-semibold">
                    Processed Request (Sent to LLM)
                  </span>
                </AccordionTrigger>
                <AccordionContent className="px-6 pb-4">
                  {isLockedChatUnavailableContent(
                    dynamicInteraction.processedRequest,
                  ) ? (
                    <LockedChatContentUnavailable
                      value={dynamicInteraction.processedRequest}
                    />
                  ) : (
                    <JsonCodeBlock
                      value={dynamicInteraction.processedRequest}
                    />
                  )}
                  <p className="text-xs text-muted-foreground mt-2">
                    This shows the request after processing (e.g., TOON
                    conversion, trusted data filtering, etc.)
                  </p>
                </AccordionContent>
              </AccordionItem>
            )}

            <AccordionItem
              value="response"
              className="border rounded-lg !border-b"
            >
              <AccordionTrigger className="px-6 py-4 hover:no-underline">
                <span className="text-base font-semibold">Raw Response</span>
              </AccordionTrigger>
              <AccordionContent className="px-6 pb-4">
                {isLockedChatUnavailableContent(dynamicInteraction.response) ? (
                  <LockedChatContentUnavailable
                    value={dynamicInteraction.response}
                  />
                ) : (
                  <JsonCodeBlock value={dynamicInteraction.response} />
                )}
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        </div>
      </div>
    </PageLayout>
  );
}

type InteractionAuthMethod = NonNullable<
  archestraApiTypes.GetInteractionResponses["200"]["authMethod"]
>;

function formatAuthMethod(authMethod: InteractionAuthMethod) {
  switch (authMethod) {
    case "oauth_client_credentials":
      return "OAuth Client Credentials";
    case "oauth_user":
      return "OAuth User";
    case "virtual_key":
      return "Virtual Key";
    case "passthrough_virtual_key":
      return "Passthrough Virtual Key";
    case "provider_key":
      return "Provider Key";
    case "jwks":
      return "JWKS";
    case "internal":
      return "Internal";
    default:
      return authMethod;
  }
}

/**
 * The page's header while there is no interaction to name it with. The back
 * link goes to the session list rather than to a session: which session this
 * request belongs to is a field of the record that has not loaded.
 */
function InteractionShell({ children }: { children: React.ReactNode }) {
  return (
    <PageLayout
      title="Request"
      backLink={<PageBackLink href="/llm/logs">Back to Sessions</PageBackLink>}
    >
      {children}
    </PageLayout>
  );
}
