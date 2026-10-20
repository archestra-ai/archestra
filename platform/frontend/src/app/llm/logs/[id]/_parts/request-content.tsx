"use client";

import {
  type archestraApiTypes,
  DynamicInteraction,
  isEncryptedChatUnavailableContent,
  isLogContentNotStored,
} from "@archestra/shared";
import {
  Braces,
  Download,
  MessageSquareText,
  ShieldAlert,
  TriangleAlert,
} from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { CopyButton } from "@/components/copy-button";
import { EncryptedChatContentUnavailable } from "@/components/encrypted-chat-content-unavailable";
import { JsonCodeBlock } from "@/components/json-code-block";
import { PaneHeader } from "@/components/log-detail/pane-header";
import { PayloadSection } from "@/components/log-detail/tool-result-view";
import MessageThread from "@/components/message-thread";
import { QueryLoadError } from "@/components/query-load-error";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { describeKey } from "@/components/virtual-key-badge";
import { useInteraction } from "@/lib/interactions/interaction.query";
import { formatDate } from "@/lib/utils/date-time";
import { cn } from "@/lib/utils/tailwind";
import { GhostThread, OverviewFact } from "./overview-parts";
import { PayloadTree } from "./payload-tree";
import { type RequestSpan, SPAN_KINDS } from "./session-timeline";

/**
 * The right column for a selected request: what it said and what came back,
 * as the conversation thread or as the raw payloads, plus who sent it. It
 * loads the request's full record itself; the list only carries summaries.
 */
export function RequestContent({
  span,
  label,
  profileName,
  latest,
  onJumpToLatest,
}: {
  span: RequestSpan;
  label: string;
  profileName: string | null;
  /** The session's latest request, whose thread is the whole conversation. */
  latest: boolean;
  onJumpToLatest: (() => void) | null;
}) {
  const [view, setView] = useState<ContentView>("conversation");
  const { row, kind } = span;
  const time = formatDate({ date: row.createdAt, dateFormat: "HH:mm:ss" });
  const query = useInteraction({
    interactionId: row.id,
    refetchInterval: null,
  });
  const record = query.data ?? null;

  return (
    <Tabs
      value={view}
      onValueChange={(next) => setView(next as ContentView)}
      className="flex min-h-[320px] min-w-0 flex-col gap-0 lg:min-h-0"
      asChild
    >
      <section aria-label="Request content">
        <PaneHeader className="gap-3">
          {/* Underlined text tabs sized like the Overview header beside them:
              a pill switcher is taller than this 36px bar and reads as a
              control panel rather than a pane title. */}
          <TabsList
            aria-label="Request view"
            className="h-full shrink-0 gap-4 rounded-none bg-transparent p-0"
          >
            {CONTENT_VIEWS.map((option) => (
              <TabsTrigger
                key={option.value}
                value={option.value}
                className="relative h-full flex-none rounded-none border-0 px-0 text-xs font-medium text-muted-foreground shadow-none after:absolute after:inset-x-0 after:-bottom-px after:h-0.5 after:rounded-full hover:text-foreground data-[state=active]:bg-transparent data-[state=active]:text-foreground data-[state=active]:shadow-none data-[state=active]:after:bg-foreground dark:text-muted-foreground dark:data-[state=active]:border-transparent dark:data-[state=active]:bg-transparent dark:data-[state=active]:text-foreground"
              >
                {option.label}
              </TabsTrigger>
            ))}
          </TabsList>
          {/* Which request this is; phones already show it in the Overview
              directly above, so the bar keeps only the tabs there. */}
          <span className="ml-auto inline-flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground max-md:hidden">
            <span
              className={cn(
                "size-1.5 shrink-0 rounded-full",
                SPAN_KINDS[kind].bar,
              )}
              aria-hidden="true"
            />
            <span className="min-w-0 truncate">{label}</span>
            <span className="shrink-0 tabular-nums">· {time}</span>
            {latest ? <span className="shrink-0">· latest</span> : null}
          </span>
        </PaneHeader>
        {/* Phones stack the pane at its natural height, and one captured
          prompt can run to thousands of lines: cap it near a screenful so
          the page stays scannable. */}
        <div className="max-lg:max-h-[70svh] max-lg:overflow-y-auto max-lg:overscroll-contain lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
          {query.isError && !record ? (
            <QueryLoadError
              title="Couldn't load this request"
              error={query.error}
              onRetry={() => query.refetch()}
              className="py-10"
            />
          ) : query.isSuccess && !record ? (
            <p className="px-4 py-10 text-center text-sm text-muted-foreground">
              This request is no longer available.
            </p>
          ) : !record ? (
            <PayloadSkeleton />
          ) : (
            <>
              <TabsContent value="conversation">
                <ConversationView
                  record={record}
                  auxiliary={kind === "auxiliary"}
                  label={label}
                  profileName={profileName}
                  latest={latest}
                  onShowRequest={() => setView("request")}
                  onJumpToLatest={onJumpToLatest}
                />
              </TabsContent>
              <TabsContent value="request">
                <RequestView record={record} />
              </TabsContent>
              <TabsContent value="response">
                <ResponseView record={record} />
              </TabsContent>
            </>
          )}
        </div>
      </section>
    </Tabs>
  );
}

