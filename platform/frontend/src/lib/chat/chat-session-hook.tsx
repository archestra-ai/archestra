"use client";

import { type UIMessage, useChat } from "@ai-sdk/react";
import {
  CONTEXT_WINDOW_BREAKDOWN_EVENT,
  type ContextWindowBreakdown,
  ContextWindowBreakdownSchema,
  type ContextWindowEstimate,
  EXTERNAL_AGENT_ID_HEADER,
  getArchestraToolShortName,
  MCP_TASK_PART_TYPE,
  type McpTaskPartData,
  stripDanglingToolCalls,
  TOOL_CREATE_AGENT_SHORT_NAME,
  type TokenUsage,
} from "@archestra/shared";
import { useQueryClient } from "@tanstack/react-query";
import { lastAssistantMessageIsCompleteWithApprovalResponses } from "ai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { filterOptimisticToolCalls } from "@/components/chat/chat-messages.utils";
import { McpElicitationDialog } from "@/components/chat/mcp-elicitation-dialog";
import {
  type ChatMcpElicitationRequest,
  ChatMcpElicitationRequestSchema,
  type ElicitationResponse,
  isChoiceElicitationRequest,
} from "@/components/chat/mcp-elicitation-fields";
import { collectArchestraToolInvalidations } from "@/lib/chat/archestra-tool-invalidations";
import {
  fetchConversation,
  useClearChatErrors,
  useGenerateConversationTitle,
  useResolveChatMcpElicitation,
} from "@/lib/chat/chat.query";
import { useUpdateChatMessage } from "@/lib/chat/chat-message.query";
import {
  chatMessageQueue,
  useConversationMessageQueue,
} from "@/lib/chat/chat-message-queue";
import {
  isRetryableError,
  parseStructuredChatError,
} from "@/lib/chat/chat-retry.utils";
import {
  pruneEmptyTrailingAssistantMessage,
  pruneStrandedAssistantMessages,
  restoreRenderableAssistantParts,
  shouldFreezeChatMessages,
} from "@/lib/chat/chat-session-utils";
import {
  getChatExternalAgentId,
  isPlaceholderTitle,
  resolveCanonicalMessageId,
} from "@/lib/chat/chat-utils";
import { encryptedChatRequestHeaders } from "@/lib/chat/encrypted-chat";
import { getQueueInterruptBlockedReason } from "@/lib/chat/queue-interrupt";
import { ResumableChatTransport } from "@/lib/chat/resumable-chat-transport";
import { useStreamStall } from "@/lib/chat/stream-stall.hook";
import { readThinkingEffort } from "@/lib/chat/thinking-effort-cache";
import appConfig from "@/lib/config/config";
import { useAppName } from "@/lib/hooks/use-app-name";

import type {
  ChatSession,
  ContextCompactionRecord,
  ContextCompactionState,
} from "./global-chat.context";

const MAX_AUTO_RETRIES = 2;
const AUTO_RETRY_DELAY_MS = 1500;
// Reattaches per stalled turn. A stream that finishes cleanly resets the count.
const MAX_STALL_RECOVERIES = 3;
const MCP_ELICITATION_FAILURE_CLEAR_MS = 30_000;

function isDuplicateActiveRunError(error: Error): boolean {
  // Match the backend's exact duplicate-run message rather than a bare "409",
  // which could collide with unrelated error text (e.g. "4096 tokens").
  return error.message.includes("already has an active response");
}

function shouldResumeActiveRun(messages: UIMessage[]): boolean {
  return messages.at(-1)?.role === "user";
}

// True while the trailing assistant message has a tool call whose input is
// complete but whose output hasn't arrived — i.e. a tool is executing (or a
// client-side tool awaits its result). "input-streaming" is excluded: there
// the provider is still emitting deltas, so silence IS an upstream stall.
function awaitingToolOutput(messages: UIMessage[]): boolean {
  const lastMessage = messages.at(-1);
  if (lastMessage?.role !== "assistant") {
    return false;
  }
  return lastMessage.parts.some(
    (part) =>
      (part.type === "dynamic-tool" || part.type.startsWith("tool-")) &&
      "state" in part &&
      part.state === "input-available",
  );
}

/**
 * One conversation's live AI SDK chat: the `useChat` instance and everything
 * that feeds its snapshot into the session map. ChatProvider loads this module
 * lazily, so the AI SDK is not part of the first load.
 */
