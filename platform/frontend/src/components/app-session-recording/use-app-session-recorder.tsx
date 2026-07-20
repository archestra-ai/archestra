"use client";

import {
  archestraApiSdk,
  parseFullToolName,
  sanitizeRecordingBundle,
  validateRecordingBundle,
} from "@archestra/shared";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
import { toast } from "sonner";
import { useApp } from "@/lib/app.query";
import {
  fallbackRecordingDescription,
  useInvalidateAppRecording,
} from "@/lib/app-session-recording/app-recording.query";
import {
  type AppRecordingBundle,
  recordingStore,
} from "@/lib/app-session-recording/app-recording-store";
import { snapshotConversationTranscript } from "@/lib/app-session-recording/app-recording-transcript";
import { useSession } from "@/lib/auth/auth.query";
import { useFeature } from "@/lib/config/config.query";

/**
 * The runtime-facing side of the session recorder: {@link McpAppRuntime}
 * reports the live iframe, the served HTML snapshots, its proxied MCP
 * exchanges, and the input-event batches the injected SDK posts up. All calls
 * are cheap no-ops while not recording (except snapshot bookkeeping, which the
 * next `start()` needs).
 */
export interface AppSessionRecorderRuntimeHooks {
  /** The live sandbox iframe (null on teardown) — control messages go here. */
  bindIframe: (el: HTMLIFrameElement | null) => void;
  /** A raw `mcp-apps:recording-event` batch forwarded by the sandbox proxy. */
  onRecordingEvents: (data: unknown) => void;
  /** One MCP exchange the runtime proxied for the app. */
  captureMcp: (exchange: {
    method: string;
    toolName?: string;
    params?: unknown;
    result?: unknown;
    isError?: boolean;
    durationMs?: number;
  }) => void;
  /** The served (envelope-injected) HTML the runtime currently renders. */
  captureSnapshot: (html: string, version: number | null) => void;
}

export interface AppSessionRecorder {
  status: "idle" | "recording" | "saving";
  /**
   * Whether a recorder exists on this surface: the feature is enabled and a
   * chat page provides one. Recording can start before the chat has an id —
   * the recording binds to the conversation its first message creates.
   */
  canRecord: boolean;
  /**
   * The conversation this chat surface currently shows — the key recordings
   * are stored and replayed under. Null before the first message is sent.
   */
  conversationId: string | null;
  /** The app this chat surface is building/showing, once it exists. */
  appId: string | null;
  /** Epoch ms when the current recording started, or 0 while not recording. */
  startedAtMs: number;
  start: () => void;
  stop: () => Promise<void>;
  /** Stable object identity — safe to hand to the runtime as a prop. */
  runtimeHooks: AppSessionRecorderRuntimeHooks;
}

/** Recording hard limits, mirroring the backend's create-route caps. */
const MAX_EVENTS = 45_000;
const MAX_SEGMENTS = 20;
const MAX_DURATION_MS = 10 * 60_000;
/** The SDK flushes its buffer on stop; give that final batch time to arrive. */
const STOP_FLUSH_GRACE_MS = 400;
/**
 * The injected recorder starts idempotently, so while recording we re-send
 * "start" on an interval — this also captures a mid-recording iframe swap (an
 * app edit reloading the frame, or the app moving between the inline card and
 * the right panel), whose fresh SDK would otherwise never hear it.
 */
const START_REBROADCAST_MS = 1_000;

const RECORDING_CONTROL_TYPE = "mcp-apps:recording-control";

type TimelineEvent = { kind: string; t: number } & Record<string, unknown>;
type Segment = { version: number; html: string; atMs: number };

/**
 * The raw capture the core hands to its host to finalize into a stored bundle:
 * timing plus the buffered events and app-HTML segments.
 */
export interface RawRecording {
  startedAtMs: number;
  durationMs: number;
  events: TimelineEvent[];
  segments: Segment[];
}

