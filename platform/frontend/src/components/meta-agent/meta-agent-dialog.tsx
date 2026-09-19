"use client";

import type { UIMessage } from "@ai-sdk/react";
import {
  E2eTestId,
  isMetaAgentUiToolName,
  META_AGENT_UI_TOOL_NAMES,
} from "@archestra/shared";
import {
  ArrowUp,
  Maximize2,
  Minus,
  PanelRight,
  Sparkles,
  Square,
  SquarePen,
  X,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChatMessages } from "@/components/chat/chat-messages";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Textarea } from "@/components/ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { OPEN_META_AGENT_EVENT, SHORTCUT_META_AGENT } from "@/consts";
import { useConversation, useCreateConversation } from "@/lib/chat/chat.query";
import { useChatSession } from "@/lib/chat/global-chat.context";
import { useAppName } from "@/lib/hooks/use-app-name";
import { usePlatform } from "@/lib/hooks/use-platform";
import { useMetaAgent } from "@/lib/meta-agent/meta-agent.query";
import {
  META_AGENT_IGNORE_ATTRIBUTE,
  metaAgentPageTools,
} from "@/lib/meta-agent/page-tools";
import { cn } from "@/lib/utils";

/**
 * The in-app assistant: a chat with the built-in meta agent that floats over
 * every page. It is deliberately non-modal — the page underneath stays live,
 * because the assistant reads and drives it through its page tools and the
 * user should be able to watch that happen.
 */