export default function ChatSessionHook({
  conversationId,
  initialMessages,
  sessionsRef,
  notifySessionUpdate,
  markTitleAnimating,
}: {
  conversationId: string;
  initialMessages: UIMessage[];
  sessionsRef: React.MutableRefObject<Map<string, ChatSession>>;
  notifySessionUpdate: (update: {
    conversationId: string;
    status: ChatSession["status"];
  }) => void;
  markTitleAnimating: (conversationId: string) => void;
}) {
  const queryClient = useQueryClient();
  const appName = useAppName();
  const [mcpElicitations, setMcpElicitations] = useState<
    ChatMcpElicitationRequest[]
  >([]);
  // IDs the backend has resolved, answered, or expired.
  // Replays re-stream questions from the turn start; this set prevents settled
  // questions from returning to the card view.
  const settledMcpElicitationIdsRef = useRef(new Set<string>());
  const elicitationFailureClearTimersRef = useRef(
    new Map<string, ReturnType<typeof setTimeout>>(),
  );
  const clearElicitationFailureTimer = useCallback((id: string) => {
    const timer = elicitationFailureClearTimersRef.current.get(id);
    if (timer) {
      clearTimeout(timer);
      elicitationFailureClearTimersRef.current.delete(id);
    }
  }, []);
  useEffect(() => {
    const timers = elicitationFailureClearTimersRef.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, []);
  const settleMcpElicitation = useCallback(
    (id: string) => {
      clearElicitationFailureTimer(id);
      settledMcpElicitationIdsRef.current.add(id);
      setMcpElicitations((current) =>
        current.some((request) => request.id === id)
          ? current.filter((request) => request.id !== id)
          : current,
      );
    },
    [clearElicitationFailureTimer],
  );
  const [mcpTasks, setMcpTasks] = useState<Record<string, McpTaskPartData>>({});
  const [optimisticToolCalls, setOptimisticToolCalls] = useState<
    Array<{
      toolCallId: string;
      toolName: string;
      input: unknown;
    }>
  >([]);
  const [tokenUsage, setTokenUsage] = useState<TokenUsage | null>(null);
  const [contextTokensUsed, setContextTokensUsed] = useState<number | null>(
    null,
  );
  const [contextWindow, setContextWindow] =
    useState<ContextWindowBreakdown | null>(null);
  const [streamActivity, setStreamActivity] = useState({
    transportSequence: 0,
    responseProgressSequence: 0,
  });
  const recordTransportActivity = useCallback(() => {
    setStreamActivity((activity) => ({
      ...activity,
      transportSequence: activity.transportSequence + 1,
    }));
  }, []);
  const recordResponseProgress = useCallback(() => {
    setStreamActivity((activity) => ({
      transportSequence: activity.transportSequence + 1,
      responseProgressSequence: activity.responseProgressSequence + 1,
    }));
  }, []);
  const [streamContextCompaction, setContextCompaction] =
    useState<ContextCompactionState>({
      isCompacting: false,
      trigger: null,
      lastCompaction: null,
    });
  // A manual `/compact` runs over REST with no stream attached, so none of the
  // stream data parts above ever fire for it. Tracked separately (rather than
  // folded into the state above) so the stream-end cleanup below cannot clear a
  // manual run that is still in flight, and vice versa.
  const [manualCompactionActive, setManualCompactionActive] = useState(false);
  const generateTitleMutation = useGenerateConversationTitle();
  const resolveMcpElicitationMutation = useResolveChatMcpElicitation();
  const { mutateAsync: resolveMcpElicitationAsync } =
    resolveMcpElicitationMutation;
  // Destructure the stable mutateAsync (not the whole mutation object, whose
  // identity changes every render) so regenerateUserMessage stays referentially
  // stable and doesn't retrigger the session-sync effect on every render.
  const { mutateAsync: updateChatMessageAsync } =
    useUpdateChatMessage(conversationId);
  // Track if title generation has been attempted for this conversation
  const titleGenerationAttemptedRef = useRef(false);
  // Ref to hold sendMessage for use in onFinish callback
  const sendMessageRef = useRef<
    | ((
        message: Parameters<ReturnType<typeof useChat>["sendMessage"]>[0],
      ) => void)
    | null
  >(null);
  // useChat returns clearError, but onError is defined inside the useChat config
  // (before the hook returns), so reach it through a ref like sendMessageRef.
  const clearErrorRef = useRef<(() => void) | null>(null);
  // Auto-retry state for transient errors
  const retryCountRef = useRef(0);
  const retryTimerRef = useRef<NodeJS.Timeout | null>(null);
  // Silent recovery from a stalled stream: "aborting" while the hung stream is
  // being ended, "replaying" while the active-run replay streams back.
  const stallRecoveryRef = useRef<{
    phase: "aborting" | "replaying" | null;
    attempts: number;
  }>({ phase: null, attempts: 0 });
  // Set while auto-retrying a *structured* (backend-persisted) error, so a
  // successful retry can wipe the now-stale persisted error card the backend
  // never clears on its own.
  const recoveredPersistedErrorRef = useRef(false);
  const clearChatErrors = useClearChatErrors();
  // Monotonically counts onError invocations. The duplicate-run reattach uses
  // it to detect that nothing happened between calling resumeStream() and its
  // promise resolving — the "run already finished" case, where the reconnect
  // gets a 204 and the SDK early-returns without firing onFinish or onError.
  const errorSeqRef = useRef(0);
  // True while a transient failure is being auto-recovered (retry scheduled
  // or reattaching to the active run); suppresses the inline error flash.
  // The ref is the source of truth: it is written synchronously inside
  // onError, BEFORE the SDK's error state reaches the page, so the very
  // render that delivers the error already sees the suppression. The state
  // mirror exists only to trigger re-renders/session sync — a state-only
  // flag commits one render too late and the error card flashes for a frame.
  const recoveringRef = useRef(false);
  const [isRecoveringState, setIsRecoveringState] = useState(false);
  const setIsRecovering = useCallback((value: boolean) => {
    recoveringRef.current = value;
    setIsRecoveringState(value);
  }, []);
  // Snapshot of the rendered messages at the moment recovery started; shown
  // instead of the live list while recovery passes through its ugly
  // intermediate states (answer dropped by regenerate, replay restarting from
  // empty) so the streamed text never visibly blinks away.
  const frozenMessagesRef = useRef<UIMessage[]>([]);
  const lastUserMessageIdRef = useRef<string | null>(null);
  const previousMessagesRef = useRef<UIMessage[]>([]);

  const recordContextCompaction = useCallback(
    (compaction: ContextCompactionRecord) => {
      const { updateContextTokens = true, ...lastCompaction } = compaction;
      setContextCompaction({
        isCompacting: false,
        trigger: null,
        lastCompaction,
      });

      if (
        updateContextTokens &&
        typeof lastCompaction.compactedTokenEstimate === "number"
      ) {
        setContextTokensUsed(lastCompaction.compactedTokenEstimate);
      }
    },
    [],
  );

  // a dropped connection between compaction-start and compaction-finish would
  // otherwise leave the spinner stuck on; clear it on any stream end.
  const clearActiveContextCompaction = useCallback(() => {
    setContextCompaction((current) => ({
      ...current,
      isCompacting: false,
      trigger: null,
    }));
  }, []);

  // Bracket a manual (REST) compaction so the rest of the session treats the
  // conversation as busy for its whole duration: the composer keeps queueing
  // instead of sending, and the queued-message drain below waits rather than
  // firing a turn into a thread that is being rewritten under it. The caller
  // owns the pairing — `end` must run on every exit path (including failures),
  // or the queue would stay parked forever.
  const beginManualContextCompaction = useCallback(() => {
    setManualCompactionActive(true);
  }, []);
  const endManualContextCompaction = useCallback(() => {
    setManualCompactionActive(false);
  }, []);

  // What every consumer sees: either source of compaction reads as "compacting".
  const contextCompaction = useMemo<ContextCompactionState>(
    () =>
      manualCompactionActive && !streamContextCompaction.isCompacting
        ? { ...streamContextCompaction, isCompacting: true, trigger: "manual" }
        : streamContextCompaction,
    [manualCompactionActive, streamContextCompaction],
  );

  // Track early UI data from data-tool-ui-start events (toolCallId → resource data)
  const [earlyToolUiStarts, setEarlyToolUiStarts] = useState<
    ChatSession["earlyToolUiStarts"]
  >({});
  const shouldResume = shouldResumeActiveRun(initialMessages);
  // Queued-message drain waits for the mount-time resume attempt to settle,
  // so a queue restored from localStorage never races a still-active run
  // (which would 409 as a duplicate). resumeStream() resolves both when the
  // resumed stream ends and immediately when there is nothing to resume.
  const [resumeSettled, setResumeSettled] = useState(!shouldResume);

  // Latest SDK messages for callbacks defined inside the useChat config (like
  // onData), which close over the config object before `messages` exists.
  // Assigned every render right after useChat returns.
  const latestMessagesRef = useRef<UIMessage[]>(initialMessages);
  // The messages the run in flight started from. The active-run replay always
  // restarts from the run's first chunk, so a stall reattach resets the chat to
  // these before replaying; otherwise the replay is appended to the partial
  // answer and the text shows twice.
  const requestBaseMessagesRef = useRef<UIMessage[]>(initialMessages);
  const latestStatusRef = useRef<ChatSession["status"]>("ready");
  const preserveQueuedMessagesOnAbortRef = useRef<{
    userMessageId: string | undefined;
  } | null>(null);
  const stopInFlightRef = useRef(false);
  const [isStopping, setIsStopping] = useState(false);

  // useChat keeps the transport its Chat was created with, so build it once and
  // keep the instance the stall recovery and stop() abort.
  const [transport] = useState(
    () =>
      new ResumableChatTransport({
        api: "/api/chat",
        credentials: "include",
        // Resolved per request (function form) so an encrypted chat's
        // browser-held key — stored just before the session mounts — always
        // rides on the stream POST.
        headers: () => ({
          [EXTERNAL_AGENT_ID_HEADER]: getChatExternalAgentId(appName),
          ...encryptedChatRequestHeaders(conversationId),
        }),
        // Carry the reasoning depth the composer is showing. The server also
        // stores it per conversation, but that write is a separate request the
        // send can overtake — sending it with the turn makes the depth the user
        // can see the depth that runs, without the send waiting on anything.
        prepareSendMessagesRequest: ({
          id,
          messages,
          trigger,
          messageId,
          body,
        }) => {
          requestBaseMessagesRef.current = messages;
          return {
            body: {
              id,
              messages,
              trigger,
              messageId,
              ...body,
              thinkingEffort: readThinkingEffort(queryClient, id),
            },
          };
        },
        prepareReconnectToStreamRequest: ({ id, headers, credentials }) => {
          // Merge the encrypted-chat key explicitly: the reconnect GET touches the
          // conversation's content too and must carry the same header.
          const merged = new Headers(headers);
          for (const [name, value] of Object.entries(
            encryptedChatRequestHeaders(id) ?? {},
          )) {
            merged.set(name, value);
          }
          return {
            api: `/api/chat/conversations/${id}/active-run`,
            headers: merged,
            credentials,
          };
        },
      }),
  );

  const {
    messages,
    sendMessage,
    regenerate,
    resumeStream,
    status,
    setMessages,
    stop,
    error,
    clearError,
    addToolResult,
    addToolApprovalResponse,
  } = useChat({
    messages: initialMessages,
    transport,

    experimental_throttle: 100,
    id: conversationId,
    onFinish: async ({ message, isAbort, isError }) => {
      const preservation = preserveQueuedMessagesOnAbortRef.current;
      const preserveQueuedMessages =
        preservation !== null &&
        preservation.userMessageId ===
          latestMessagesRef.current.findLast((part) => part.role === "user")
            ?.id;
      // A failed stream can reattach to the same turn while its server stop
      // is pending. Preserve that intent until the turn actually finishes;
      // a different user message must never inherit it.
      if (!isError || !preserveQueuedMessages) {
        preserveQueuedMessagesOnAbortRef.current = null;
      }
      setOptimisticToolCalls([]);
      // An errored stream keeps its questions: onError either clears them
      // (terminal) or is about to retry/reattach into the same run, whose
      // replay re-sends them — clearing here would unmount the card and lose
      // the picks made so far.
      if (!isError) {
        setMcpElicitations([]);
      }
      clearActiveContextCompaction();
      // The stream concluded — any auto-recovery (retry/reattach) is over.
      // NOT on stream errors: the SDK fires onFinish from a finally block
      // right after onError, so clearing here would wipe the recovery flag
      // the error handler just set (and misroute the auto-retry's 409 to the
      // genuine-duplicate toast). Error outcomes are owned by onError: it
      // either keeps a recovery in flight or clears the flag for terminal
      // errors.
      //
      // The stall recovery's own abort ends this stream while its replay is
      // still to come, so the recovery stays open; any other abort (the user's
      // Stop) or a clean finish ends it.
      const isStallRecoveryAbort =
        isAbort && stallRecoveryRef.current.phase === "aborting";
      if (!isError && !isAbort) {
        stallRecoveryRef.current.attempts = 0;
      }
      if (!isError && !isStallRecoveryAbort) {
        stallRecoveryRef.current.phase = null;
        setIsRecovering(false);
        // A structured error we silently auto-retried just succeeded — clear the
        // stale persisted error card the backend leaves behind (it never clears it
        // on a new run). Reset the flag first so a re-entrant finish can't double-fire.
        if (recoveredPersistedErrorRef.current) {
          recoveredPersistedErrorRef.current = false;
          try {
            await clearChatErrors.mutateAsync({ id: conversationId });
          } catch (error) {
            console.error(
              "[ChatSession] Failed to clear stale chat error after retry",
              error,
            );
          }
        }
      }

      // When the user stops mid-tool-call, the assistant message is left with a
      // tool part that never produced output, which the UI renders as a
      // perpetually "running" tool. Drop those dangling parts so the live view
      // matches what the backend persists (and a reload would show). A stall
      // recovery resets the messages and replays the run instead.
      if (isAbort && !isStallRecoveryAbort) {
        // An explicit steering interrupt preserves queued follow-ups so the
        // normal ready-state drain can deliver the oldest one immediately.
        // Other aborts remain a hard boundary and discard pending work.
        if (!preserveQueuedMessages) {
          chatMessageQueue.clear(conversationId);
        }
        // The updater form runs against the SDK's live messages, not this
        // callback's (throttled, possibly stale) closure, so the most recently
        // streamed text is never rolled back.
        setMessages((current) => {
          const stripped = pruneEmptyTrailingAssistantMessage(
            stripDanglingToolCalls(current),
          );
          // restoreRenderableAssistantParts treats the shrink as a streaming
          // regression and would resurrect the stripped parts on the next
          // render; sync the ref so that comparison sees no regression.
          previousMessagesRef.current = stripped;
          return stripped;
        });
      }

      const conversationInvalidate = queryClient.invalidateQueries({
        queryKey: ["conversation", conversationId],
      });
      queryClient.invalidateQueries({
        queryKey: ["openappa-status", conversationId],
      });

      const conversationsSidebarInvalidate = queryClient.invalidateQueries({
        queryKey: ["conversations"],
      });

      // Archestra tools that mutate data server-side inside the chat loop
      // (e.g. publish_app) bypass the frontend mutation hooks that normally
      // invalidate the affected caches. Without this, opening the app's
      // Settings right after a publish serves the cached pre-publish scope
      // until the staleTime window lapses or a hard refresh. Invalidating
      // here — on the finished message's successful tool results, not in
      // onToolCall — guarantees the refetch cannot race the server-side
      // write (onToolCall fires before the tool executes).
      for (const queryKey of collectArchestraToolInvalidations({
        parts: message.parts,
        getToolShortName: (toolName) =>
          getCurrentArchestraToolShortName(toolName, appName),
      })) {
        queryClient.invalidateQueries({ queryKey });
      }

      // Free early UI HTML blobs now that all tool calls have rendered.
      setEarlyToolUiStarts({});

      await Promise.all([
        conversationInvalidate,
        conversationsSidebarInvalidate,
      ]);

      // Auto-generate title after the first settled exchange if still untitled
      const cachedConversation = queryClient.getQueryData<{
        title?: string | null;
        titleIsPlaceholder?: boolean;
      }>(["conversation", conversationId]);
      const cachedTitle = cachedConversation?.title;
      // Two kinds of stand-in title, and neither is proof the server ever
      // titled this chat. An app chat carries the durable flag, set when the
      // row was seeded with the app's name. An ordinary chat carries none — the
      // client wrote the opening prompt as its title — so that one is only
      // recognisable by shape, and only here: the server's "already titled"
      // gate sees an ordinary non-empty title and would skip, which is why
      // this kind alone has to ask for a regeneration.
      const hasInferredPlaceholderTitle = isPlaceholderTitle(
        cachedTitle,
        stableMessages,
      );
      const hasPlaceholderTitle =
        cachedConversation?.titleIsPlaceholder === true ||
        hasInferredPlaceholderTitle;

      // A placeholder title counts as untitled. The server re-reads the flag
      // and skips if it's stale, so this only decides whether to ask.
      const shouldGenerateTitle =
        !titleGenerationAttemptedRef.current &&
        (!cachedTitle || hasPlaceholderTitle);

      if (shouldGenerateTitle) {
        titleGenerationAttemptedRef.current = true;
        generateTitleMutation.mutate(
          {
            id: conversationId,
            regenerate: hasInferredPlaceholderTitle,
          },
          {
            onSuccess: (data) => {
              if (data) {
                markTitleAnimating(conversationId);
              }
            },
          },
        );
      }
    },
    onError: (chatError) => {
      errorSeqRef.current += 1;
      setOptimisticToolCalls([]);
      clearActiveContextCompaction();
      queryClient.invalidateQueries({
        queryKey: ["conversation", conversationId],
      });
      // Chat errors are persisted asynchronously by the backend after the stream
      // fails, so refetch once immediately and once shortly after that write.
      setTimeout(() => {
        queryClient.invalidateQueries({
          queryKey: ["conversation", conversationId],
        });
      }, 500);
      // Log the error itself, not just fields read off it: a stream failure can
      // arrive as a bare object with no name/message, and the destructured form
      // then serializes to "{}" — which is what this printed while a real
      // failure was in flight, leaving nothing to diagnose.
      console.error("[ChatSession] Error occurred:", chatError, {
        conversationId,
        errorName: chatError.name,
        errorMessage: chatError.message,
        errorCause: chatError.cause,
        retryCount: retryCountRef.current,
      });

      // The stall reattach itself failed (connect timeout, network error, an
      // error status). Try again while attempts remain: clearing the error
      // returns the chat to "ready", which starts the next replay. Out of
      // attempts, the error surfaces like any terminal one.
      const stallRecovery = stallRecoveryRef.current;
      if (stallRecovery.phase === "replaying") {
        if (stallRecovery.attempts < MAX_STALL_RECOVERIES) {
          stallRecovery.attempts += 1;
          stallRecovery.phase = "aborting";
          retryTimerRef.current = setTimeout(() => {
            clearErrorRef.current?.();
          }, AUTO_RETRY_DELAY_MS);
          return;
        }
        stallRecovery.phase = null;
        recoveredPersistedErrorRef.current = false;
        setMcpElicitations([]);
        setIsRecovering(false);
        return;
      }

      if (isDuplicateActiveRunError(chatError)) {
        if (!recoveringRef.current) {
          // A 409 outside auto-recovery is a genuine concurrent submit (e.g.
          // a second tab racing this conversation): reattaching would
          // silently drop the message the user just typed, so keep the
          // honest guard instead.
          toast.error(
            "This conversation already has a response in progress. Stop it before sending another message.",
          );
          // Clear the SDK error so this benign guard does not also render as
          // a hard inline error panel; the toast is the only surfaced
          // feedback.
          clearErrorRef.current?.();
          setMcpElicitations([]);
          return;
        }
        // The 409 was provoked by our own auto-recovery: the stream
        // connection was severed (LB cut, network blip) while the backend
        // kept generating, and the auto-retry below re-POSTed into the live
        // run. Reattach to it via the active-run replay endpoint instead of
        // dead-ending: the user sees the in-progress response (and the Stop
        // button) again. If the run finished in the meantime, the reconnect
        // returns 204 and is a no-op — the conversation refetch above
        // already shows the persisted outcome.
        //
        // Clear the restore-on-regression buffer first: the auto-retry's
        // regenerate() has already dropped the severed turn's partial
        // assistant message, but previousMessagesRef still holds it and would
        // keep resurrecting it while the replay rebuilds the same message id
        // from empty — two writers fighting over one message in an update
        // loop that crashes the page (React #185, "Maximum update depth").
        // Emptying the buffer makes this path state-equivalent to the
        // mount-time resume, which has always been safe; the replay re-streams
        // everything the buffer was protecting anyway. The frozen snapshot
        // (captured before clearing) keeps the text on screen meanwhile.
        if (previousMessagesRef.current.length > 0) {
          frozenMessagesRef.current = previousMessagesRef.current;
        }
        previousMessagesRef.current = [];
        setIsRecovering(true);
        const reattachErrorSeq = errorSeqRef.current;
        void resumeStream().then(() => {
          // If the run had already finished, reconnectToStream got a 204 and
          // the SDK resolved this promise WITHOUT firing onFinish or onError
          // (ai@6 makeRequest early-returns on a null reconnect stream) —
          // nothing else would clear the recovery flag, and a stuck flag
          // misroutes the next genuine concurrent submit's 409 into this
          // reattach path (silently dropping the typed message) and keeps the
          // frozen snapshot rendered. Detect that nothing happened while we
          // waited (recovery still flagged, no new error) and conclude the
          // recovery; the conversation refetch above already shows the
          // persisted outcome. A successful replay clears the flag in
          // onFinish; a failed replay re-enters onError (bumping the seq) and
          // owns the flag from there.
          if (
            recoveringRef.current &&
            errorSeqRef.current === reattachErrorSeq
          ) {
            setIsRecovering(false);
            // The run is over, so nothing is waiting on its questions.
            setMcpElicitations([]);
            // This reattach ends the recovery without an onFinish/onError, so
            // drop any pending "clear the persisted error on success" intent —
            // otherwise it leaks into a later unrelated success.
            recoveredPersistedErrorRef.current = false;
            // Drop the stale duplicate-run error so the SDK returns to
            // "ready" instead of idling in the suppressed error state.
            clearErrorRef.current?.();
          }
        });
        return;
      }

      // Auto-retry transient errors (network failures, server errors)
      // Do not retry if the error already happened this attempt cycle to avoid
      // hammering a quota-exhausted API.
      if (
        isRetryableError(chatError) &&
        retryCountRef.current < MAX_AUTO_RETRIES
      ) {
        retryCountRef.current++;
        // A structured error was persisted by the backend; a successful retry must
        // clear that stale card (onFinish). Unstructured client errors leave no row.
        recoveredPersistedErrorRef.current =
          parseStructuredChatError(chatError.message) !== null;
        console.info(
          `[ChatSession] Auto-retrying (${retryCountRef.current}/${MAX_AUTO_RETRIES})...`,
        );
        setIsRecovering(true);
        retryTimerRef.current = setTimeout(() => {
          // Capture the view and break the restore-on-regression chain at the
          // moment the rebuild starts (not earlier — previousMessagesRef is
          // rebuilt every render, so clearing it before regenerate() would
          // just re-establish). Without this, the restore logic resurrects
          // the dropped partial answer while the retried stream rebuilds the
          // message from empty — the update loop that crashes the page
          // (React #185). The frozen snapshot keeps the text on screen
          // instead.
          frozenMessagesRef.current = previousMessagesRef.current;
          previousMessagesRef.current = [];
          regenerate();
        }, AUTO_RETRY_DELAY_MS);
        return;
      }

      // Terminal: no recovery in flight — surface the error (and keep its
      // persisted card, so drop any pending "clear on successful retry" intent).
      recoveredPersistedErrorRef.current = false;
      setMcpElicitations([]);
      setIsRecovering(false);
    },
    onToolCall: ({ toolCall }) => {
      const toolShortName = getCurrentArchestraToolShortName(
        toolCall.toolName,
        appName,
      );

      setOptimisticToolCalls((current) => {
        if (current.some((call) => call.toolCallId === toolCall.toolCallId)) {
          return current;
        }

        return [
          ...current,
          {
            toolCallId: toolCall.toolCallId,
            toolName: toolCall.toolName,
            input: "args" in toolCall ? toolCall.args : undefined,
          },
        ];
      });

      // Agents created through chat tool calls bypass the normal frontend
      // create-agent mutations, so the cached agent metadata can stay
      // stale unless we invalidate it here. Without this, the prompt input's
      // agent selector may not reflect a newly created agent yet.
      if (toolShortName === TOOL_CREATE_AGENT_SHORT_NAME) {
        queryClient.invalidateQueries({ queryKey: ["agents"] });
      }
    },
    onData: (dataPart) => {
      // A transient heartbeat proves the browser-to-backend stream is alive,
      // but not, in general, that the upstream provider is making response
      // progress. The exception is while a tool call is executing (input
      // complete, output pending): the stream is intentionally silent — the
      // backend sends heartbeats precisely to cover long-running tool
      // executions and subagent calls — so the heartbeat counts as progress,
      // not as a stalled upstream provider.
      if (dataPart.type === "data-heartbeat") {
        if (awaitingToolOutput(latestMessagesRef.current)) {
          recordResponseProgress();
        } else {
          recordTransportActivity();
        }
      } else {
        recordResponseProgress();
      }

      // Handle token usage data from the backend stream
      if (dataPart.type === "data-token-usage") {
        const usage = dataPart.data as TokenUsage;
        setTokenUsage(usage);
        // The indicator tracks context-window occupancy, which is the prompt
        // (input) size; totalTokens additionally folds in output and would
        // overstate how full the window is.
        const occupancy = usage.inputTokens ?? usage.totalTokens;
        if (typeof occupancy === "number") {
          setContextTokensUsed(occupancy);
        }
      }

      // Seed the indicator at turn start with the backend's estimate of the
      // outgoing prompt, on the same yardstick as auto-compaction. Per-step
      // data-token-usage events then refine it with the provider's real count.
      // Also reset the breakdown: a new estimate means a new request is being
      // assembled, so the previous breakdown is stale until the new one arrives.
      if (dataPart.type === "data-context-window-estimate") {
        const data = dataPart.data as ContextWindowEstimate;
        if (typeof data.estimatedTokens === "number") {
          setContextTokensUsed(data.estimatedTokens);
          setContextWindow(null);
        }
      }

      // Per-category breakdown of the assembled request, powering the Context
      // Window Visualizer panel. Emitted once per turn after assembly.
      if (dataPart.type === CONTEXT_WINDOW_BREAKDOWN_EVENT) {
        const parsed = ContextWindowBreakdownSchema.safeParse(dataPart.data);
        if (parsed.success) {
          setContextWindow(parsed.data);
        }
        // Malformed payload: silently drop — never throw, never surface to the user.
      }

      if (dataPart.type === "data-context-compaction-start") {
        const data = dataPart.data as { trigger?: "auto" | "manual" };
        setContextCompaction((current) => ({
          ...current,
          isCompacting: true,
          trigger: data.trigger ?? "auto",
        }));
      }

      if (dataPart.type === "data-context-compaction-finish") {
        const data = dataPart.data as {
          trigger?: "auto" | "manual";
          compactionId?: string;
          originalTokenEstimate?: number;
          compactedTokenEstimate?: number;
        };
        recordContextCompaction(data);
        queryClient.invalidateQueries({
          queryKey: ["conversation", conversationId],
        });
      }

      // Handle data-tool-ui-start: backend emits this when a tool call starts streaming,
      // so the frontend can render the MCP App container immediately (before tool finishes)
      const customData = dataPart as unknown as {
        type?: string;
        data?: unknown;
      };
      if (customData.type === "data-tool-ui-start") {
        const { toolCallId, toolName, uiResourceUri, html, csp, permissions } =
          (customData.data ??
            {}) as ChatSession["earlyToolUiStarts"][string] & {
            toolCallId?: string;
            toolName?: string;
          };
        if (toolCallId && uiResourceUri) {
          setEarlyToolUiStarts((prev) => ({
            ...prev,
            [toolCallId]: { uiResourceUri, html, csp, permissions, toolName },
          }));
        }
      }

      if (customData.type === "data-mcp-elicitation") {
        const parsed = ChatMcpElicitationRequestSchema.safeParse(
          customData.data,
        );
        if (
          parsed.success &&
          parsed.data.conversationId === conversationId &&
          !settledMcpElicitationIdsRef.current.has(parsed.data.id)
        ) {
          const data = parsed.data;
          setMcpElicitations((current) =>
            current.some((request) => request.id === data.id)
              ? current
              : [...current, data],
          );
        }
      }

      // The backend stopped waiting on a question (answered, timed out, or
      // its run was stopped). Written right after the question in the run's
      // event log, so a replay settles the question it just re-streamed.
      if (customData.type === "data-mcp-elicitation-resolved") {
        const data = customData.data as
          | { id?: string; conversationId?: string }
          | undefined;
        if (data?.id && data.conversationId === conversationId) {
          settleMcpElicitation(data.id);
        }
      }

      if (customData.type === MCP_TASK_PART_TYPE) {
        const data = customData.data as McpTaskPartData | undefined;
        if (data?.taskId) {
          setMcpTasks((current) => ({ ...current, [data.taskId]: data }));
        }
      }
    },
    sendAutomaticallyWhen: ({ messages: msgs }) =>
      lastAssistantMessageIsCompleteWithApprovalResponses({
        messages: msgs,
      }),
  } as Parameters<typeof useChat>[0]);

  latestMessagesRef.current = messages;
  latestStatusRef.current = status;

  // Text and tool-call deltas update the SDK's raw message list. Track that
  // progress independently from displayedMessages, which can intentionally be
  // frozen while a failed connection is recovering. Entering streaming also
  // starts fresh transport and response-progress windows.
  const previousActivityMessagesRef = useRef(messages);
  const previousActivityStatusRef = useRef(status);
  useEffect(() => {
    const enteredStreaming =
      previousActivityStatusRef.current !== "streaming" &&
      status === "streaming";
    const messagesProgressed = previousActivityMessagesRef.current !== messages;

    previousActivityStatusRef.current = status;
    previousActivityMessagesRef.current = messages;

    if (status === "streaming" && (enteredStreaming || messagesProgressed)) {
      recordResponseProgress();
    }
  }, [messages, status, recordResponseProgress]);

  // A content-free assistant message the SDK opened to hold a data part that
  // arrived before the stream's `start` chunk must not outlive the turn: left in
  // chat state it becomes what the next request sends as its trailing message
  // and what a recovery's regenerate() anchors on, and the backend then reuses
  // its id — streaming the whole turn into a second message beside the first
  // (see pruneStrandedAssistantMessages). Pruning only once the stream has
  // settled keeps this off the live stream's back: nothing is writing to the
  // message list then, so it cannot fight the turn in flight.
  useEffect(() => {
    if (status === "submitted" || status === "streaming") {
      return;
    }
    setMessages((current) => {
      const pruned = pruneStrandedAssistantMessages(current);
      if (pruned === current) {
        return current;
      }
      // restoreRenderableAssistantParts reads previousMessagesRef to spot a
      // streaming regression; sync it so this deliberate shrink is not mistaken
      // for one and resurrected on the next render.
      previousMessagesRef.current = pruned;
      return pruned;
    });
  }, [status, setMessages]);

  // A silent stall is treated like a dropped connection. The hung stream is
  // ended client-side (the backend run keeps going: a client disconnect only
  // stops it when a stop flag is set), then the run is reattached through the
  // active-run replay. Once the attempts are used up, the stall notice shows.
  const { isTransportStalled } = useStreamStall({
    status,
    transportActivitySequence: streamActivity.transportSequence,
    responseProgressSequence: streamActivity.responseProgressSequence,
    messages,
  });
  // Keyed on the stall alone: re-running on identity changes of `stop` would
  // start a second recovery for the same stall.
  // biome-ignore lint/correctness/useExhaustiveDependencies: fires once per stall
  useEffect(() => {
    const recovery = stallRecoveryRef.current;
    if (!isTransportStalled || recovery.attempts >= MAX_STALL_RECOVERIES) {
      return;
    }
    recovery.attempts += 1;
    recovery.phase = "aborting";
    if (previousMessagesRef.current.length > 0) {
      frozenMessagesRef.current = previousMessagesRef.current;
    }
    setIsRecovering(true);
    // stop() ends a stream started by a send; a resumed stream only ends
    // through the transport's own abort.
    void stop();
    transport.abortReconnect();
  }, [isTransportStalled]);

  // Ends a recovery whose run already finished: shows the stored conversation
  // instead of the cut-off answer. If the fetch fails, the chat keeps the
  // messages the run started from.
  const loadPersistedMessages = useCallback(async () => {
    const conversation = await queryClient
      .fetchQuery({
        queryKey: ["conversation", conversationId],
        queryFn: () => fetchConversation(conversationId),
        staleTime: 0,
      })
      .catch(() => null);
    const persistedMessages = conversation?.messages as UIMessage[] | undefined;
    if (persistedMessages && persistedMessages.length > 0) {
      previousMessagesRef.current = persistedMessages;
      setMessages(persistedMessages);
    }
    setIsRecovering(false);
    setMcpElicitations([]);
    recoveredPersistedErrorRef.current = false;
    clearErrorRef.current?.();
  }, [queryClient, conversationId, setMessages, setIsRecovering]);

  // Replay once the aborted stream has settled. The replay restarts the run
  // from its first chunk, so the chat goes back to the messages the run started
  // from and the replay rebuilds the answer in full.
  useEffect(() => {
    const recovery = stallRecoveryRef.current;
    if (status !== "ready" || recovery.phase !== "aborting") {
      return;
    }
    recovery.phase = "replaying";
    // Empty the restore-on-regression buffer like the duplicate-run reattach:
    // it still holds the partial answer and would resurrect it while the
    // replay rebuilds the same message. The frozen snapshot keeps the text on
    // screen meanwhile.
    previousMessagesRef.current = [];
    setMessages(requestBaseMessagesRef.current);
    const errorSeq = errorSeqRef.current;
    void resumeStream().then(() => {
      // A finished replay clears the phase in onFinish and a failed one moves
      // it in onError. Still "replaying" with no new error means the reconnect
      // got a 204: the run ended before the reattach, so load what it stored.
      if (recovery.phase !== "replaying" || errorSeqRef.current !== errorSeq) {
        return;
      }
      recovery.phase = null;
      void loadPersistedMessages();
    });
  }, [status, resumeStream, setMessages, loadPersistedMessages]);

  const resumeAttemptedRef = useRef(false);
  useEffect(() => {
    if (!shouldResume || resumeAttemptedRef.current) {
      return;
    }

    resumeAttemptedRef.current = true;
    Promise.resolve(resumeStream()).finally(() => setResumeSettled(true));
  }, [resumeStream, shouldResume]);

  const messagesWithRestoredAssistantParts = restoreRenderableAssistantParts({
    previousMessages: previousMessagesRef.current,
    nextMessages: messages,
  });
  previousMessagesRef.current = messagesWithRestoredAssistantParts;

  // Keep sendMessageRef up-to-date for onFinish callback
  sendMessageRef.current = sendMessage;
  // Keep clearErrorRef up-to-date for the duplicate-run branch in onError
  clearErrorRef.current = clearError;

  const stableMessages = messagesWithRestoredAssistantParts;

  // While auto-recovery passes through its intermediate states (partial
  // answer dropped by regenerate, replay restarting from empty), keep showing
  // the snapshot captured when recovery started so streamed text never blinks
  // away. The replay delivers its whole backlog in the first batch, so by the
  // time the live list has renderable assistant content again it is at least
  // as long as the frozen view.
  const displayedMessages = shouldFreezeChatMessages({
    isRecovering: recoveringRef.current,
    liveMessages: stableMessages,
    frozenMessages: frozenMessagesRef.current,
  })
    ? frozenMessagesRef.current
    : stableMessages;

  // Reset retry counter only when the user sends a genuinely new message.
  // We track the last user message ID to avoid resetting during regenerate(),
  // which manipulates the messages array without a new user message.
  const lastStableUserMessage = [...stableMessages]
    .reverse()
    .find((m) => m.role === "user");
  if (
    lastStableUserMessage &&
    lastStableUserMessage.id !== lastUserMessageIdRef.current
  ) {
    lastUserMessageIdRef.current = lastStableUserMessage.id;
    retryCountRef.current = 0;
    stallRecoveryRef.current.attempts = 0;
    // A new turn: any pending "clear the prior turn's persisted error on a
    // successful retry" intent no longer applies to this turn.
    recoveredPersistedErrorRef.current = false;
  }

  useEffect(() => {
    if (optimisticToolCalls.length === 0) {
      return;
    }

    setOptimisticToolCalls((current) =>
      filterOptimisticToolCalls(stableMessages, current),
    );
  }, [stableMessages, optimisticToolCalls.length]);

  // A question whose tool call has finished is not waiting on anyone, even if
  // its resolved event never reached this client. Filtered at read time so a
  // replay that rebuilds the turn cannot resurrect it either.
  const pendingMcpElicitations = useMemo(
    () =>
      withoutFinishedToolCalls({
        requests: mcpElicitations,
        messages: stableMessages,
      }),
    [mcpElicitations, stableMessages],
  );
  // For resolveMcpElicitation, which runs after an await and must see the
  // questions as they are when its answer comes back.
  const pendingMcpElicitationsRef = useRef(pendingMcpElicitations);
  pendingMcpElicitationsRef.current = pendingMcpElicitations;

  // ---- Queued-message auto-drain -------------------------------------------
  // Messages submitted while a turn was in-flight wait in a per-conversation
  // persisted queue (see chat-message-queue.ts). Whenever this session settles
  // back to "ready", send the oldest one, or the whole queue when the user
  // explicitly interrupted to send it together. Living here (not in the page) means queues
  // keep draining while the user is viewing another conversation, since
  // ChatSessionHook instances survive conversation switches.
  const queuedMessages = useConversationMessageQueue(conversationId);
  // One-at-a-time guard: taking a message re-fires this effect (the queue
  // snapshot changes) possibly before the SDK's status has left "ready"; the
  // ref blocks a second send until a status transition confirms the turn
  // started. Reset on every status change away from "ready".
  const queueDrainInFlightRef = useRef(false);
  useEffect(() => {
    if (status !== "ready") {
      queueDrainInFlightRef.current = false;
    }
  }, [status]);
  // An unanswered tool approval keeps the turn logically open even though the
  // SDK reports "ready" — draining would orphan the approval, so wait for the
  // user's response (the SDK then auto-resubmits and the turn continues).
  const hasPendingApprovalRequest = stableMessages.some((message) =>
    message.parts.some(
      (part) => "state" in part && part.state === "approval-requested",
    ),
  );
  useEffect(() => {
    if (
      status !== "ready" ||
      error ||
      isStopping ||
      stopInFlightRef.current ||
      queuedMessages.length === 0 ||
      !resumeSettled ||
      queueDrainInFlightRef.current ||
      recoveringRef.current ||
      hasPendingApprovalRequest ||
      pendingMcpElicitations.length > 0 ||
      contextCompaction.isCompacting
    ) {
      return;
    }
    const batch = chatMessageQueue.takeForTurn(conversationId);
    if (batch.length === 0) return;
    queueDrainInFlightRef.current = true;
    const pending: UIMessage[] = batch.map((next) => {
      const fileParts = (next.files ?? []).map((file) => ({
        type: "file" as const,
        ...file,
      }));
      return {
        id: next.id,
        role: "user",
        parts:
          next.text.trim() || fileParts.length === 0
            ? [{ type: "text", text: next.text }, ...fileParts]
            : fileParts,
        metadata: {
          createdAt: next.queuedAt,
          ...(next.skill ? { skill: next.skill } : {}),
          ...(next.externalMcpSkill
            ? { externalMcpSkill: next.externalMcpSkill }
            : {}),
          ...(next.sandboxCommand ? { sandboxCommand: true as const } : {}),
        },
      };
    });
    // Keep each queued message and its metadata in the transcript. Appending
    // the prefix locally is synchronous in the SDK; only sending the last one
    // starts a request, carrying every queued message in the same model turn.
    if (pending.length > 1)
      setMessages((current) => [...current, ...pending.slice(0, -1)]);
    sendMessageRef.current?.(pending[pending.length - 1]);
  }, [
    status,
    setMessages,
    error,
    queuedMessages,
    isStopping,
    resumeSettled,
    hasPendingApprovalRequest,
    pendingMcpElicitations.length,
    contextCompaction.isCompacting,
    conversationId,
  ]);

  // A regenerate replaces the failed turn, so any persisted chat-error rows
  // are now stale — the backend never clears them on its own, and left behind
  // they keep rendering an error card above the regenerated answer (also after
  // a reload). Clear them only once the re-run is genuinely issued (clearing
  // before would wipe the card even when the resend never starts). Fire the
  // delete unconditionally rather than gating on the cached rows: the failed
  // turn persists its error row asynchronously, so the client cache often has
  // not loaded it yet at regenerate time — gating on it would skip the clear
  // and let the next conversation refetch resurrect the card. The delete is
  // idempotent and optimistically drops the rows from the cache. Destructure
  // the stable mutateAsync like updateChatMessageAsync above so
  // regenerateUserMessage stays referentially stable.
  const { mutateAsync: clearChatErrorsAsync } = clearChatErrors;
  const clearStalePersistedChatErrors = useCallback(() => {
    clearChatErrorsAsync({ id: conversationId }).catch((error) => {
      console.error(
        "[ChatSession] Failed to clear stale chat errors after regenerate",
        error,
      );
    });
  }, [clearChatErrorsAsync, conversationId]);

  // Save the user message's text, then re-run the assistant turn from it.
  const regenerateUserMessage = useCallback(
    async ({
      messageId,
      partIndex,
      text,
    }: {
      messageId: string;
      partIndex: number;
      text: string;
    }) => {
      // Snapshot the live thread before touching any state — it is the only
      // place that knows the live↔saved id mapping for in-session messages
      // (metadata.persistedMessageId, stamped by mergePersistedMessageMetadata).
      const liveMessages = previousMessagesRef.current;

      // Persist the (possibly edited) text and get the saved thread back, which
      // carries each message under its DB id.
      const data = await updateChatMessageAsync({ messageId, partIndex, text });
      const canonical = data?.messages as UIMessage[] | undefined;
      // In-session messages keep their AI SDK nanoid as the live id while the
      // saved thread keys them by DB UUID, so a plain id lookup misses them.
      // Resolve through metadata.persistedMessageId too — otherwise the first
      // edit before a reload falls into the regenerate-in-place path below and
      // re-sends the pre-edit text, making the model answer the old prompt.
      const anchorId = resolveCanonicalMessageId({
        messageId,
        liveMessages,
        canonicalMessages: canonical,
      });

      // Break the restore-on-regression chain before regenerating, like the
      // auto-retry and 409-reattach paths do: regenerate() rebuilds the edited
      // turn's assistant message from empty, and a buffer still holding the
      // pre-edit answer would keep resurrecting it while the new stream writes
      // the same message id — two writers fighting over one message in an
      // update loop that crashes the page (React #185, "Maximum update
      // depth"). The pre-edit answer is meant to disappear here, so no frozen
      // snapshot is taken.
      previousMessagesRef.current = [];

      if (canonical && anchorId) {
        // Normal path: the message is persisted. Sync to the saved thread and
        // regenerate from it. The server replaces the turn atomically.
        setMessages(canonical);
        void regenerate({ messageId: anchorId });
        clearStalePersistedChatErrors();
      }
    },
    [
      updateChatMessageAsync,
      setMessages,
      regenerate,
      clearStalePersistedChatErrors,
    ],
  );

  // Always keep the session ref up-to-date with the latest values (including
  // function references from useChat which change every render). This is a ref
  // update only — no state changes, no re-renders.
  const sessionRef = useRef<ChatSession>(null as unknown as ChatSession);
  const stopSession = useCallback(
    (options?: {
      preserveQueuedMessages?: boolean;
      interruptQueued?: boolean;
      stopServer?: () => Promise<unknown>;
    }) => {
      if (stopInFlightRef.current) return;
      // Recheck against the live session when a click races stream updates.
      if (
        options?.interruptQueued &&
        (!["submitted", "streaming"].includes(latestStatusRef.current) ||
          chatMessageQueue.get(conversationId).length === 0 ||
          chatMessageQueue
            .get(conversationId)
            .some((message) => message.sandboxCommand) ||
          getQueueInterruptBlockedReason({
            messages: latestMessagesRef.current,
            hasPendingQuestion: pendingMcpElicitationsRef.current.length > 0,
            isCompacting: contextCompaction.isCompacting,
          }))
      )
        return;
      if (options?.interruptQueued)
        chatMessageQueue.requestBatch(conversationId);
      const activeUserMessageId = latestMessagesRef.current.findLast(
        (message) => message.role === "user",
      )?.id;
      preserveQueuedMessagesOnAbortRef.current = options?.preserveQueuedMessages
        ? { userMessageId: activeUserMessageId }
        : null;
      // stop() alone cannot end a resumed stream (a reload mid-run, or a
      // reattach); the transport aborts that one.
      if (!options?.stopServer) {
        stop();
        transport.abortReconnect();
        return;
      }

      stopInFlightRef.current = true;
      setIsStopping(true);
      const finishStop = async () => {
        const latestUserMessageId = latestMessagesRef.current.findLast(
          (message) => message.role === "user",
        )?.id;
        const responseStillInFlight =
          latestStatusRef.current === "submitted" ||
          latestStatusRef.current === "streaming";
        if (
          responseStillInFlight &&
          latestUserMessageId === activeUserMessageId
        ) {
          await stop();
          transport.abortReconnect();
        }
        stopInFlightRef.current = false;
        setIsStopping(false);
      };
      void options.stopServer().then(finishStop, () => {
        stopInFlightRef.current = false;
        setIsStopping(false);
      });
    },
    [stop, transport, conversationId, contextCompaction.isCompacting],
  );
  const sendOrQueueText = useCallback(
    (text: string) => {
      const busy =
        latestStatusRef.current === "submitted" ||
        latestStatusRef.current === "streaming" ||
        contextCompaction.isCompacting ||
        chatMessageQueue.get(conversationId).length > 0;
      if (busy) {
        chatMessageQueue.enqueue(conversationId, { text });
        return;
      }
      sendMessage({
        role: "user",
        parts: [{ type: "text", text }],
        metadata: { createdAt: new Date().toISOString() },
      });
    },
    [contextCompaction.isCompacting, conversationId, sendMessage],
  );
  const resolveMcpElicitation = useCallback(
    async (response: ElicitationResponse) => {
      const outcome = await resolveMcpElicitationAsync({
        id: response.id,
        conversationId,
        action: response.action,
        content: response.content,
      });
      if (outcome === "failed") {
        // Already reported; the question stays up for another try, but a
        // bounded clear prevents a permanently failing submit from blocking
        // the message queue forever.
        if (!elicitationFailureClearTimersRef.current.has(response.id)) {
          elicitationFailureClearTimersRef.current.set(
            response.id,
            setTimeout(() => {
              elicitationFailureClearTimersRef.current.delete(response.id);
              if (
                pendingMcpElicitationsRef.current.some(
                  (request) => request.id === response.id,
                )
              ) {
                settleMcpElicitation(response.id);
              }
            }, MCP_ELICITATION_FAILURE_CLEAR_MS),
          );
        }
        return false;
      }
      clearElicitationFailureTimer(response.id);
      // A 409 means the backend is no longer waiting on this question.
      // Only notify when no earlier event or completed tool call retired it.
      const unexplained =
        outcome === "stale" &&
        pendingMcpElicitationsRef.current.some(
          (request) => request.id === response.id,
        );
      settleMcpElicitation(response.id);
      if (unexplained) {
        toast.info("This question is no longer waiting for an answer.", {
          id: "mcp-elicitation-stale",
        });
      }
      return true;
    },
    [
      clearElicitationFailureTimer,
      conversationId,
      resolveMcpElicitationAsync,
      settleMcpElicitation,
    ],
  );
  sessionRef.current = {
    conversationId,
    messages: displayedMessages,
    transportActivitySequence: streamActivity.transportSequence,
    responseProgressSequence: streamActivity.responseProgressSequence,
    stallRecoveryExhausted:
      stallRecoveryRef.current.attempts >= MAX_STALL_RECOVERIES,
    sendMessage,
    sendOrQueueText,
    regenerateUserMessage,
    stop: stopSession,
    status,
    error,
    setMessages,
    addToolResult,
    addToolApprovalResponse,
    pendingMcpElicitations,
    resolveMcpElicitation,
    mcpTasks,
    // Computed, not stored: the page paints the SDK error before onError has
    // run (so no flag set inside onError can suppress the first frame), and
    // consumers read the session from a map refreshed an effect-cycle later.
    // Instead, derive "this error will be auto-recovered" synchronously from
    // the same predicates onError uses — a pure function of the error and the
    // retry budget, correct at any render including the very first one.
    // recoveringRef keeps it true after onError consumed the error (retry
    // timer pending / reattach in flight) and onFinish/terminal paths clear it.
    get isRecovering() {
      if (recoveringRef.current) {
        return true;
      }
      if (!error) {
        return false;
      }
      return (
        isDuplicateActiveRunError(error) ||
        (isRetryableError(error) && retryCountRef.current < MAX_AUTO_RETRIES)
      );
    },
    optimisticToolCalls,
    tokenUsage,
    contextTokensUsed,
    contextWindow,
    contextCompaction,
    recordContextCompaction,
    beginManualContextCompaction,
    endManualContextCompaction,
    earlyToolUiStarts,
  };

  // Sync to the shared sessions map and notify consumers.
  // All chat state values are listed as deps so the effect fires when any value
  // changes, even though we read them through the ref for the latest snapshot.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional — deps trigger the sync, ref provides the snapshot
  useEffect(() => {
    sessionsRef.current.set(conversationId, sessionRef.current);
    notifySessionUpdate({ conversationId, status });
  }, [
    conversationId,
    stableMessages,
    streamActivity,
    sendMessage,
    sendOrQueueText,
    regenerateUserMessage,
    stopSession,
    status,
    error,
    setMessages,
    addToolResult,
    addToolApprovalResponse,
    pendingMcpElicitations,
    resolveMcpElicitation,
    mcpTasks,
    isRecoveringState,
    isTransportStalled,
    optimisticToolCalls,
    tokenUsage,
    contextTokensUsed,
    contextWindow,
    contextCompaction,
    recordContextCompaction,
    beginManualContextCompaction,
    endManualContextCompaction,
    earlyToolUiStarts,
    sessionsRef,
    notifySessionUpdate,
  ]);

  return (
    <McpElicitationDialog
      request={
        pendingMcpElicitations.find(
          (request) => !isChoiceElicitationRequest(request),
        ) ?? null
      }
      isSubmitting={resolveMcpElicitationMutation.isPending}
      onRespond={resolveMcpElicitation}
    />
  );
}

/**
 * Drop questions raised by a tool call that already reached a terminal state.
 * Returns `requests` itself when nothing is dropped, so the list keeps its
 * identity for effect dependencies.
 */
function withoutFinishedToolCalls({
  requests,
  messages,
}: {
  requests: ChatMcpElicitationRequest[];
  messages: UIMessage[];
}): ChatMcpElicitationRequest[] {
  const toolCallIds = new Set(
    requests.flatMap((request) =>
      request.toolCallId ? [request.toolCallId] : [],
    ),
  );
  if (toolCallIds.size === 0) {
    return requests;
  }
  const finished = new Set<string>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const part of message.parts) {
      if (
        "toolCallId" in part &&
        typeof part.toolCallId === "string" &&
        toolCallIds.has(part.toolCallId) &&
        "state" in part &&
        (part.state === "output-available" ||
          part.state === "output-error" ||
          part.state === "output-denied")
      ) {
        finished.add(part.toolCallId);
      }
    }
  }
  if (finished.size === 0) {
    return requests;
  }
  return requests.filter(
    (request) => !request.toolCallId || !finished.has(request.toolCallId),
  );
}

function getCurrentArchestraToolShortName(
  toolName: string,
  appName: string,
): string | null {
  return getArchestraToolShortName(toolName, {
    appName,
    fullWhiteLabeling: appConfig.enterpriseFeatures.fullWhiteLabeling,
    includeDefaultPrefix: true,
  });
}