type RecorderStatus = AppSessionRecorder["status"];

/**
 * One chat surface's recording session. The chat page owns exactly one
 * instance ({@link useOwnAppSessionRecorder}) and provides it to the tree, so
 * the composer's controls and whichever app frame is live all drive the same
 * recording: the app frame lives on exactly one surface at a time, and moving
 * it — "Open in right panel" mid-recording — unmounts one iframe and mounts
 * another. The core sticks to whichever frame is currently live and
 * re-broadcasts "start" to it.
 *
 * The recorder is part of the chat session. A recording binds to the
 * conversation it started in (or to the id a brand-new chat receives at its
 * first message), and leaving that conversation — switching chats, opening a
 * new chat, or closing the page — stops the recording and saves it, so a
 * recording never outlives its chat.
 */
class AppRecorderCore {
  status: RecorderStatus = "idle";

  private readonly listeners = new Set<() => void>();
  private startEpoch = 0;
  private events: TimelineEvent[] = [];
  private segments: Segment[] = [];
  private activeIframe: HTMLIFrameElement | null = null;
  private latestHtml: { html: string; version: number | null } | null = null;
  private rebroadcastTimer: ReturnType<typeof setInterval> | null = null;
  private finalize:
    | ((raw: RawRecording, conversationId: string | null) => Promise<boolean>)
    | null = null;
  /** The conversation the owning chat surface currently shows. */
  private currentConversationId: string | null = null;
  /** The conversation the in-flight recording belongs to; null while a
   * from-scratch recording awaits its chat's first message. */
  private recordingConversationId: string | null = null;

  // ── React store surface ──
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getStatus = () => this.status;
  /** Epoch ms the active recording began, or 0 when not recording. */
  getStartedAtMs = () => (this.status === "recording" ? this.startEpoch : 0);

  setFinalize(
    fn: (raw: RawRecording, conversationId: string | null) => Promise<boolean>,
  ) {
    this.finalize = fn;
  }

  // ── Conversation binding ──
  /**
   * Track the conversation the owning surface shows. A live recording is bound
   * to the conversation it started in, so seeing a different one means the
   * user left that chat: the recording stops and saves (or is discarded when
   * it started in a chat that never got its first message — there is nothing
   * to save it under).
   */
  setConversation(id: string | null) {
    const changed = this.currentConversationId !== id;
    this.currentConversationId = id;
    if (!changed || this.status !== "recording") return;
    if (this.recordingConversationId === id) return;
    this.endForDeparture();
  }

  /**
   * Bind a from-scratch recording to the conversation created by its chat's
   * first message — the timer and buffered capture carry across. Only the
   * new-conversation choke point adopts; opening some other existing chat
   * instead goes through {@link setConversation} and discards the unbound
   * recording.
   */
  adoptConversation(id: string) {
    this.currentConversationId = id;
    if (this.status === "recording" && this.recordingConversationId === null) {
      this.recordingConversationId = id;
    }
  }

  /** The owning chat surface is unmounting — a recording must not outlive it. */
  leaveSurface() {
    if (this.status !== "recording") return;
    this.endForDeparture();
  }

  // ── Runtime hooks ──
  // Sticky binding: only a live (non-null) frame updates the target. A surface
  // switch fires unmount(null) then mount(el) in an unspecified order; ignoring
  // null keeps the latest real frame as the target regardless of ordering, and
  // a stale detached frame is a harmless no-op for postMessage.
  bindIframe = (el: HTMLIFrameElement | null) => {
    if (el) this.activeIframe = el;
  };

  onRecordingEvents = (data: unknown) => {
    if (this.status !== "recording") return;
    const batch = (data as { events?: unknown } | null)?.events;
    if (!Array.isArray(batch)) return;
    for (const raw of batch) {
      if (!raw || typeof raw !== "object") continue;
      const { ts, ...rest } = raw as { ts?: unknown; kind?: unknown };
      if (typeof ts !== "number" || typeof rest.kind !== "string") continue;
      this.pushEvent({
        ...(rest as { kind: string }),
        t: Math.max(0, Math.round(ts - this.startEpoch)),
      });
    }
  };