export function MetaAgentDialog() {
  const appName = useAppName();
  const router = useRouter();
  const { isMac } = usePlatform();
  const [isOpen, setIsOpen] = useState(false);
  const [hasOpened, setHasOpened] = useState(false);
  const [placement, setPlacement] = useState<Placement>("center");
  const [isMinimized, setIsMinimized] = useState(false);
  const [draft, setDraft] = useState("");
  const [conversationId, setConversationId] = useState<string | undefined>(
    readStoredConversationId,
  );
  const pendingMessageRef = useRef<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const open = useCallback(() => {
    setIsOpen(true);
    setHasOpened(true);
    setIsMinimized(false);
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const isModKey = isMac ? event.metaKey : event.ctrlKey;
      if (
        isModKey &&
        event.key === SHORTCUT_META_AGENT.key &&
        !event.shiftKey &&
        !event.altKey
      ) {
        event.preventDefault();
        event.stopPropagation();
        setIsOpen((wasOpen) => {
          if (!wasOpen) {
            setHasOpened(true);
            requestAnimationFrame(() => textareaRef.current?.focus());
          }
          return !wasOpen;
        });
        setIsMinimized(false);
      }
    };
    window.addEventListener(OPEN_META_AGENT_EVENT, open);
    window.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.removeEventListener(OPEN_META_AGENT_EVENT, open);
      window.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [isMac, open]);

  useEffect(() => {
    metaAgentPageTools.setNavigator((path) => router.push(path));
    return () => metaAgentPageTools.setNavigator(null);
  }, [router]);

  const seenPageActionIdRef = useRef<string | null>(null);
  const selectConversation = useCallback((id: string | undefined) => {
    setConversationId(id);
    writeStoredConversationId(id);
    seenPageActionIdRef.current = null;
  }, []);

  const metaAgent = useMetaAgent(hasOpened);
  const createConversation = useCreateConversation();
  const { data: conversation, isFetched: conversationFetched } =
    useConversation(conversationId);

  // A remembered chat that is gone (deleted, or from another user on this
  // browser) resets to a fresh start instead of an error.
  useEffect(() => {
    if (conversationId && conversationFetched && conversation === null) {
      selectConversation(undefined);
    }
  }, [conversation, conversationFetched, conversationId, selectConversation]);

  const initialMessages = useMemo(
    () => (conversation?.messages ?? []) as UIMessage[],
    [conversation?.messages],
  );
  const session = useChatSession({
    conversationId,
    initialMessages,
    enabled: !!conversation,
  });
  const messages = session?.messages ?? initialMessages;
  const status = session?.status ?? "ready";
  const isBusy = status === "submitted" || status === "streaming";

  // The first message waits for the conversation it creates to get a live
  // session; send it as soon as one exists.
  useEffect(() => {
    const pending = pendingMessageRef.current;
    if (!pending || !session || session.status !== "ready") return;
    pendingMessageRef.current = null;
    session.sendMessage({
      role: "user",
      parts: [{ type: "text", text: pending }],
      metadata: { createdAt: new Date().toISOString() },
    });
  }, [session]);

  // Acting on the page from the middle of the screen would hide the very
  // thing being changed: once the assistant starts driving the page, move it
  // out of the way.
  const lastPageActionId = useMemo(
    () => findLastPageActionId(messages),
    [messages],
  );
  useEffect(() => {
    if (
      lastPageActionId &&
      lastPageActionId !== seenPageActionIdRef.current &&
      seenPageActionIdRef.current !== null
    ) {
      setPlacement("docked");
    }
    seenPageActionIdRef.current = lastPageActionId ?? "";
  }, [lastPageActionId]);

  const send = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || isBusy || pendingMessageRef.current) return;
    setDraft("");
    if (session && conversationId) {
      session.sendMessage({
        role: "user",
        parts: [{ type: "text", text: trimmed }],
        metadata: { createdAt: new Date().toISOString() },
      });
      return;
    }
    // Claimed before any await so a second click can't start a second chat.
    pendingMessageRef.current = trimmed;
    // The agent lookup starts when the dialog opens; a suggestion clicked
    // right away can beat it, so wait for it rather than drop the message.
    const agentId =
      metaAgent.data?.agentId ?? (await metaAgent.refetch()).data?.agentId;
    if (!agentId) {
      pendingMessageRef.current = null;
      setDraft(trimmed);
      return;
    }
    createConversation.mutate(
      { agentId },
      {
        onSuccess: (created) => {
          if (created) selectConversation(created.id);
        },
        onError: () => {
          pendingMessageRef.current = null;
          setDraft(trimmed);
        },
      },
    );
  };

  if (!isOpen) return null;

  const title = `${appName} Assistant`;

  if (isMinimized) {
    return (
      <div
        {...{ [META_AGENT_IGNORE_ATTRIBUTE]: "" }}
        className={cn("fixed right-4 bottom-4", LAYER_CLASS)}
      >
        <Button
          variant="outline"
          className="rounded-full shadow-lg gap-2"
          onClick={() => setIsMinimized(false)}
        >
          <Sparkles className="size-4" />
          <span>{isBusy ? "Working…" : title}</span>
        </Button>
      </div>
    );
  }

  const isEmpty = messages.length === 0;
  const agentUnavailable = metaAgent.isError;

  return (
    <section
      {...{ [META_AGENT_IGNORE_ATTRIBUTE]: "" }}
      aria-label={title}
      data-testid={E2eTestId.MetaAgentDialog}
      className={cn(
        "fixed flex flex-col overflow-hidden rounded-xl border bg-background shadow-2xl",
        LAYER_CLASS,
        placement === "center"
          ? "left-1/2 top-[8vh] h-[min(720px,84vh)] w-[min(780px,calc(100vw-2rem))] -translate-x-1/2"
          : "right-3 top-3 bottom-3 w-[min(460px,calc(100vw-1.5rem))]",
      )}
      onKeyDown={(event) => {
        if (event.key === "Escape") setIsOpen(false);
      }}
    >
      <header className="flex h-12 shrink-0 items-center gap-1 border-b px-2">
        <HeaderButton label="Close" onClick={() => setIsOpen(false)}>
          <X />
        </HeaderButton>
        <HeaderButton label="Minimize" onClick={() => setIsMinimized(true)}>
          <Minus />
        </HeaderButton>
        <HeaderButton
          label={placement === "center" ? "Dock to the side" : "Center"}
          onClick={() =>
            setPlacement((current) =>
              current === "center" ? "docked" : "center",
            )
          }
        >
          {placement === "center" ? <PanelRight /> : <Maximize2 />}
        </HeaderButton>
        <div className="flex flex-1 items-center justify-center gap-2 text-sm font-medium">
          <Sparkles className="size-4 text-primary" />
          <span>{title}</span>
        </div>
        {conversationId && (
          <HeaderButton label="Open as a full chat" asChild>
            <Link href={`/chat/${conversationId}`}>
              <Maximize2 className="rotate-90" />
            </Link>
          </HeaderButton>
        )}
        <HeaderButton
          label="New session"
          onClick={() => {
            if (isBusy) session?.stop();
            selectConversation(undefined);
            setDraft("");
            textareaRef.current?.focus();
          }}
        >
          <SquarePen />
        </HeaderButton>
      </header>

      <div className="min-h-0 flex-1">
        {isEmpty ? (
          <EmptyState
            appName={appName}
            unavailable={agentUnavailable}
            onPick={(prompt) => void send(prompt)}
          />
        ) : (
          <ChatMessages
            conversationId={conversationId}
            agentId={metaAgent.data?.agentId}
            agentName={title}
            messages={messages}
            status={status}
            optimisticToolCalls={session?.optimisticToolCalls}
            onMessagesUpdate={session?.setMessages}
            error={session?.error}
            chatErrors={conversation?.chatErrors ?? []}
            compactions={conversation?.compactions ?? []}
            onToolApprovalResponse={
              session
                ? ({ id, approved, reason }) =>
                    session.addToolApprovalResponse({ id, approved, reason })
                : undefined
            }
          />
        )}
      </div>

      <form
        className="shrink-0 p-3"
        onSubmit={(event) => {
          event.preventDefault();
          void send(draft);
        }}
      >
        <div className="rounded-lg border bg-muted/30 focus-within:ring-1 focus-within:ring-ring">
          <Textarea
            ref={textareaRef}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (
                event.key === "Enter" &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing
              ) {
                event.preventDefault();
                void send(draft);
              }
            }}
            placeholder={`Ask ${appName} Assistant…`}
            aria-label={`Message ${title}`}
            rows={2}
            className="min-h-[60px] resize-none border-0 bg-transparent shadow-none focus-visible:ring-0"
          />
          <div className="flex items-center justify-between px-2 pb-2">
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <Kbd>{isMac ? "⌘" : "Ctrl"}</Kbd>
              <Kbd>{SHORTCUT_META_AGENT.label}</Kbd>
              <span>to toggle</span>
            </span>
            {isBusy ? (
              <Button
                type="button"
                size="icon"
                variant="secondary"
                className="size-8 rounded-full"
                aria-label="Stop"
                onClick={() => session?.stop()}
              >
                <Square className="size-3.5" />
              </Button>
            ) : (
              <Button
                type="submit"
                size="icon"
                className="size-8 rounded-full"
                aria-label="Send"
                disabled={!draft.trim() || createConversation.isPending}
              >
                <ArrowUp className="size-4" />
              </Button>
            )}
          </div>
        </div>
      </form>
    </section>
  );
}

