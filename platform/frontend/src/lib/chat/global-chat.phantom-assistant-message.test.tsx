import type { UIMessage } from "@ai-sdk/react";
import { render, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAppName } from "@/lib/hooks/use-app-name";
import { ChatProvider, useGlobalChat } from "./global-chat.context";

// These exercise the REAL `ai` / `@ai-sdk/react` against a scripted stream: the
// defect lives in how the SDK turns wire chunks into its message list, which a
// mocked `useChat` (see global-chat.context.test.tsx) cannot reproduce. Only
// `fetch` is stubbed.

const mocks = vi.hoisted(() => ({
  clearChatErrors: vi.fn(),
  getQueryData: vi.fn(),
  invalidateQueries: vi.fn(),
  mutate: vi.fn(),
  mutateAsync: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

vi.mock("@tanstack/react-query", () => {
  const queryClient = {
    getQueryData: mocks.getQueryData,
    invalidateQueries: mocks.invalidateQueries,
  };
  return {
    useQueryClient: () => queryClient,
    useMutation: () => ({ mutateAsync: mocks.mutateAsync }),
  };
});

vi.mock("@/lib/chat/chat.query", () => ({
  useGenerateConversationTitle: () => ({
    isPending: false,
    mutate: mocks.mutate,
  }),
  useResolveChatMcpElicitation: () => ({
    isPending: false,
    mutateAsync: mocks.mutateAsync,
  }),
  useClearChatErrors: () => ({ mutateAsync: mocks.clearChatErrors }),
  useConversation: () => ({ data: null }),
  useConversationUpdatedCacheSync: () => {},
}));

vi.mock("@/components/chat/mcp-elicitation-dialog", () => ({
  McpElicitationDialog: () => null,
}));

vi.mock("@/lib/hooks/use-app-name");

vi.mock("@/lib/config/config", () => ({
  default: { enterpriseFeatures: { fullWhiteLabeling: false } },
}));

vi.mock("@/lib/config/config.query", () => ({ useFeature: () => false }));

const CONVERSATION_ID = "conversation-phantom";
const SERVER_MESSAGE_ID = "srv-assistant-1";

type ScriptedStream = {
  emit: (chunk: Record<string, unknown>) => void;
  close: () => void;
  fail: (error: Error) => void;
};

function sseResponse(): { response: Response; stream: ScriptedStream } {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return {
    response: new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }),
    stream: {
      emit: (chunk) =>
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`),
        ),
      close: () => controller.close(),
      fail: (error) => controller.error(error),
    },
  };
}

/** The turn the backend streams: telemetry data parts, then the real content. */
function emitPreStartTelemetry(stream: ScriptedStream) {
  // Written by the route before the model stream's `start` chunk. Non-transient
  // here on purpose: that is the shape this regression is about, and the client
  // must survive it whatever a given backend build marks.
  stream.emit({
    type: "data-context-window-estimate",
    data: { estimatedTokens: 1234 },
  });
  stream.emit({
    type: "data-context-window-breakdown",
    data: { totalTokens: 1234, categories: [] },
  });
}

function emitTurn(stream: ScriptedStream, messageId: string) {
  stream.emit({ type: "start", messageId });
  stream.emit({ type: "start-step" });
  stream.emit({ type: "reasoning-start", id: "reasoning-0" });
  stream.emit({
    type: "reasoning-delta",
    id: "reasoning-0",
    delta: "weighing",
  });
  stream.emit({ type: "reasoning-end", id: "reasoning-0" });
  stream.emit({ type: "text-start", id: "txt-0" });
  stream.emit({ type: "text-delta", id: "txt-0", delta: "the answer" });
}

function finishTurn(stream: ScriptedStream) {
  stream.emit({ type: "text-end", id: "txt-0" });
  stream.emit({ type: "finish-step" });
  stream.emit({ type: "finish" });
  stream.close();
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const assistantMessages = (messages: UIMessage[]) =>
  messages.filter((message) => message.role === "assistant");

function RegisterAndSend({ prompt }: { prompt: string }) {
  const { registerSession, getSession } = useGlobalChat();
  const session = getSession(CONVERSATION_ID);

  useEffect(() => {
    registerSession({ conversationId: CONVERSATION_ID, initialMessages: [] });
  }, [registerSession]);

  const sendMessage = session?.sendMessage;
  useEffect(() => {
    if (!sendMessage) {
      return;
    }
    sendMessage({ role: "user", parts: [{ type: "text", text: prompt }] });
  }, [sendMessage, prompt]);

  return null;
}

describe("phantom assistant messages", () => {
  let sessions: Array<
    ReturnType<ReturnType<typeof useGlobalChat>["getSession"]>
  >;
  let chatRequests: Array<{ url: string; body: Record<string, unknown> }>;

  const latestMessages = () => sessions.at(-1)?.messages ?? [];

  function CaptureSession() {
    const { getSession } = useGlobalChat();
    const session = getSession(CONVERSATION_ID);
    useEffect(() => {
      if (session) {
        sessions.push(session);
      }
    }, [session]);
    return null;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useAppName).mockReturnValue("Archestra");
    mocks.clearChatErrors.mockResolvedValue({ success: true });
    mocks.mutateAsync.mockResolvedValue({});
    sessions = [];
    chatRequests = [];
  });

  it("keeps a single assistant message when telemetry arrives before the stream's start chunk", async () => {
    const first = sseResponse();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown, init?: RequestInit) => {
        const url = String(
          typeof input === "string" ? input : (input as Request)?.url,
        );
        chatRequests.push({
          url,
          body: JSON.parse(String(init?.body ?? "{}")),
        });
        return first.response;
      }),
    );

    render(
      <ChatProvider>
        <RegisterAndSend prompt="how much was spent on ads?" />
        <CaptureSession />
      </ChatProvider>,
    );

    await waitFor(() => expect(chatRequests).toHaveLength(1));

    emitPreStartTelemetry(first.stream);
    emitTurn(first.stream, SERVER_MESSAGE_ID);
    await waitFor(() =>
      expect(
        latestMessages().some((message) =>
          message.parts.some(
            (part) => part.type === "text" && part.text === "the answer",
          ),
        ),
      ).toBe(true),
    );
    finishTurn(first.stream);

    await waitFor(() => expect(sessions.at(-1)?.status).toBe("ready"));

    // One user turn answered once: the message the SDK opened to hold the
    // pre-start telemetry must not survive beside the real one.
    await waitFor(() => {
      const assistants = assistantMessages(latestMessages());
      expect(assistants.map((message) => message.id)).toEqual([
        SERVER_MESSAGE_ID,
      ]);
    });
  });

  it("renders the turn once when a severed stream is recovered by the active-run replay", async () => {
    const first = sseResponse();
    let replay: ScriptedStream | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown, init?: RequestInit) => {
        const url = String(
          typeof input === "string" ? input : (input as Request)?.url,
        );
        chatRequests.push({
          url,
          body: JSON.parse(String(init?.body ?? "{}")),
        });
        if (chatRequests.length === 1) {
          return first.response;
        }
        // The auto-retry re-POSTs into the still-live run, so the backend
        // answers the duplicate-run 409 and the session reattaches to the
        // active-run replay — which re-sends the run from its first chunk.
        if (url.includes("/active-run")) {
          const replayed = sseResponse();
          replay = replayed.stream;
          return replayed.response;
        }
        return new Response(
          JSON.stringify({
            error: {
              message:
                "This conversation already has an active response. Stop it before sending another message.",
              type: "api_conflict_error",
            },
          }),
          { status: 409, headers: { "content-type": "application/json" } },
        );
      }),
    );

    render(
      <ChatProvider>
        <RegisterAndSend prompt="how much was spent on ads?" />
        <CaptureSession />
      </ChatProvider>,
    );

    await waitFor(() => expect(chatRequests).toHaveLength(1));

    emitPreStartTelemetry(first.stream);
    emitTurn(first.stream, SERVER_MESSAGE_ID);
    await waitFor(() =>
      expect(
        latestMessages().some((message) =>
          message.parts.some(
            (part) => part.type === "text" && part.text === "the answer",
          ),
        ),
      ).toBe(true),
    );

    // The connection dies while the backend keeps generating.
    first.stream.fail(new TypeError("network error"));

    // The session auto-retries 1.5s later; that resend must re-run the user's
    // turn, not adopt a telemetry-only assistant message as the turn to
    // continue — the server would then reuse its id and stream the whole turn
    // into a second message beside the first.
    await waitFor(() => expect(chatRequests.length).toBeGreaterThan(1), {
      timeout: 5000,
    });
    const resentMessages = chatRequests[1].body.messages as UIMessage[];
    expect(resentMessages.at(-1)?.role).toBe("user");

    // The replay re-sends the run from its first chunk, telemetry included.
    await waitFor(() => expect(replay).toBeDefined());
    if (!replay) {
      throw new Error("replay stream was never opened");
    }
    emitPreStartTelemetry(replay);
    emitTurn(replay, SERVER_MESSAGE_ID);
    finishTurn(replay);

    await waitFor(() => expect(sessions.at(-1)?.status).toBe("ready"));

    // One user turn, one assistant turn: the recovered run must land in the
    // message the replay names, not beside a copy left over from the severed
    // attempt or from a telemetry-only message the SDK opened for either.
    await waitFor(() => {
      const messages = latestMessages();
      expect(assistantMessages(messages).map((message) => message.id)).toEqual([
        SERVER_MESSAGE_ID,
      ]);
      const answerParts = messages.flatMap((message) =>
        message.parts.filter(
          (part) => part.type === "text" && part.text === "the answer",
        ),
      );
      expect(answerParts).toHaveLength(1);
    });
  });
});