  captureMcp = (exchange: {
    method: string;
    toolName?: string;
    params?: unknown;
    result?: unknown;
    isError?: boolean;
    durationMs?: number;
  }) => {
    if (this.status !== "recording") return;
    this.pushEvent({
      kind: "mcp",
      t: Math.max(0, Date.now() - this.startEpoch),
      ...exchange,
    });
  };

  captureSnapshot = (html: string, version: number | null) => {
    this.latestHtml = { html, version };
    if (this.status !== "recording") return;
    const current = this.segments[this.segments.length - 1];
    if (current && current.html === html) return;
    if (this.segments.length >= MAX_SEGMENTS) return;
    const atMs = Math.max(0, Date.now() - this.startEpoch);
    this.segments.push({ version: version ?? 0, html, atMs });
    this.pushEvent({ kind: "segment", t: atMs, version: version ?? 0 });
  };

  // ── Controls ──
  start() {
    if (this.status !== "idle") return;
    this.startEpoch = Date.now();
    this.recordingConversationId = this.currentConversationId;
    this.events = [];
    // A chat can start recording before it has built an app (record from
    // scratch), so there may be no HTML yet. If one is already on screen it
    // becomes segment 0; otherwise the first app to render seeds it (its
    // `captureSnapshot`, and the "start" rebroadcast reaches its fresh SDK).
    const snapshot = this.latestHtml;
    if (snapshot) {
      this.segments = [
        { version: snapshot.version ?? 0, html: snapshot.html, atMs: 0 },
      ];
      this.pushEvent({ kind: "segment", t: 0, version: snapshot.version ?? 0 });
    } else {
      this.segments = [];
    }
    this.setStatus("recording");
    this.postControl("start");
    this.rebroadcastTimer = setInterval(() => {
      this.postControl("start");
      // Hard stop at the ceiling so a forgotten recording can't grow unbounded.
      if (Date.now() - this.startEpoch >= MAX_DURATION_MS) void this.stop();
    }, START_REBROADCAST_MS);
  }

  async stop(reason?: "left-chat") {
    if (this.status !== "recording") return;
    this.setStatus("saving");
    this.clearRebroadcast();
    this.postControl("stop");
    // The SDK's final flush travels app → proxy → host asynchronously.
    await new Promise((resolve) => setTimeout(resolve, STOP_FLUSH_GRACE_MS));

    const conversationId = this.recordingConversationId;
    this.recordingConversationId = null;
    const startedAtMs = this.startEpoch;
    const durationMs = Math.max(0, Date.now() - startedAtMs);
    const events = [...this.events].sort((a, b) => a.t - b.t);
    const segments = this.segments;
    this.events = [];
    this.segments = [];

    try {
      // Always finalize: validation there refuses an empty capture with a
      // visible reason (no app created, no chat) instead of dropping silently.
      if (this.finalize) {
        const saved = await this.finalize(
          { startedAtMs, durationMs, events, segments },
          conversationId,
        );
        // Saving is the only moment the recording becomes replayable, so it is
        // where the Play button is worth pointing at. A departure save also
        // happens without the user pressing Stop — say so.
        if (saved) {
          toast.success(
            reason === "left-chat"
              ? "Recording saved — it stopped when you left its chat."
              : "Recording ready — press play to replay this session.",
          );
        }
      }
    } finally {
      this.setStatus("idle");
    }
  }

  private clearRebroadcast() {
    if (this.rebroadcastTimer) {
      clearInterval(this.rebroadcastTimer);
      this.rebroadcastTimer = null;
    }
  }

