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
  Info,
  MessageSquareText,
  ShieldAlert,
  TriangleAlert,
} from "lucide-react";
import {
  type ReactNode,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
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
import { GhostThread, OverviewCell } from "./overview-parts";
import { PayloadTree } from "./payload-tree";
import {
  type RequestKind,
  type RequestSpan,
  shortToolName,
} from "./session-timeline";

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
  const query = useInteraction({
    interactionId: row.id,
    refetchInterval: null,
  });
  const record = query.data ?? null;
  // Each request resends the conversation so far, so its top matches the
  // last one's: the conversation opens at the bottom, where what this request
  // added is. The payload tabs read top-down, so they open at the top. Once
  // per request and tab, so a refetch never moves the reader.
  const scrollerRef = useRef<HTMLDivElement>(null);
  const scrolledFor = useRef<string | null>(null);
  const loaded = record !== null;
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    const position = `${row.id}:${view}`;
    if (!loaded || !scroller || scrolledFor.current === position) return;
    scrolledFor.current = position;
    if (view !== "conversation") {
      scroller.scrollTop = 0;
      return;
    }
    return pinToBottom(scroller);
  }, [loaded, row.id, view]);

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
        </PaneHeader>
        {/* Phones stack the pane at its natural height, and one captured
          prompt can run to thousands of lines: cap it near a screenful so
          the page stays scannable. */}
        <div
          ref={scrollerRef}
          className="max-lg:max-h-[70svh] max-lg:overflow-y-auto max-lg:overscroll-contain lg:min-h-0 lg:flex-1 lg:overflow-y-auto"
        >
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
                  kind={kind}
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
  kind,
  label,
  profileName,
  latest,
  onShowRequest,
  onJumpToLatest,
}: {
  record: InteractionRecord;
  /** Side requests and sub-agents carry their own prompt, not the thread. */
  kind: RequestKind;
  label: string;
  profileName: string | null;
  latest: boolean;
  onShowRequest: () => void;
  onJumpToLatest: (() => void) | null;
}) {
  const thread = useMemo(() => {
    const interaction = new DynamicInteraction(record);
    return {
      messages: interaction.mapToUiMessages().map(fenceJsonReplies),
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
      {kind !== "main" ? (
        <p className="flex items-center gap-1.5 px-4 pt-3 text-xs text-muted-foreground">
          <Info className="size-3.5 shrink-0" aria-hidden="true" />
          <span>
            {kind === "subagent" ? "Sub-agent" : "Side request"} ({label}): its
            own prompt, not the main conversation.
          </span>
        </p>
      ) : null}
      <MessageThread
        messages={thread.messages}
        chatErrors={record.chatErrors ?? []}
        conversationId={record.sessionId ?? undefined}
        containerClassName="h-auto"
        hideDivider
        agentName={profileName ?? undefined}
        selectedModel={thread.modelName}
        openPendingTools
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
        <dl className="grid max-w-4xl grid-cols-1 gap-x-6 gap-y-2.5 sm:grid-cols-2 xl:grid-cols-3">
          <OverviewCell label="Recorded">
            {formatDate({ date: record.createdAt })}
          </OverviewCell>
          {record.authMethod ? (
            <OverviewCell label="Auth method">
              {formatAuthMethod(record.authMethod)}
            </OverviewCell>
          ) : null}
          {/* The passthrough key carries the acting user's identity, the
              standard key only supplied the provider credential. */}
          {virtualKeys.map((key) => (
            <OverviewCell key={key.id} label="Virtual API key">
              <span className="min-w-0">
                <span className="block truncate font-mono">{key.name}</span>
                <span className="block truncate text-[11px] text-muted-foreground">
                  {describeKey(key)}
                </span>
              </span>
            </OverviewCell>
          ))}
          {record.authenticatedAppName ? (
            <OverviewCell label="OAuth client">
              <span
                className="truncate font-mono"
                title={record.authenticatedAppId ?? undefined}
              >
                {record.authenticatedAppName}
              </span>
            </OverviewCell>
          ) : null}
          {record.externalAgentId ? (
            <OverviewCell label="External agent">
              <IdValue value={record.externalAgentId} />
            </OverviewCell>
          ) : null}
          {record.runId ? (
            <OverviewCell label="Run ID">
              <IdValue value={record.runId} />
            </OverviewCell>
          ) : null}
          {record.connectorId ? (
            <OverviewCell label="KB connector">
              {record.connectorName ?? "Deleted connector"}
            </OverviewCell>
          ) : null}
        </dl>
      </PayloadSection>
      {toolNames.length > 0 ? <ToolsUsed toolNames={toolNames} /> : null}
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

/**
 * A reply that is a bare JSON document (a title or a structured answer) reads
 * as a run-on line of braces in prose; fenced, it renders as code.
 */
function fenceJsonReplies<
  T extends { role: string; parts: Array<{ type: string }> },
>(message: T): T {
  if (message.role !== "assistant") return message;
  return {
    ...message,
    parts: message.parts.map((part) => {
      if (part.type !== "text") return part;
      const text = (part as { text?: unknown }).text;
      if (typeof text !== "string") return part;
      const trimmed = text.trim();
      if (!/^[[{]/.test(trimmed)) return part;
      try {
        const parsed = JSON.parse(trimmed);
        return {
          ...part,
          text: `\`\`\`json\n${JSON.stringify(parsed, null, 2)}\n\`\`\``,
        };
      } catch {
        return part;
      }
    }),
  };
}

/**
 * The tools the conversation had used so far, as one flowing list: the tool
 * leads, its MCP server a faint path prefix. A long list folds after a few
 * lines, since an agent loop can reach a hundred.
 */
function ToolsUsed({ toolNames }: { toolNames: string[] }) {
  const [all, setAll] = useState(false);
  const items = useMemo(() => toolItems(toolNames), [toolNames]);
  const shown = all ? items : items.slice(0, TOOLS_USED_FOLDED);
  return (
    <PayloadSection
      title="Tools used"
      meta={items.length === 1 ? "1 tool" : `${items.length} tools`}
    >
      <ul className="flex max-w-4xl flex-wrap gap-x-4 gap-y-1.5 font-mono text-[12px]">
        {shown.map((item) => (
          <li key={item.key} className="whitespace-nowrap">
            {item.server ? (
              <span className="text-muted-foreground/60">{item.server}/</span>
            ) : null}
            <span className="text-foreground/90">{item.tool}</span>
          </li>
        ))}
        {items.length > TOOLS_USED_FOLDED ? (
          <li>
            <UnstyledButton
              onClick={() => setAll((open) => !open)}
              className="font-sans text-xs text-muted-foreground hover:text-foreground"
            >
              {all ? "Show fewer" : `+${items.length - TOOLS_USED_FOLDED} more`}
            </UnstyledButton>
          </li>
        ) : null}
      </ul>
    </PayloadSection>
  );
}

/**
 * MCP tools first, grouped by server (`server__tool` once the client's
 * `mcp__<gateway>__` prefix is dropped), then the client's own tools.
 */
function toolItems(names: string[]) {
  const mcp: { key: string; server: string | null; tool: string }[] = [];
  const client: typeof mcp = [];
  for (const name of names) {
    const short = shortToolName(name);
    const at = short.indexOf("__");
    if (at < 0) client.push({ key: name, server: null, tool: name });
    else
      mcp.push({
        key: name,
        server: short.slice(0, at),
        tool: short.slice(at + 2),
      });
  }
  mcp.sort((a, b) => (a.server ?? "").localeCompare(b.server ?? ""));
  return [...mcp, ...client];
}

const TOOLS_USED_FOLDED = 18;

/**
 * Hold a scroller at its bottom while its content finishes laying out (a
 * thread's markdown and tool cards grow after the first paint), letting go
 * once the reader scrolls themselves or the content settles.
 */
function pinToBottom(scroller: HTMLElement): () => void {
  const toBottom = () => {
    scroller.scrollTop = scroller.scrollHeight;
  };
  toBottom();
  const content = scroller.firstElementChild;
  const observer = new ResizeObserver(toBottom);
  if (content) observer.observe(content);
  const release = () => {
    observer.disconnect();
    clearTimeout(timer);
    for (const type of RELEASE_EVENTS)
      scroller.removeEventListener(type, release);
  };
  const timer = setTimeout(release, PIN_SETTLE_MS);
  for (const type of RELEASE_EVENTS)
    scroller.addEventListener(type, release, { passive: true });
  return release;
}

const RELEASE_EVENTS = ["wheel", "touchstart", "keydown", "pointerdown"];
const PIN_SETTLE_MS = 1500;