// ============================================================================
// Internal helpers
// ============================================================================

type InteractionRecord = archestraApiTypes.GetInteractionResponses["200"];

const CONTENT_VIEWS = [
  { value: "conversation", label: "Conversation" },
  { value: "request", label: "Request" },
  { value: "response", label: "Response" },
] as const;

type ContentView = (typeof CONTENT_VIEWS)[number]["value"];

function ConversationView({
  record,
  auxiliary,
  label,
  profileName,
  latest,
  onShowRequest,
  onJumpToLatest,
}: {
  record: InteractionRecord;
  auxiliary: boolean;
  label: string;
  profileName: string | null;
  latest: boolean;
  onShowRequest: () => void;
  onJumpToLatest: (() => void) | null;
}) {
  const thread = useMemo(() => {
    const interaction = new DynamicInteraction(record);
    return {
      messages: interaction.mapToUiMessages(),
      modelName: interaction.modelName,
    };
  }, [record]);

  if (thread.messages.length === 0) {
    return (
      <div className="flex min-h-full flex-col items-center justify-center px-6 py-10 text-center">
        <GhostThread />
        <div className="mt-5 space-y-1.5">
          <p className="text-sm font-medium">
            No conversation was captured for this request
          </p>
          <p className="mx-auto max-w-[52ch] text-xs leading-relaxed text-muted-foreground">
            The Request and Response views show what was recorded for it.
          </p>
        </div>
        <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
          <Button size="sm" variant="outline" onClick={onShowRequest}>
            <Braces />
            <span>Show request</span>
          </Button>
          {!latest && onJumpToLatest ? (
            <Button size="sm" variant="outline" onClick={onJumpToLatest}>
              <MessageSquareText />
              <span>Jump to latest conversation</span>
            </Button>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <>
      {auxiliary ? (
        <div className="px-4 pt-3">
          <InlineNotice variant="warning">
            <TriangleAlert />
            <InlineNoticeText>
              This was a side request ({label}), so this is its prompt, not the
              main chat thread.
            </InlineNoticeText>
          </InlineNotice>
        </div>
      ) : null}
      <MessageThread
        messages={thread.messages}
        chatErrors={record.chatErrors ?? []}
        conversationId={record.sessionId ?? undefined}
        containerClassName="h-auto"
        hideDivider
        agentName={profileName ?? undefined}
        selectedModel={thread.modelName}
      />
    </>
  );
}

/**
 * Who sent the request, the tools its conversation had used so far, then the
 * request as received and as forwarded.
 */
function RequestView({ record }: { record: InteractionRecord }) {
  const [forwarded, setForwarded] = useState(false);
  const toolNames = useMemo(
    () =>
      isEncryptedChatUnavailableContent(record.request)
        ? []
        : new DynamicInteraction(record).getToolNamesUsed(),
    [record],
  );
  const processed = record.processedRequest ?? null;
  const shown = forwarded && processed !== null ? processed : record.request;
  const virtualKeys = [record.passthroughVirtualKey, record.virtualKey].filter(
    (key) => key != null,
  );

  return (
    <div className="space-y-4 px-4 pt-2 pb-4">
      <PayloadSection title="Metadata">
        <dl className="max-w-xl">
          <OverviewFact label="Recorded">
            {formatDate({ date: record.createdAt })}
          </OverviewFact>
          {record.authMethod ? (
            <OverviewFact label="Auth method">
              {formatAuthMethod(record.authMethod)}
            </OverviewFact>
          ) : null}
          {/* The passthrough key carries the acting user's identity, the
              standard key only supplied the provider credential. */}
          {virtualKeys.map((key) => (
            <OverviewFact key={key.id} label="Virtual API key">
              <span className="min-w-0">
                <span className="block truncate font-mono">{key.name}</span>
                <span className="block truncate text-[11px] text-muted-foreground">
                  {describeKey(key)}
                </span>
              </span>
            </OverviewFact>
          ))}
          {record.authenticatedAppName ? (
            <OverviewFact label="OAuth client">
              <span
                className="truncate font-mono"
                title={record.authenticatedAppId ?? undefined}
              >
                {record.authenticatedAppName}
              </span>
            </OverviewFact>
          ) : null}
          {record.externalAgentId ? (
            <OverviewFact label="External agent">
              <IdValue value={record.externalAgentId} />
            </OverviewFact>
          ) : null}
          {record.runId ? (
            <OverviewFact label="Run ID">
              <IdValue value={record.runId} />
            </OverviewFact>
          ) : null}
          {record.connectorId ? (
            <OverviewFact label="KB connector">
              {record.connectorName ?? "Deleted connector"}
            </OverviewFact>
          ) : null}
        </dl>
      </PayloadSection>
      {toolNames.length > 0 ? (
        <PayloadSection
          title="Tools used"
          meta={toolNames.length === 1 ? "1 tool" : `${toolNames.length} tools`}
        >
          <div className="flex flex-wrap gap-1">
            {toolNames.map((name) => (
              <Badge
                key={name}
                variant="secondary"
                className="font-mono text-xs"
              >
                {name}
              </Badge>
            ))}
          </div>
        </PayloadSection>
      ) : null}
      <Payload
        title="Request"
        value={shown}
        fileName={
          forwarded && processed !== null
            ? `request-sent-to-model-${record.id}`
            : `request-${record.id}`
        }
        meta={
          forwarded && processed !== null
            ? "After policy updates, as sent to the model"
            : null
        }
        actions={
          processed !== null ? (
            <fieldset
              aria-label="Request version"
              className="inline-flex rounded-md border bg-muted/40 p-px"
            >
              <VersionButton
                pressed={!forwarded}
                onClick={() => setForwarded(false)}
              >
                Original
              </VersionButton>
              <VersionButton
                pressed={forwarded}
                onClick={() => setForwarded(true)}
              >
                Sent to model
              </VersionButton>
            </fieldset>
          ) : null
        }
      />
    </div>
  );
}

/** How the call ended, and the raw response. */
function ResponseView({ record }: { record: InteractionRecord }) {
  const response = record.response;
  const failure = readFailure(response);
  const block = record.toolCallBlock ?? null;

  return (
    <div className="space-y-4 px-4 pt-2 pb-4">
      {failure ? (
        <InlineNotice variant="error">
          <TriangleAlert />
          <span className="font-medium">The provider call failed</span>
          {failure.message ? (
            <InlineNoticeText className="break-words">
              {failure.message}
            </InlineNoticeText>
          ) : null}
        </InlineNotice>
      ) : null}
      {block ? (
        <InlineNotice variant="warning">
          <ShieldAlert />
          <span className="font-medium">
            {block.blockedToolCallCount === 1
              ? "Guardrails blocked 1 tool call"
              : `Guardrails blocked ${block.blockedToolCallCount} tool calls`}
          </span>
          <InlineNoticeText className="break-words">
            {block.reason}
          </InlineNoticeText>
        </InlineNotice>
      ) : null}
      <Payload
        title="Response"
        value={response}
        fileName={`response-${record.id}`}
      />
    </div>
  );
}

/** One payload as a tree or raw JSON, or the reason it is not there. */
function Payload({
  title,
  value,
  fileName,
  meta = null,
  actions,
}: {
  title: string;
  value: unknown;
  /** The download's name, without the extension. */
  fileName: string;
  meta?: string | null;
  actions?: ReactNode;
}) {
  const [layout, setLayout] = useState<PayloadLayout>("tree");
  const json = useMemo(() => JSON.stringify(value, null, 2) ?? "", [value]);

  if (isEncryptedChatUnavailableContent(value)) {
    return (
      <PayloadSection title={title} actions={actions}>
        <EncryptedChatContentUnavailable value={value} className="mt-0" />
      </PayloadSection>
    );
  }
  return (
    <PayloadSection
      title={title}
      meta={meta}
      actions={
        <>
          {actions}
          <fieldset
            aria-label="Payload layout"
            className="inline-flex rounded-md border bg-muted/40 p-px"
          >
            <VersionButton
              pressed={layout === "tree"}
              onClick={() => setLayout("tree")}
            >
              Tree
            </VersionButton>
            <VersionButton
              pressed={layout === "raw"}
              onClick={() => setLayout("raw")}
            >
              Raw
            </VersionButton>
          </fieldset>
          <CopyButton text={json} size={12} />
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={`Download ${title.toLowerCase()} JSON`}
            title="Download JSON"
            onClick={() => downloadJson(json, fileName)}
          >
            <Download className="size-3" />
          </Button>
        </>
      }
    >
      {layout === "tree" ? (
        // Keyed by the payload, so switching between the original and the
        // forwarded request opens the new one fresh instead of keeping the
        // folds of the old one.
        <PayloadTree key={fileName} value={value} />
      ) : json.length > RAW_HIGHLIGHT_LIMIT ? (
        // Highlighting tokenizes the whole text up front, about three
        // seconds a megabyte; plain text lays out in a fraction of that.
        <pre className="max-h-[640px] overflow-auto rounded-lg border bg-background px-3 py-2 font-mono text-xs leading-5 break-all whitespace-pre-wrap">
          {json}
        </pre>
      ) : (
        <JsonCodeBlock
          value={value}
          variant="pane"
          maxHeightClassName="max-h-[640px] overflow-auto"
        />
      )}
    </PayloadSection>
  );
}

type PayloadLayout = "tree" | "raw";

/** Above this many characters the raw view drops syntax highlighting. */
const RAW_HIGHLIGHT_LIMIT = 100_000;

function downloadJson(json: string, fileName: string) {
  const url = URL.createObjectURL(
    new Blob([json], { type: "application/json" }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${fileName}.json`;
  anchor.style.display = "none";
  document.body.append(anchor);
  anchor.click();
  // Revoked on a delay: the browser reads the blob after the click, and
  // revoking at once can truncate a large file.
  setTimeout(() => {
    anchor.remove();
    URL.revokeObjectURL(url);
  }, 10_000);
}

function VersionButton({
  pressed,
  onClick,
  children,
}: {
  pressed: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Button
      variant="ghost"
      size="xs"
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        "font-normal text-muted-foreground",
        pressed && "bg-background text-foreground shadow-xs",
      )}
    >
      <span>{children}</span>
    </Button>
  );
}

function IdValue({ value }: { value: string }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-0.5">
      <span className="truncate font-mono text-[11px]" title={value}>
        {value}
      </span>
      <CopyButton text={value} size={11} />
    </span>
  );
}

function PayloadSkeleton() {
  return (
    <div className="space-y-3 px-4 py-4" aria-hidden="true">
      <Skeleton className="h-3 w-24" />
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-3 w-32" />
      <Skeleton className="h-40 w-full" />
    </div>
  );
}

/**
 * Whether the provider call failed, and what it said: the proxy stores a
 * failure as `{ error: string }`, and Metadata only keeps just that outcome
 * on the not-stored marker.
 */
function readFailure(response: unknown): { message: string | null } | null {
  if (isLogContentNotStored(response)) {
    return response.isError === true ? { message: null } : null;
  }
  if (
    typeof response === "object" &&
    response !== null &&
    typeof (response as { error?: unknown }).error === "string"
  ) {
    return { message: (response as { error: string }).error };
  }
  return null;
}

function formatAuthMethod(
  authMethod: NonNullable<InteractionRecord["authMethod"]>,
): string {
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
    case "personal_token":
      return "Personal Token";
    case "internal":
      return "Internal";
    default:
      return authMethod;
  }
}