  /** Leaving the recorded chat: save a bound recording, drop an unbound one. */
  private endForDeparture() {
    if (this.recordingConversationId === null) {
      this.discard();
      return;
    }
    void this.stop("left-chat");
  }

  /** Drop an in-flight recording that has no conversation to be saved under. */
  private discard() {
    this.clearRebroadcast();
    this.postControl("stop");
    this.events = [];
    this.segments = [];
    this.setStatus("idle");
    toast.info(
      "Recording discarded — its chat was left before the first message.",
    );
  }

  private setStatus(status: RecorderStatus) {
    this.status = status;
    for (const listener of this.listeners) listener();
  }

  private pushEvent(event: TimelineEvent) {
    if (this.events.length >= MAX_EVENTS) return;
    this.events.push(event);
  }

  private postControl(action: "start" | "stop") {
    this.activeIframe?.contentWindow?.postMessage(
      { type: RECORDING_CONTROL_TYPE, action },
      "*",
    );
  }
}

const INERT_HOOKS: AppSessionRecorderRuntimeHooks = {
  bindIframe: () => {},
  onRecordingEvents: () => {},
  captureMcp: () => {},
  captureSnapshot: () => {},
};

/**
 * The chat page's handle on its recorder: the core plus the identity its
 * consumers need. Provided to the page tree via
 * {@link AppSessionRecorderProvider}; everything below reads it with
 * {@link useAppSessionRecorder}.
 */
export interface AppSessionRecorderHandle {
  core: AppRecorderCore | null;
  conversationId: string | null;
  /** The app this chat surface is building/showing, once it exists. */
  appId: string | null;
  /**
   * Bind a from-scratch recording to the conversation its chat's first message
   * just created. Call at the new-conversation choke point only.
   */
  adoptConversation: (conversationId: string) => void;
}

const AppSessionRecorderContext =
  createContext<AppSessionRecorderHandle | null>(null);

/**
 * Owns a chat surface's session recorder as part of the chat session itself.
 * The chat page calls this — it owns the conversation id and the context the
 * finalizer needs — and provides the returned handle via
 * {@link AppSessionRecorderProvider}; the composer control drives Start/Stop
 * and each app frame feeds capture through {@link useAppSessionRecorder}.
 *
 * Ownership scopes the recording's lifetime. On stop the finalizer assembles
 * the self-contained bundle — the app HTML, the proxied MCP exchanges, the
 * injected SDK's input events, and the chat transcript — and writes it to the
 * client-side store keyed by conversation, so a new recording overwrites that
 * chat's previous one. Leaving the conversation (switching chats, opening a
 * new chat, unmounting the page) stops and saves exactly the same way, so a
 * recording never outlives its chat.
 *
 * Self-gates on the deployment feature flag: a disabled deployment never
 * creates a core, and every consumer goes inert together.
 */
