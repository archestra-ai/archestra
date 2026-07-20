import { act, render, renderHook, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { recordingStore } from "@/lib/app-session-recording/app-recording-store";
import { snapshotConversationTranscript } from "@/lib/app-session-recording/app-recording-transcript";
import { useFeature } from "@/lib/config/config.query";
import {
  type AppSessionRecorder,
  type AppSessionRecorderHandle,
  AppSessionRecorderProvider,
  useAppSessionRecorder,
  useOwnAppSessionRecorder,
} from "./use-app-session-recorder";

// The recorder assembles a bundle and writes it to the client-side store (an
// in-memory store here, since jsdom has no IndexedDB). Mock the surrounding
// query/app/session hooks so the surface renders without a QueryClient.
vi.mock("@/lib/config/config.query");
vi.mock("@/lib/app-session-recording/app-recording.query", () => ({
  useInvalidateAppRecording: () => vi.fn(),
}));
vi.mock("@/lib/app.query", () => ({
  useApp: () => ({ data: { id: "app", name: "Test App" } }),
}));
vi.mock("@/lib/auth/auth.query", () => ({
  useSession: () => ({ data: { user: { name: "Tester" } } }),
}));
// The chat transcript is snapshotted from the live conversation at stop time;
// stub that boundary so the recorder test doesn't reach the chat API.
vi.mock("sonner");
vi.mock("@/lib/app-session-recording/app-recording-transcript", () => ({
  snapshotConversationTranscript: vi.fn(),
}));

const mockSnapshot = vi.mocked(snapshotConversationTranscript);

// A fresh conversation id per test — the recording store is module-level, so a
// shared id would leak stored bundles across tests.
function freshConversationId(tag: string) {
  return `conv-${Math.round(performance.now())}-${tag}`;
}

// Bundle validation requires real UUID app ids.
const APP_ID = "3b1f8d3e-8f5a-4c57-9a4e-2f60cf1f2b01";

const TRANSCRIPT: Awaited<ReturnType<typeof snapshotConversationTranscript>> = [
  { id: "m1", role: "user", atMs: -1, parts: [{ type: "text", text: "hi" }] },
];

function fakeIframe() {
  const postMessage = vi.fn();
  const el = { contentWindow: { postMessage } } as unknown as HTMLIFrameElement;
  return { el, postMessage };
}

/**
 * The chat page's recorder tree in miniature: the surface owns the handle
 * (like ChatPageContent) and provides it to two consumers — the composer
 * control and an app frame. Probes expose the latest render's values.
 */
type Probes = {
  handle: AppSessionRecorderHandle | null;
  composer: AppSessionRecorder | null;
  frame: AppSessionRecorder | null;
};

function Consumer({
  probes,
  slot,
}: {
  probes: Probes;
  slot: "composer" | "frame";
}) {
  probes[slot] = useAppSessionRecorder();
  return null;
}

function Surface({
  conversationId,
  appId,
  probes,
}: {
  conversationId: string | null;
  appId: string | null;
  probes: Probes;
}) {
  const handle = useOwnAppSessionRecorder({ conversationId, appId });
  probes.handle = handle;
  return (
    <AppSessionRecorderProvider recorder={handle}>
      <Consumer probes={probes} slot="composer" />
      <Consumer probes={probes} slot="frame" />
    </AppSessionRecorderProvider>
  );
}

function renderChatSurface(initial: {
  conversationId: string | null;
  appId?: string | null;
}) {
  const probes: Probes = { handle: null, composer: null, frame: null };
  const appId = initial.appId ?? null;
  const view = render(
    <Surface
      conversationId={initial.conversationId}
      appId={appId}
      probes={probes}
    />,
  );
  return {
    get handle() {
      return probes.handle as AppSessionRecorderHandle;
    },
    get composer() {
      return probes.composer as AppSessionRecorder;
    },
    get frame() {
      return probes.frame as AppSessionRecorder;
    },
    showConversation(conversationId: string | null) {
      view.rerender(
        <Surface
          conversationId={conversationId}
          appId={appId}
          probes={probes}
        />,
      );
    },
    unmount: view.unmount,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSnapshot.mockResolvedValue(TRANSCRIPT);
  // The recorder self-gates on the deployment flag; these tests exercise an
  // enabled deployment.
  vi.mocked(useFeature).mockReturnValue(true);
});

describe("useAppSessionRecorder", () => {
  it("shares one recorder across every surface of the chat", () => {
    // The composer control and the app frame both read the page's provider —
    // control and status are consistent no matter which surface the user
    // drives.
    const surface = renderChatSurface({
      conversationId: freshConversationId("a"),
    });

    expect(surface.composer.status).toBe("idle");
    expect(surface.frame.status).toBe("idle");

    // The app frame reports the served HTML, then the composer starts recording.
    act(() => {
      surface.frame.runtimeHooks.captureSnapshot("<h1>v1</h1>", 1);
      surface.composer.start();
    });

    expect(surface.composer.status).toBe("recording");
    expect(surface.frame.status).toBe("recording");
  });

  it("stores a bundle with the chat transcript and events captured after the frame moves surfaces", async () => {
    const conversationId = freshConversationId("b");
    const surface = renderChatSurface({ conversationId, appId: APP_ID });

    const inlineFrame = fakeIframe();
    const panelFrame = fakeIframe();

    // Recording starts while the app is inline, bound to the inline frame.
    act(() => {
      surface.frame.runtimeHooks.bindIframe(inlineFrame.el);
      surface.frame.runtimeHooks.captureSnapshot("<h1>v1</h1>", 1);
      surface.composer.start();
    });
    expect(inlineFrame.postMessage).toHaveBeenCalledWith(
      { type: "mcp-apps:recording-control", action: "start" },
      "*",
    );

    // The user opens the app in the right panel: the inline frame tears down
    // (bindIframe(null)) and the panel frame mounts. Capture must follow it.
    act(() => {
      surface.frame.runtimeHooks.bindIframe(null);
      surface.frame.runtimeHooks.bindIframe(panelFrame.el);
    });

    // The panel frame's SDK posts its captured input up, and it accumulates.
    act(() => {
      surface.frame.runtimeHooks.onRecordingEvents({
        events: [
          { kind: "pointer", type: "click", x: 12, y: 34, ts: Date.now() },
        ],
      });
    });

    // Stopping writes a self-contained bundle to the store, keyed by the
    // conversation, with the events captured after the surface switch.
    await act(async () => {
      await surface.composer.stop();
    });

    const bundle = await waitFor(async () => {
      const stored = await recordingStore.get(conversationId);
      expect(stored).not.toBeNull();
      return stored;
    });
    expect(bundle?.app).toEqual({ id: APP_ID, name: "Test App" });
    expect(bundle?.meta.authorName).toBe("Tester");

    // The transcript is snapshotted from the recorded conversation and stored
    // in the bundle — a chat recording is never saved without its chat.
    expect(mockSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId }),
    );
    expect(bundle?.recording.transcript).toEqual(TRANSCRIPT);

    const pointerEvents = (bundle?.recording.events ?? []).filter(
      (e) => e.kind === "pointer",
    );
    expect(pointerEvents).toHaveLength(1);
    expect(pointerEvents[0]).toMatchObject({ type: "click", x: 12, y: 34 });

    // Saving is the moment the session becomes replayable — the only point
    // where pointing at the Play button is useful.
    expect(vi.mocked(toast.success)).toHaveBeenCalledWith(
      expect.stringContaining("Recording ready"),
    );
  });

  it("records from scratch before a conversation exists, then adopts its id", async () => {
    // Record works in a brand-new chat before the first message is sent.
    const surface = renderChatSurface({ conversationId: null, appId: APP_ID });

    expect(surface.composer.canRecord).toBe(true);
    act(() => {
      surface.frame.runtimeHooks.captureSnapshot("<h1>v1</h1>", 1);
      surface.composer.start();
    });
    expect(surface.composer.status).toBe("recording");
    const startedAt = surface.composer.startedAtMs;
    expect(startedAt).toBeGreaterThan(0);

    // The first message creates the conversation: the chat page adopts the
    // in-flight recording under its id at the new-conversation choke point,
    // then re-renders showing that conversation.
    const conversationId = freshConversationId("c");
    act(() => {
      surface.handle.adoptConversation(conversationId);
    });
    act(() => {
      surface.showConversation(conversationId);
    });

    // Same recording, same start time, uninterrupted.
    expect(surface.composer.status).toBe("recording");
    expect(surface.composer.startedAtMs).toBe(startedAt);

    // Stopping writes the bundle keyed by the adopted conversation id.
    await act(async () => {
      await surface.composer.stop();
    });
    const bundle = await waitFor(async () => {
      const stored = await recordingStore.get(conversationId);
      expect(stored).not.toBeNull();
      return stored;
    });
    expect(bundle?.app).toEqual({ id: APP_ID, name: "Test App" });
    expect(mockSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId }),
    );
  });

  it("switching to another chat stops the recording and saves it under the chat it was made in", async () => {
    const recordedId = freshConversationId("d1");
    const otherId = freshConversationId("d2");
    const surface = renderChatSurface({
      conversationId: recordedId,
      appId: APP_ID,
    });

    act(() => {
      surface.frame.runtimeHooks.captureSnapshot("<h1>v1</h1>", 1);
      surface.composer.start();
    });
    expect(surface.composer.status).toBe("recording");

    // The user clicks another conversation in the sidebar. The recording must
    // not follow them: it stops and saves under the chat it was made in.
    act(() => {
      surface.showConversation(otherId);
    });

    const bundle = await waitFor(
      async () => {
        const stored = await recordingStore.get(recordedId);
        expect(stored).not.toBeNull();
        return stored;
      },
      { timeout: 3000 },
    );
    expect(mockSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: recordedId }),
    );
    expect(bundle?.recording.transcript).toEqual(TRANSCRIPT);
    // Nothing leaks into the chat the user switched to, and the recorder is
    // ready for a fresh recording there.
    expect(await recordingStore.get(otherId)).toBeNull();
    await waitFor(() => {
      expect(surface.composer.status).toBe("idle");
    });
    expect(vi.mocked(toast.success)).toHaveBeenCalledWith(
      expect.stringContaining("Recording saved"),
    );
  });

  it("leaving the chat page saves the in-flight recording", async () => {
    const conversationId = freshConversationId("e");
    const surface = renderChatSurface({ conversationId, appId: APP_ID });

    act(() => {
      surface.frame.runtimeHooks.captureSnapshot("<h1>v1</h1>", 1);
      surface.composer.start();
    });

    // Navigating away unmounts the chat surface; the recording must not be
    // lost with it.
    surface.unmount();

    await waitFor(
      async () => {
        expect(await recordingStore.get(conversationId)).not.toBeNull();
      },
      { timeout: 3000 },
    );
  });

  it("discards a from-scratch recording when some existing chat is opened instead", async () => {
    // A recording begun before the first message belongs to a chat that never
    // came to exist — opening another conversation cannot adopt it.
    const surface = renderChatSurface({ conversationId: null, appId: APP_ID });
    act(() => {
      surface.frame.runtimeHooks.captureSnapshot("<h1>v1</h1>", 1);
      surface.composer.start();
    });

    const otherId = freshConversationId("f");
    act(() => {
      surface.showConversation(otherId);
    });

    expect(surface.composer.status).toBe("idle");
    expect(await recordingStore.get(otherId)).toBeNull();
    expect(vi.mocked(toast.info)).toHaveBeenCalledWith(
      expect.stringContaining("Recording discarded"),
    );
  });

  it("goes fully inert when the deployment flag is off", () => {
    // One flip disables the whole surface — no recording can start anywhere.
    vi.mocked(useFeature).mockReturnValue(false);
    const surface = renderChatSurface({
      conversationId: freshConversationId("z"),
    });
    expect(surface.composer.canRecord).toBe(false);
    act(() => {
      surface.composer.start();
    });
    expect(surface.composer.status).toBe("idle");
  });

  it("is inert outside a chat page's provider", () => {
    // A consumer rendered with no chat surface above it (the standalone app
    // page, say) gets the no-op recorder.
    const { result } = renderHook(() => useAppSessionRecorder());
    expect(result.current.canRecord).toBe(false);
    act(() => {
      result.current.start();
    });
    expect(result.current.status).toBe("idle");
  });

  it("ignores captured events while idle", () => {
    const surface = renderChatSurface({
      conversationId: freshConversationId("g"),
    });

    act(() => {
      surface.frame.runtimeHooks.onRecordingEvents({
        events: [{ kind: "pointer", type: "move", x: 1, y: 2, ts: Date.now() }],
      });
    });

    expect(surface.frame.status).toBe("idle");
  });
});
