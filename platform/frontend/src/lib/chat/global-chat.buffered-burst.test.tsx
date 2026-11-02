import type { UIMessage } from "@ai-sdk/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { useAppName } from "@/lib/hooks/use-app-name";
import {
  ChatProvider,
  useChatSessionSnapshot,
  useGlobalChat,
} from "./global-chat.context";

// The real useChat, transport and session hook run against a stubbed fetch:
// the failure is an interaction between the SDK's stream processing and
// React's update scheduling, which a mocked useChat cannot reproduce.

type ChatSessionSnapshot = ReturnType<
  ReturnType<typeof useGlobalChat>["getSession"]
>;

const mocks = vi.hoisted(() => ({
  generateTitle: { isPending: false, mutate: () => {} },
  resolveMcpElicitation: { isPending: false, mutateAsync: async () => {} },
  clearChatErrors: { mutateAsync: async () => ({}) },
}));

vi.mock("sonner");

vi.mock("@/lib/chat/chat.query", () => ({
  fetchConversation: vi.fn(),
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

const CONVERSATION_ID = "conversation-burst";
const DELTA_COUNT = 200;
const EXPECTED_TEXT = Array.from(
  { length: DELTA_COUNT },
  (_, index) => `${index} `,
).join("");

describe("buffered stream burst", () => {
  let session: ChatSessionSnapshot;
  // Every error the session showed: auto-retry may clear one before the end.
  let sessionErrors: string[];

  beforeAll(async () => {
    // ChatProvider loads the session hook lazily; load it before timing.
    await import("./chat-session-hook");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("completes a turn whose chunks arrive faster than the page renders them", async () => {
    vi.mocked(useAppName).mockReturnValue("Archestra");
    sessionErrors = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input) === "/api/chat" && init?.method === "POST") {
          return bufferedTurnResponse();
        }
        throw new Error(`Unexpected fetch: ${init?.method ?? "GET"} ${input}`);
      }),
    );

    render(
      <QueryClientProvider client={new QueryClient()}>
        <ChatProvider>
          <RegisterChatSession />
          <CaptureChatSession
            onSession={(next) => {
              session = next;
              if (next?.error) {
                sessionErrors.push(next.error.message);
              }
            }}
          />
        </ChatProvider>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(session?.sendMessage).toBeDefined());

    // Every clock read moves 150 ms on, so each chunk looks like it took
    // longer than the SDK's 100 ms render throttle — what a large assistant
    // message costs per chunk on a slow page. With the whole response already
    // buffered, the SDK drains it in one run of microtasks.
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => {
      now += 150;
      return now;
    });

    act(() => {
      session?.sendMessage({ text: "Hi" });
    });

    await waitFor(() => expect(session?.status).not.toBe("submitted"));
    await waitFor(() => expect(session?.status).not.toBe("streaming"), {
      timeout: 10_000,
    });

    // If this fails with "Maximum update depth exceeded", message updates are
    // reaching React synchronously inside the SDK's stream processing again:
    // check that useOffStreamChat still intercepts the SDK's
    // `~registerMessagesCallback` (see use-off-stream-chat.ts).
    expect(sessionErrors).toEqual([]);
    expect(session?.status).toBe("ready");
    await waitFor(() => expect(assistantText(session)).toBe(EXPECTED_TEXT));
  });
});

// ===========================================================================
// Internal
// ===========================================================================

function assistantText(session: ChatSessionSnapshot): string {
  return (session?.messages ?? [])
    .filter((message: UIMessage) => message.role === "assistant")
    .flatMap((message: UIMessage) =>
      message.parts.flatMap((part) =>
        part.type === "text" ? [part.text] : [],
      ),
    )
    .join("");
}

/** One complete turn, every chunk enqueued before the SDK starts reading. */
function bufferedTurnResponse() {
  const chunks = [
    { type: "start", messageId: "assistant-1" },
    { type: "start-step" },
    { type: "text-start", id: "text-1" },
    ...Array.from({ length: DELTA_COUNT }, (_, index) => ({
      type: "text-delta",
      id: "text-1",
      delta: `${index} `,
    })),
    { type: "text-end", id: "text-1" },
    { type: "finish-step" },
    { type: "finish" },
  ];
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`),
        );
      }
      controller.close();
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
  const session = useChatSessionSnapshot(CONVERSATION_ID);

  useEffect(() => {
    onSession(session ?? undefined);
  }, [onSession, session]);

  return null;
}