export function useOwnAppSessionRecorder(params: {
  conversationId: string | null;
  /** The app the chat built, for the bundle's identity. */
  appId: string | null;
}): AppSessionRecorderHandle {
  const { conversationId, appId } = params;
  const enabled = useFeature("hackathonRecorderEnabled") ?? false;
  const coreRef = useRef<AppRecorderCore | null>(null);
  if (enabled && !coreRef.current) coreRef.current = new AppRecorderCore();
  const core = enabled ? coreRef.current : null;

  const { data: app } = useApp(appId, { toastOnError: false });
  const { data: session } = useSession();
  const invalidateRecording = useInvalidateAppRecording();

  // The core finalizes at stop time, so read the app/author context from a ref
  // the render refreshes rather than a captured closure: an app built
  // mid-recording is picked up at stop, never a stale snapshot. The
  // conversation is deliberately not read here — the core passes the one the
  // recording was made in, which a post-departure save must use even though
  // the surface already shows another chat.
  const finalizeCtxRef = useRef({
    appId,
    appName: app?.name ?? "App",
    authorName: session?.user?.name ?? null,
  });
  finalizeCtxRef.current = {
    appId,
    appName: app?.name ?? "App",
    authorName: session?.user?.name ?? null,
  };

  useEffect(() => {
    if (!core) return;
    core.setFinalize(async (raw, recordedConversationId) => {
      const ctx = finalizeCtxRef.current;
      // The chat transcript is part of every bundle's contract — snapshot it
      // from the conversation the recording was made in.
      const transcript = recordedConversationId
        ? await snapshotConversationTranscript({
            conversationId: recordedConversationId,
            startedAtMs: raw.startedAtMs,
            durationMs: raw.durationMs,
          })
        : [];
      // Draft the AI presentation layer at save time, implicitly over the
      // agent connected to this chat session: the one-sentence description and
      // the consolidated build prompt the replay shows in place of the raw
      // history. Best-effort — a failed generation still saves the recording,
      // which then replays the original chat and can be drafted later from the
      // player's edit controls.
      const enhancement = recordedConversationId
        ? await draftEnhancement({
            conversationId: recordedConversationId,
            appName: ctx.appName,
          })
        : undefined;
      const bundle = buildBundle({
        appId: ctx.appId,
        appName: ctx.appName,
        authorName: ctx.authorName,
        raw,
        transcript,
        enhancement,
      });
      // Sanitize (redact detected sensitive values), then hold the result to
      // the shared bundle contract: a recording that captured no app creation
      // or no chat is refused rather than stored broken — the previous
      // recording, if any, stays intact.
      const validation = validateRecordingBundle(
        sanitizeRecordingBundle(bundle),
      );
      if (!validation.ok) {
        toast.error(`Recording not saved. ${validation.reason}`);
        return false;
      }
      if (!recordedConversationId) return false;
      await recordingStore.put(recordedConversationId, validation.bundle);
      // A fresh capture invalidates the previous recording's edit history —
      // its cuts addressed a timeline that no longer exists.
      await recordingStore.deleteHistory(recordedConversationId);
      invalidateRecording(recordedConversationId);
      return true;
    });
  }, [core, invalidateRecording]);

  // The recording follows the surface's conversation: a change away from the
  // recorded one stops and saves (adoption pre-binds the new id at the choke
  // point, so that transition is a no-op here), and the surface unmounting
  // ends any in-flight recording the same way.
  useEffect(() => {
    core?.setConversation(conversationId);
  }, [core, conversationId]);
  useEffect(() => {
    if (!core) return;
    return () => core.leaveSurface();
  }, [core]);

  const adoptConversation = useCallback((id: string) => {
    coreRef.current?.adoptConversation(id);
  }, []);

  return useMemo(
    () => ({ core, conversationId, appId, adoptConversation }),
    [core, conversationId, appId, adoptConversation],
  );
}

/** Provides the chat page's recorder handle to the composer and app frames. */
export function AppSessionRecorderProvider({
  recorder,
  children,
}: {
  recorder: AppSessionRecorderHandle;
  children: ReactNode;
}) {
  return (
    <AppSessionRecorderContext.Provider value={recorder}>
      {children}
    </AppSessionRecorderContext.Provider>
  );
}

/**
 * A chat surface's session recorder, read from the chat page's provider: the
 * live recording status, the start epoch, the Record/Stop controls, and the
 * runtime hooks whichever app frame is live feeds. Inert (no-op hooks,
 * `canRecord: false`) outside a chat page and when the deployment disables
 * the feature.
 */
