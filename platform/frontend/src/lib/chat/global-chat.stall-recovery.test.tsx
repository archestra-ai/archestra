import type { UIMessage } from "@ai-sdk/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppName } from "@/lib/hooks/use-app-name";
import { ChatProvider, useGlobalChat } from "./global-chat.context";

// The real useChat and transport run against a stubbed fetch, so these tests
// cover what the replay does to the message list, not which SDK calls happen.

type ChatSessionSnapshot = ReturnType<
  ReturnType<typeof useGlobalChat>["getSession"]
>;

// Stable across renders, like the real mutation hooks: a fresh function per
// render would change the session's callbacks and re-sync it endlessly.
const mocks = vi.hoisted(() => ({
  fetchConversation: vi.fn(),
  generateTitle: { isPending: false, mutate: () => {} },
  resolveMcpElicitation: { isPending: false, mutateAsync: async () => {} },
  clearChatErrors: { mutateAsync: async () => ({}) },
}));

vi.mock("sonner");

vi.mock("@/lib/chat/chat.query", () => ({
  fetchConversation: mocks.fetchConversation,
  useGenerateConversationTitle: () => mocks.generateTitle,
  useResolveChatMcpElicitation: () => mocks.resolveMcpElicitation,
  useClearChatErrors: () => mocks.clearChatErrors,
  useConversation: () => ({ data: null }),
  useConversationUpdatedCacheSync: () => {},
}));

vi.mock("@/lib/hooks/use-app-name");

vi.mock("@/lib/config/config", () => ({
  default: { enterpriseFeatures: { fullWhiteLabeling: false } },
}));

vi.mock("@/lib/config/config.query", () => ({
  useFeature: () => false,
}));

const CONVERSATION_ID = "conversation-1";
const STALL_MS = 40_000;

describe("stalled stream recovery", () => {
  let replays: ReplayBehavior[];
  let replayRequests: number;
  let session: ChatSessionSnapshot;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.mocked(useAppName).mockReturnValue("Archestra");
    mocks.fetchConversation.mockReset();
    replays = [];
    replayRequests = 0;
    session = undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/chat" && init?.method === "POST") {
          return streamResponse({ deltas: ["Hello w"], hang: true, init });
        }
        if (url === `/api/chat/conversations/${CONVERSATION_ID}/active-run`) {
          const behavior = replays[replayRequests] ?? "complete";
          replayRequests += 1;
          if (behavior === "finished") {
            return new Response(null, { status: 204 });
          }
          if (behavior === "unanswered") {
            return new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener("abort", () => {
                reject(new DOMException("Aborted", "AbortError"));
              });
            });
          }
          return streamResponse({
            deltas: behavior === "stall" ? ["Hello w"] : ["Hello w", "orld"],
            hang: behavior === "stall",
            init,
          });
        }
        throw new Error(`Unexpected fetch: ${init?.method ?? "GET"} ${url}`);
      }),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("replays the run once instead of appending it to the partial answer", async () => {
    replays = ["complete"];
    await startStalledTurn();

    await advance(STALL_MS);

    expect(replayRequests).toBe(1);
    expect(assistantTexts(session)).toEqual(["Hello world"]);
    expect(session?.status).toBe("ready");
    expect(session?.stallRecoveryExhausted).toBe(false);
  });

  it("recovers when the replay itself stalls", async () => {
    replays = ["stall", "complete"];
    await startStalledTurn();

    await advance(STALL_MS);
    expect(replayRequests).toBe(1);
    expect(session?.status).toBe("streaming");

    // The hung replay is ended and the run reattached a second time.
    await advance(STALL_MS);

    expect(replayRequests).toBe(2);
    expect(assistantTexts(session)).toEqual(["Hello world"]);
    expect(session?.status).toBe("ready");
  });

  it("flags the stall notice once every reattach has stalled", async () => {
    replays = ["stall", "stall", "stall"];
    await startStalledTurn();

    for (const attempt of [1, 2, 3]) {
      await advance(STALL_MS);
      expect(replayRequests).toBe(attempt);
    }
    expect(session?.stallRecoveryExhausted).toBe(true);

    // No fourth reattach: the stalled replay stays open for the user to stop.
    await advance(STALL_MS);
    expect(replayRequests).toBe(3);
    expect(session?.status).toBe("streaming");
    expect(assistantTexts(session)).toEqual(["Hello w"]);
  });

  it("retries a reattach whose request never gets a response", async () => {
    replays = ["unanswered", "complete"];
    await startStalledTurn();

    await advance(STALL_MS);
    expect(replayRequests).toBe(1);

    // The connect timeout ends the hung request and the next attempt follows.
    await advance(20_000);

    expect(replayRequests).toBe(2);
    expect(assistantTexts(session)).toEqual(["Hello world"]);
    expect(session?.status).toBe("ready");
    expect(session?.error).toBeUndefined();
  });

  it("loads the stored answer when the run finished before the reattach", async () => {
    replays = ["finished"];
    mocks.fetchConversation.mockResolvedValue({
      messages: [
        { id: "user-1", role: "user", parts: [{ type: "text", text: "Hi" }] },
        {
          id: "assistant-1",
          role: "assistant",
          parts: [{ type: "text", text: "Hello world" }],
        },
      ],
    });
    await startStalledTurn();

    await advance(STALL_MS);

    expect(mocks.fetchConversation).toHaveBeenCalledWith(CONVERSATION_ID);
    expect(assistantTexts(session)).toEqual(["Hello world"]);
    expect(session?.isRecovering).toBe(false);
  });

  async function startStalledTurn() {
    const queryClient = new QueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <ChatProvider>
          <RegisterChatSession />
          <CaptureChatSession
            onSession={(next) => {
              session = next;
            }}
          />
        </ChatProvider>
      </QueryClientProvider>,
    );
    await advance(0);
    act(() => {
      session?.sendMessage({ text: "Hi" });
    });
    // Let the partial answer through the SDK's render throttle.
    await advance(500);
    expect(assistantTexts(session)).toEqual(["Hello w"]);
    expect(session?.status).toBe("streaming");
  }
});

