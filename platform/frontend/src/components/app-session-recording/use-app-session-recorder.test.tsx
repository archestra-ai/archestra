import { act, render, renderHook, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { recordingStore } from "@/lib/app-session-recording/app-recording-store";
import { snapshotConversationTranscript } from "@/lib/app-session-recording/app-recording-transcript";
import { useFeature } from "@/lib/config/config.query";
import { useIsMobile } from "@/lib/hooks/use-mobile";
import { resolveModelDisplayName } from "@/lib/llm-models.query";
import { useOrganization } from "@/lib/organization.query";
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
// The recorder now composes the deployment flag with the organization's own
// toggle, so the org query joins the stubbed surroundings.
vi.mock("@/lib/organization.query", () => ({
  useOrganization: vi.fn(() => ({
    data: { appsHackathonRecorderEnabled: true },
  })),
}));
vi.mock("@/lib/app-session-recording/app-recording.query", () => ({
  useInvalidateAppRecording: () => vi.fn(),
}));
// The recorder is off on small screens; stubbed to a desktop viewport by
// default (jsdom has no real matchMedia), flipped per test where it matters.
vi.mock("@/lib/hooks/use-mobile", () => ({
  useIsMobile: vi.fn(() => false),
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
// The chat's model is resolved from a raw modelId to a display name over the
// SDK — stubbed so tests that don't care about it can ignore the boundary.
vi.mock("@/lib/llm-models.query", () => ({
  resolveModelDisplayName: vi.fn(),
}));

const mockSnapshot = vi.mocked(snapshotConversationTranscript);
const mockResolveModel = vi.mocked(resolveModelDisplayName);

// A fresh conversation id per test — the recording store is module-level, so a
// shared id would leak stored bundles across tests.
function freshConversationId(tag: string) {
  return `conv-${Math.round(performance.now())}-${tag}`;
}

// Bundle validation requires real UUID app ids.
const APP_ID = "3b1f8d3e-8f5a-4c57-9a4e-2f60cf1f2b01";

const TRANSCRIPT: Awaited<
  ReturnType<typeof snapshotConversationTranscript>
>["transcript"] = [
  { id: "m1", role: "user", atMs: -1, parts: [{ type: "text", text: "hi" }] },
];

function fakeIframe() {
  const postMessage = vi.fn();
  const el = {
    contentWindow: { postMessage },
    // The recorder locks onto a frame only while it is in the DOM.
    isConnected: true,
  } as unknown as HTMLIFrameElement;
  return {
    el,
    postMessage,
    /** Model the frame leaving the DOM (surface teardown). */
    disconnect: () => {
      (el as unknown as { isConnected: boolean }).isConnected = false;
    },
  };
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
  mockSnapshot.mockResolvedValue({ transcript: TRANSCRIPT, modelId: null });
  // The recorder self-gates on the deployment flag; these tests exercise an
  // enabled deployment.
  vi.mocked(useFeature).mockReturnValue(true);
  vi.mocked(useOrganization).mockReturnValue({
    data: { appsHackathonRecorderEnabled: true },
  } as ReturnType<typeof useOrganization>);
  // Desktop viewport unless a test says otherwise.
  vi.mocked(useIsMobile).mockReturnValue(false);
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
    // (bindIframe(null), element leaves the DOM) and the panel frame mounts.
    // The recording's frame lock must heal onto the panel.
    act(() => {
      surface.frame.runtimeHooks.bindIframe(null);
      inlineFrame.disconnect();
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
    // How many prompts it took to build the app — every user message in the
    // captured transcript (TRANSCRIPT has exactly one).
    expect(bundle?.meta.userPromptCount).toBe(1);
    // No modelId from the conversation snapshot (the default mock) → no
    // model field at all, rather than a stamped `null`/empty string.
    expect(bundle?.meta.model).toBeUndefined();

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

  it("resolves the chat's model to a display name for the bundle", async () => {
    const conversationId = freshConversationId("model");
    const surface = renderChatSurface({ conversationId, appId: APP_ID });
    const frame = fakeIframe();

    mockSnapshot.mockResolvedValue({
      transcript: TRANSCRIPT,
      modelId: "model-db-id",
    });
    mockResolveModel.mockResolvedValue("Claude Sonnet");

    act(() => {
      surface.frame.runtimeHooks.bindIframe(frame.el);
      surface.frame.runtimeHooks.captureSnapshot("<h1>v1</h1>", 1);
      surface.composer.start();
    });
    await act(async () => {
      await surface.composer.stop();
    });

    const bundle = await waitFor(async () => {
      const stored = await recordingStore.get(conversationId);
      expect(stored).not.toBeNull();
      return stored;
    });
    expect(mockResolveModel).toHaveBeenCalledWith("model-db-id");
    expect(bundle?.meta.model).toBe("Claude Sonnet");
  });

  it("seeds the first replay segment from the live record-start DOM, not the served source html", async () => {
    const conversationId = freshConversationId("snap");
    const surface = renderChatSurface({ conversationId, appId: APP_ID });
    const frame = fakeIframe();

    // Segment 0 starts as the served source html — the app before its own code
    // ran (here, an intro overlay that hides the real app).
    act(() => {
      surface.frame.runtimeHooks.bindIframe(frame.el);
      surface.frame.runtimeHooks.captureSnapshot(
        "<html><body><div id='intro'></div><main id='app'></main></body></html>",
        1,
      );
      surface.composer.start();
    });

    // The SDK reports the live DOM the moment recording starts (intro dismissed,
    // app shown) as a `snapshot` control on the event channel, followed by a
    // normal input event.
    const liveHtml =
      "<html><body><div id='intro' style='display:none'></div><main id='app' class='show'>charts</main></body></html>";
    act(() => {
      surface.frame.runtimeHooks.onRecordingEvents({
        events: [
          { kind: "snapshot", html: liveHtml, ts: Date.now() },
          { kind: "pointer", type: "click", x: 5, y: 6, ts: Date.now() },
        ],
      });
    });

    await act(async () => {
      await surface.composer.stop();
    });

    const bundle = await waitFor(async () => {
      const stored = await recordingStore.get(conversationId);
      expect(stored).not.toBeNull();
      return stored;
    });

    // The initial segment is the on-screen state, so replay opens on the app the
    // session actually showed rather than frozen behind the dismissed intro.
    expect(bundle?.recording.segments[0]?.html).toBe(liveHtml);
    // The snapshot is a control, never a stored timeline event (it is not part
    // of the event union and would fail validation if stored).
    expect(
      (bundle?.recording.events ?? []).map((e) => e.kind as string),
    ).not.toContain("snapshot");
    expect(
      (bundle?.recording.events ?? []).filter((e) => e.kind === "pointer"),
    ).toHaveLength(1);
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

  it("goes fully inert when the organization has switched it off", () => {
    // The admin toggle has to reach the recorder itself, not just the button:
    // a surface that still records while the setting says it is off would keep
    // capturing sessions nobody asked it to.
    vi.mocked(useOrganization).mockReturnValue({
      data: { appsHackathonRecorderEnabled: false },
    } as ReturnType<typeof useOrganization>);
    const surface = renderChatSurface({
      conversationId: freshConversationId("org-off"),
    });
    expect(surface.composer.canRecord).toBe(false);
    act(() => {
      surface.composer.start();
    });
    expect(surface.composer.status).toBe("idle");
  });

  it("goes fully inert on a mobile-sized screen, whatever the settings say", () => {
    // Everything else is on — deployment, org toggle — so this isolates the
    // device gate: the recorder captures a desktop session and has no
    // small-screen layout, so a phone gets no recorder at all.
    vi.mocked(useIsMobile).mockReturnValue(true);
    const surface = renderChatSurface({
      conversationId: freshConversationId("mobile"),
    });
    expect(surface.composer.canRecord).toBe(false);
    act(() => {
      surface.composer.start();
    });
    expect(surface.composer.status).toBe("idle");
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