export function useAppSessionRecorder(): AppSessionRecorder {
  const handle = useContext(AppSessionRecorderContext);
  const core = handle?.core ?? null;

  const status = useSyncExternalStore(
    core ? core.subscribe : noopSubscribe,
    core ? core.getStatus : idleStatus,
    idleStatus,
  );

  const start = useCallback(() => {
    core?.start();
  }, [core]);
  const stop = useCallback(async () => {
    await core?.stop();
  }, [core]);

  const runtimeHooks = useMemo<AppSessionRecorderRuntimeHooks>(
    () =>
      core
        ? {
            bindIframe: core.bindIframe,
            onRecordingEvents: core.onRecordingEvents,
            captureMcp: core.captureMcp,
            captureSnapshot: core.captureSnapshot,
          }
        : INERT_HOOKS,
    [core],
  );

  return {
    status,
    canRecord: !!core,
    conversationId: handle?.conversationId ?? null,
    appId: handle?.appId ?? null,
    startedAtMs: core ? core.getStartedAtMs() : 0,
    start,
    stop,
    runtimeHooks,
  };
}

function noopSubscribe() {
  return () => {};
}
function idleStatus(): RecorderStatus {
  return "idle";
}

/** Assemble the captured recording into a portable, self-contained bundle. */
function buildBundle(params: {
  appId: string | null;
  appName: string;
  authorName: string | null;
  raw: RawRecording;
  transcript: AppRecordingBundle["recording"]["transcript"];
  enhancement?: AppRecordingBundle["enhancement"];
}): AppRecordingBundle {
  const { appId, appName, authorName, raw, transcript, enhancement } = params;
  const startedAt = new Date(raw.startedAtMs);
  return {
    formatVersion: 1,
    app: { id: appId, name: appName },
    recording: {
      title: `${appName} demo — ${startedAt.toISOString().slice(0, 16).replace("T", " ")}`,
      startedAt: startedAt.toISOString(),
      durationMs: raw.durationMs,
      // Captured events conform to the recording schema; validation at save
      // re-checks them.
      events: raw.events as AppRecordingBundle["recording"]["events"],
      segments: raw.segments,
      transcript,
    },
    enhancement,
    meta: {
      authorName,
      createdAt: new Date().toISOString(),
      platform: "archestra",
      // Gallery facts about the build. (Built date and total duration are
      // already carried by createdAt and recording.durationMs.)
      mcpServers: mcpServerNames(raw, transcript),
      appVersionCount: raw.segments.reduce(
        (max, segment) => Math.max(max, segment.version),
        0,
      ),
    },
  };
}

/**
 * The MCP servers the session actually used, from both sides of the capture:
 * the app's own proxied calls and the agent's tool activity in the chat.
 * Tool names are `<server>__<tool>`; the server half is the name.
 */
function mcpServerNames(
  raw: RawRecording,
  transcript: AppRecordingBundle["recording"]["transcript"],
): string[] {
  const names = new Set<string>();
  const add = (toolName: unknown) => {
    if (typeof toolName !== "string") return;
    const server = parseFullToolName(toolName).serverName;
    if (server) names.add(server);
  };
  for (const event of raw.events) {
    if (event.kind === "mcp") add(event.toolName);
  }
  for (const message of transcript) {
    for (const part of message.parts) {
      if (part.type === "tool") add(part.name);
    }
  }
  return [...names].sort();
}

/**
 * Draft the recording's AI enhancement from the full chat session. Returns
 * undefined when generation is unavailable — the bundle then carries no
 * enhancement and the replay shows the original history.
 */
async function draftEnhancement(params: {
  conversationId: string;
  appName: string;
}): Promise<AppRecordingBundle["enhancement"]> {
  try {
    const { data } = await archestraApiSdk.enhanceAppRecording({
      body: { conversationId: params.conversationId, appName: params.appName },
    });
    const prompt = data?.prompt ?? null;
    if (!prompt) return undefined;
    return {
      description:
        data?.description ?? fallbackRecordingDescription(params.appName),
      prompt,
      // The one closing agent reply the enhanced replay shows in place of
      // the captured assistant prose; absent, the player uses a stock line.
      ...(data?.response ? { response: data.response } : {}),
      // The gallery category for this app.
      ...(data?.category ? { category: data.category } : {}),
    };
  } catch {
    return undefined;
  }
}