// ===========================================================================
// Internal
// ===========================================================================

/**
 * What one active-run replay does: stream the whole answer, stall partway
 * through it, never respond at all, or answer 204 because the run already
 * finished.
 */
type ReplayBehavior = "complete" | "stall" | "unanswered" | "finished";

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function assistantTexts(session: ChatSessionSnapshot): string[] {
  return (session?.messages ?? [])
    .filter((message: UIMessage) => message.role === "assistant")
    .flatMap((message: UIMessage) =>
      message.parts.flatMap((part) =>
        part.type === "text" ? [part.text] : [],
      ),
    );
}

/**
 * A UI message stream for one run. A hanging stream stops after its deltas and
 * stays open until the request's signal aborts it, like a connection that went
 * silent.
 */
function streamResponse({
  deltas,
  hang,
  init,
}: {
  deltas: string[];
  hang: boolean;
  init: RequestInit | undefined;
}) {
  const chunks = [
    { type: "start", messageId: "assistant-1" },
    { type: "text-start", id: "text-1" },
    ...deltas.map((delta) => ({ type: "text-delta", id: "text-1", delta })),
    ...(hang ? [] : [{ type: "text-end", id: "text-1" }, { type: "finish" }]),
  ];
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`),
        );
      }
      if (!hang) {
        controller.close();
        return;
      }
      init?.signal?.addEventListener("abort", () => {
        controller.error(new DOMException("Aborted", "AbortError"));
      });
    },
  });
  return new Response(body, {
    headers: { "Content-Type": "text/event-stream" },
  });
}

function RegisterChatSession() {
  const { registerSession } = useGlobalChat();

  useEffect(() => {
    registerSession({ conversationId: CONVERSATION_ID });
  }, [registerSession]);

  return null;
}

function CaptureChatSession({
  onSession,
}: {
  onSession: (session: ChatSessionSnapshot) => void;
}) {
  const { getSession } = useGlobalChat();
  const session = getSession(CONVERSATION_ID);

  useEffect(() => {
    onSession(session ?? undefined);
  }, [onSession, session]);

  return null;
}