// ===
// Internal helpers
// ===

type Placement = "center" | "docked";

const STORAGE_KEY = "meta-agent-conversation-id";

// Above page dialogs (z-50), and clickable while one is open: a modal page
// dialog turns off pointer events for the rest of the page, which would
// otherwise leave the assistant — Stop button included — unreachable right
// after it opened that dialog. Interacting with the assistant dismisses the
// page dialog, as any click outside it does.
const LAYER_CLASS = "z-[60] pointer-events-auto";

const SUGGESTED_PROMPTS = [
  "What's on this page?",
  "Show me my recent chat sessions",
  "Help me connect a new MCP server",
  "Which agents can I use, and what do they do?",
  "Who has admin access in this organization?",
];

function EmptyState(props: {
  appName: string;
  unavailable: boolean;
  onPick: (prompt: string) => void;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 overflow-y-auto px-6 py-8 text-center">
      <div className="flex size-16 items-center justify-center rounded-full bg-primary/10">
        <Sparkles className="size-8 text-primary" />
      </div>
      <div className="space-y-1">
        <h2 className="text-base font-semibold">
          {`Your ${props.appName} assistant`}
        </h2>
        <p className="text-sm text-muted-foreground">
          It sees the page you're on, can click through it with you, and can
          change anything your permissions allow.
        </p>
      </div>
      {props.unavailable ? (
        <p className="text-sm text-destructive">
          The assistant isn't available yet — try again after the backend
          finishes starting.
        </p>
      ) : (
        <div className="flex max-w-xl flex-wrap justify-center gap-2">
          {SUGGESTED_PROMPTS.map((prompt) => (
            <Button
              key={prompt}
              type="button"
              variant="outline"
              size="sm"
              className="h-auto rounded-full px-3 py-1.5 font-normal whitespace-normal"
              onClick={() => props.onPick(prompt)}
            >
              {prompt}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}

function HeaderButton(props: {
  label: string;
  onClick?: () => void;
  asChild?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-8 [&_svg]:size-4"
          aria-label={props.label}
          onClick={props.onClick}
          asChild={props.asChild}
        >
          {props.children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{props.label}</TooltipContent>
    </Tooltip>
  );
}

/** The id of the newest page tool call that changes the page (not a read). */
function findLastPageActionId(messages: UIMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const parts = messages[i]?.parts ?? [];
    for (let j = parts.length - 1; j >= 0; j--) {
      const part = parts[j] as {
        type: string;
        toolCallId?: string;
        toolName?: string;
      };
      const toolName =
        part.type === "dynamic-tool"
          ? (part.toolName ?? null)
          : part.type.startsWith("tool-")
            ? part.type.slice("tool-".length)
            : null;
      if (
        toolName &&
        isMetaAgentUiToolName(toolName) &&
        toolName !== META_AGENT_UI_TOOL_NAMES.GET_PAGE &&
        part.toolCallId
      ) {
        return part.toolCallId;
      }
    }
  }
  return null;
}

function readStoredConversationId(): string | undefined {
  try {
    return window.localStorage.getItem(STORAGE_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

function writeStoredConversationId(id: string | undefined) {
  try {
    if (id) window.localStorage.setItem(STORAGE_KEY, id);
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage can be unavailable (private mode); the session just won't
    // survive a reload.
  }
}
