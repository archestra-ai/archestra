import { z } from "zod";
import { parseFullToolName } from "./utils";

// =============================================================================
// App session recording — the strict, shared bundle contract
//
// A recording is a self-contained demo of an app session: the input events
// captured inside the sandboxed app iframe (pointer/keyboard/scroll), the MCP
// request/response pairs the host proxied for the app (replayed as mocks), the
// served app HTML per version shown during the session, and a condensed chat
// transcript. The player re-drives these against the recorded app HTML.
//
// Recordings are assembled and stored entirely client-side (IndexedDB, keyed
// by conversation, overwrite-on-new); the server never persists one. This ONE
// zod contract is shared by every producer and consumer — the recorder
// validates before storing, the player before replaying, and the downloader
// before exporting. Every
// object is `.strict()`: a bundle carries exactly the declared static data and
// nothing else — unknown keys (a vector for smuggling payloads) are rejected.
// =============================================================================

/**
 * The Apps Hackathon window: 00:00 on 22 July 2026 until 00:00 on 29 July
 * 2026, UK time. July is BST (UTC+1), so those instants are 23:00 UTC on the
 * 21st and the 28th — spelled in UTC rather than local time so every
 * deployment agrees on them regardless of server zone.
 *
 * Outside this window the recorder hard-disables everywhere, whatever a
 * deployment or an organization still has switched on. The bounds are read at
 * REQUEST time, never captured at boot: a pod started before the window would
 * otherwise keep its answer frozen as the clock crosses either edge. The one
 * exception is the staging override, which bypasses the window entirely (see
 * the recorder route and useAppsHackathonOffered).
 */
export const APPS_HACKATHON_OPENS_AT_MS = Date.UTC(2026, 6, 21, 23, 0, 0);
export const APPS_HACKATHON_CLOSES_AT_MS = Date.UTC(2026, 6, 28, 23, 0, 0);

/**
 * The window above rendered as human copy for the UI. Kept here, next to the
 * epochs it describes, so the composer tooltip and the settings block share one
 * string that cannot drift from each other or lag the gate: whoever moves the
 * dates edits this in the same place. The label reads a day later than the UTC
 * epochs because the hackathon's dates are stated in its own timezone (UTC+1:
 * the 21st 23:00 UTC is already the 22nd there), so it is written out rather
 * than formatted from the epochs, which would shift per viewer.
 */
export const APPS_HACKATHON_DATE_RANGE_LABEL = "July 22–29";

/** Whether the Apps Hackathon is currently running (start reached, end not). */
export function isAppsHackathonOpen(nowMs: number = Date.now()): boolean {
  return (
    nowMs >= APPS_HACKATHON_OPENS_AT_MS && nowMs < APPS_HACKATHON_CLOSES_AT_MS
  );
}

/** Upper bound on a single recording's timeline (24h in ms). */
const MAX_EVENT_T_MS = 86_400_000;

const EventTimeSchema = z.number().int().min(0).max(MAX_EVENT_T_MS);

/**
 * Pointer activity inside the app frame. `x`/`y` are recorded-viewport CSS
 * pixels; `selector`/`ox`/`oy` anchor the event to its target element and the
 * pointer's offset within it, so replay can re-resolve the position in the
 * current layout instead of trusting raw coordinates.
 */
const PointerEventSchema = z
  .object({
    kind: z.literal("pointer"),
    t: EventTimeSchema,
    type: z.enum(["move", "down", "up", "click"]),
    x: z.number(),
    y: z.number(),
    button: z.number().int().optional(),
    selector: z.string().max(1_000).optional(),
    ox: z.number().optional(),
    oy: z.number().optional(),
  })
  .strict();

/** Raw key transitions (drives app key listeners, not text entry). */
const KeyEventSchema = z
  .object({
    kind: z.literal("key"),
    t: EventTimeSchema,
    type: z.enum(["down", "up"]),
    key: z.string().max(32),
    code: z.string().max(64),
    alt: z.boolean().optional(),
    ctrl: z.boolean().optional(),
    meta: z.boolean().optional(),
    shift: z.boolean().optional(),
  })
  .strict();

/**
 * A form control's committed value after user input — replay sets the value
 * directly (synthetic key events cannot type), then dispatches input/change.
 */
const InputEventSchema = z
  .object({
    kind: z.literal("input"),
    t: EventTimeSchema,
    selector: z.string().max(1_000),
    value: z.string().max(20_000).optional(),
    checked: z.boolean().optional(),
  })
  .strict();

/** Scroll position of the document (selector null) or a scrollable element. */
const ScrollEventSchema = z
  .object({
    kind: z.literal("scroll"),
    t: EventTimeSchema,
    selector: z.string().max(1_000).nullable(),
    x: z.number(),
    y: z.number(),
  })
  .strict();

/** App-frame viewport size at start and on resize — keys replay scaling. */
const ViewportEventSchema = z
  .object({
    kind: z.literal("viewport"),
    t: EventTimeSchema,
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  })
  .strict();

/**
 * One MCP exchange the host proxied for the app (tools/call, resources/read,
 * ...). The player answers the replayed app's identical call from `result`
 * instead of hitting a live gateway — the recording's "mocked MCP responses".
 */
const McpEventSchema = z
  .object({
    kind: z.literal("mcp"),
    t: EventTimeSchema,
    method: z.string().max(100),
    toolName: z.string().max(300).optional(),
    params: z.unknown().optional(),
    result: z.unknown().optional(),
    isError: z.boolean().optional(),
    durationMs: z.number().int().min(0).optional(),
  })
  .strict();

/**
 * The app switched to a different version snapshot mid-session (e.g. reload
 * after an edit) — the player remounts the frame with that segment's HTML.
 */
const SegmentMarkerEventSchema = z
  .object({
    kind: z.literal("segment"),
    t: EventTimeSchema,
    version: z.number().int(),
  })
  .strict();

/**
 * A canvas's pixels at one instant, as a data URL.
 *
 * An app that draws to a canvas produces no DOM mutation while it does so, and
 * what it drew cannot be re-derived from the input that caused it. The frames
 * are recorded as themselves and only when they change, so a still screen adds
 * nothing to the bundle.
 */
const CanvasFrameEventSchema = z
  .object({
    kind: z.literal("canvas"),
    t: EventTimeSchema,
    sel: z.string().max(1_000),
    data: z.string().max(2_000_000),
  })
  .strict();

/**
 * Opens (or reopens) one canvas's encoded video stream: the codec and coded
 * size a decoder needs before it can take chunks. Emitted when the recorder
 * (re)configures the encoder — at stream start and on a canvas resize — and
 * replayed as the decoder-reset point: every seek re-feeds from the config,
 * then the nearest keyframe.
 *
 * This is the stored (JSON) form of the stream; `description` is base64 codec
 * extradata for codecs that carry any. In memory the frame data flows as raw
 * bytes — base64 exists only in the bundle at rest.
 */
const VideoConfigEventSchema = z
  .object({
    kind: z.literal("video-config"),
    t: EventTimeSchema,
    sel: z.string().max(1_000),
    codec: z.string().max(64),
    codedWidth: z.number().int().positive(),
    codedHeight: z.number().int().positive(),
    description: z.string().max(65_536).optional(),
  })
  .strict();

/**
 * One encoded video chunk of a canvas's stream — what a real video file is
 * made of: rare standalone keyframes and cheap motion-compensated deltas, an
 * order of magnitude smaller than per-frame stills. `tsUs` is the encoder's
 * microsecond timestamp (monotonic within the stream); `data` is the chunk's
 * bytes, base64 in this stored form only.
 *
 * The `data` cap (~1.5MB of chunk before base64) is a corruption backstop,
 * not a rate control — the recorder's byte-rate governor and frame shed
 * bound throughput at record time. It is sized to admit the largest single
 * chunk the recorder can legitimately emit: typical deltas are kilobytes and
 * keyframes hundreds of kilobytes, but the SDK's worst case — a
 * max-quantizer keyframe of incompressible content (noise, particles) — runs
 * to megabytes, and a real keyframe refused here reads as a broken
 * recording.
 */
const VideoChunkEventSchema = z
  .object({
    kind: z.literal("video-chunk"),
    t: EventTimeSchema,
    sel: z.string().max(1_000),
    type: z.enum(["key", "delta"]),
    tsUs: z.number().int().min(0),
    data: z.string().max(2_000_000),
  })
  .strict();

/**
 * Opens (or reopens) the recording's single mixed audio stream: the codec and
 * sample format a decoder needs before it can take chunks. The recorder mixes
 * every app audio source — Web Audio graphs and `<audio>`/`<video>` playback —
 * into one Opus stream, so unlike video there is no per-canvas `sel`; there is
 * exactly one audio stream per recording. Replayed as the decoder-reset point:
 * a seek re-feeds this config, then the chunks from the seek point.
 *
 * Stored (JSON) form; `description` is base64 codec extradata (Opus carries its
 * channel/pre-skip config here). In memory the bytes flow raw — base64 exists
 * only in the bundle at rest.
 */
const AudioConfigEventSchema = z
  .object({
    kind: z.literal("audio-config"),
    t: EventTimeSchema,
    codec: z.string().max(64),
    sampleRate: z.number().int().positive(),
    numberOfChannels: z.number().int().positive().max(8),
    description: z.string().max(65_536).optional(),
  })
  .strict();

/**
 * One encoded audio chunk of the recording's mixed stream. `tsUs` is the
 * encoder's microsecond timestamp (monotonic within the stream); `data` is the
 * chunk's bytes, base64 in this stored form only. Opus frames are all
 * independently decodable, so — unlike video — there is no key/delta split.
 *
 * The `data` cap matches the video chunk's: a corruption backstop far above any
 * real Opus frame (which run to a few kilobytes), not a rate control.
 */
const AudioChunkEventSchema = z
  .object({
    kind: z.literal("audio-chunk"),
    t: EventTimeSchema,
    tsUs: z.number().int().min(0),
    data: z.string().max(2_000_000),
  })
  .strict();

/**
 * One DOM change: an element's markup after it changed, or one attribute.
 *
 * Replay applies these rather than re-running the app, so what the viewer sees
 * is what happened rather than what the same code does the second time.
 */
const DomMutationEventSchema = z
  .object({
    kind: z.literal("dom"),
    t: EventTimeSchema,
    op: z.enum(["html", "attr"]),
    sel: z.string().max(1_000),
    html: z.string().max(1_000_000).optional(),
    name: z.string().max(200).nullable().optional(),
    value: z.string().max(100_000).nullable().optional(),
  })
  .strict();

export const AppRecordingEventSchema = z.discriminatedUnion("kind", [
  PointerEventSchema,
  KeyEventSchema,
  InputEventSchema,
  ScrollEventSchema,
  ViewportEventSchema,
  McpEventSchema,
  SegmentMarkerEventSchema,
  CanvasFrameEventSchema,
  VideoConfigEventSchema,
  VideoChunkEventSchema,
  AudioConfigEventSchema,
  AudioChunkEventSchema,
  DomMutationEventSchema,
]);
export type AppRecordingEvent = z.infer<typeof AppRecordingEventSchema>;

/**
 * The exact HTML the sandboxed iframe ran for one app version during the
 * session — captured from the served resource, so it already carries the
 * injected SDK envelope and replays without any backend serve step.
 */
export const AppRecordingSegmentSchema = z
  .object({
    version: z.number().int(),
    html: z.string().max(5_000_000),
    /** Timeline offset at which this segment became the visible app. */
    atMs: EventTimeSchema,
  })
  .strict();
export type AppRecordingSegment = z.infer<typeof AppRecordingSegmentSchema>;

/**
 * A condensed transcript part: message text, or a tool-activity marker. `name`
 * is the tool's identity for icon/label resolution — for a `run_tool` dispatch
 * it is the underlying target tool, not the dispatcher. `label` overrides the
 * displayed text when it differs from the name (a loaded skill's name).
 */
export const AppRecordingTranscriptPartSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }).strict(),
  z
    .object({
      type: z.literal("tool"),
      name: z.string(),
      label: z.string().optional(),
    })
    .strict(),
]);
export type AppRecordingTranscriptPart = z.infer<
  typeof AppRecordingTranscriptPartSchema
>;

/**
 * One chat message in the recording's conversation, condensed for the player's
 * chat pane. `atMs` is relative to recording start; negative values are the
 * conversation history that predates the recording (shown immediately).
 */
export const AppRecordingTranscriptMessageSchema = z
  .object({
    id: z.string(),
    role: z.string(),
    atMs: z.number().int(),
    parts: z.array(AppRecordingTranscriptPartSchema),
  })
  .strict();
export type AppRecordingTranscriptMessage = z.infer<
  typeof AppRecordingTranscriptMessageSchema
>;

// =============================================================================
// User edits — layered over the immutable capture
// =============================================================================

/**
 * One cut: a range of the RAW recording timeline removed from playback. Raw
 * times (not the player's compressed presentation timeline) keep stored edits
 * stable across player versions. Negative times address the pre-recording chat
 * history the player animates before the capture starts. A cut never discards
 * captured data — playback collapses the range to zero time, applying its
 * events instantly, so the app state stays exactly in sync.
 */
const AppRecordingCutSchema = z
  .object({
    // Same coordinate space as transcript `atMs`: unbounded, because a cut may
    // address pre-recording chat history of any age (the timeline compresses
    // an arbitrarily old conversation into the replay's head).
    fromMs: z.number().int(),
    toMs: z.number().int(),
  })
  .strict();

/** A manual text override for one captured user message, keyed by its id. */
const AppRecordingMessageEditSchema = z
  .object({
    id: z.string(),
    text: z.string().max(20_000),
  })
  .strict();

/**
 * The viewer's chat edits: opt in to the AI-enhanced consolidation (the player
 * replays the original conversation as-is by default), drop captured messages
 * from the replay, or override a user message's text. All keyed by the captured
 * messages' immutable ids — the capture itself never changes, so clearing an
 * entry restores the original message.
 */
const AppRecordingChatEditsSchema = z
  .object({
    /**
     * Opt in to replaying the AI-enhanced consolidation (the single
     * consolidated prompt and closing response) in place of the original
     * conversation. Absent/false → the captured chat replays verbatim, which
     * is the default. The AI enhancement is still drafted and packed into the
     * bundle for the gallery regardless of this flag — it only governs what the
     * PLAYER replays.
     */
    enhancementEnabled: z.boolean().optional(),
    /**
     * @deprecated Superseded by `enhancementEnabled` once the default flipped
     * to the original chat. Kept in this strict schema only so recordings
     * stored with it still validate; it is no longer read anywhere.
     */
    enhancementDisabled: z.boolean().optional(),
    // Same anti-abuse ceiling as cuts: far above any real editing session.
    removedMessageIds: z.array(z.string()).max(500).optional(),
    editedMessages: z.array(AppRecordingMessageEditSchema).max(500).optional(),
  })
  .strict();

/**
 * The viewer's edits to a recording — held EXCLUSIVELY here, so the captured
 * `recording` object stays byte-identical to what the session produced.
 * Removing this object restores the original replay.
 */
const AppRecordingEditsSchema = z
  .object({
    cuts: z.array(AppRecordingCutSchema).max(500),
    chat: AppRecordingChatEditsSchema.optional(),
  })
  .strict();

/**
 * The AI-generated presentation layer over a recording — a one-sentence app
 * description and one consolidated build prompt (the initial ask merged with
 * every refinement, written as if the builder had asked for the final app in
 * one go). Drafted by the model, then hand-edited by the builder. Held
 * EXCLUSIVELY here so the captured session data stays untouched; the player
 * shows the consolidated prompt in place of the real user messages while the
 * captured skill/tool activity replays unchanged after it.
 */
/**
 * Ceiling for the one-sentence description shown in the player header: short
 * enough to hold within three lines on a narrow screen. Enforced at every
 * entry point — the AI drafting prompt, the draft sanitizer, and the manual
 * editor — so a stored description never needs trimming at render time. (The
 * schema max below stays looser so previously stored bundles keep
 * validating.)
 */
export const APP_RECORDING_DESCRIPTION_MAX_CHARS = 160;

/**
 * Marks the one element a rendered video is cropped to: the chat pane and the
 * app stage, and nothing else — no toolbar, description or timeline. The
 * offline renderer clips its screenshots to this element's box, so the player
 * and the renderer must name it identically or the export silently reframes.
 */
/**
 * The page the offline video renderer drives. It is a pure sink: it fetches
 * nothing and shows nothing until a bundle is pushed into it by the automation
 * driving the browser, which is why it renders outside the app's chrome and
 * without a session — the renderer has neither.
 */
export const APP_RECORDING_RENDER_ROUTE = "/app-recording-render";

/**
 * Frame rate of an exported video. Shared because the author is told how long
 * their export will take before it starts, and an estimate computed against a
 * different frame rate than the renderer uses is worse than no estimate.
 *
 * Every frame costs the same to render — a screenshot plus an encode, around
 * 83ms — so the export takes as long as the frame count, and the frame rate is
 * the only lever on it that costs nothing else. 24 sits just above what a
 * session actually contains: the replayed app produces new pixels around 18
 * times a second and the chat far less, so the frames above this rate were
 * repeats of the one before. Going lower would start dropping real motion.
 */
export const APP_RECORDING_RENDER_FPS = 24;

/**
 * The DEFAULT longest final cut a recording may be submitted or exported at.
 *
 * A deployment overrides it with `ARCHESTRA_HACKATHON_RECORDER_MAX_FINAL_CUT_MS`
 * — this constant is the fallback and the shape of the bound, never the
 * authority. Read the resolved value from the config (`hackathonMaxFinalCutMs`
 * on the frontend, `config.hackathonRecorder.maxFinalCutMs` on the backend), so
 * every surface that quotes a number to the author quotes the SAME number the
 * checks enforce.
 *
 * The limit is as much editorial as technical: a session demo that runs long
 * stops being a demo, and every frame costs about the same to render, so an
 * export's cost is its length. The editor asks for a short cut up front and the
 * submit/export buttons hold the line rather than starting work that outlives
 * anyone's patience.
 *
 * A minute is also the length that makes a full-motion canvas app submittable
 * at all. The bundle stores video base64 inside its JSON and the upload
 * base64-encodes that JSON again, so a byte of recorded video costs ~1.78
 * bytes by the time api.github.com sees it: at the SDK's 1 Mbit/s governor
 * ceiling a minute lands near 13MB on the wire, comfortably under the largest
 * submission the gallery has actually accepted. Two minutes at the old
 * 3 Mbit/s ceiling reached ~76MB and was refused outright.
 */
export const APP_RECORDING_DEFAULT_MAX_FINAL_CUT_MS = 60_000;

/**
 * A duration as every length surface says it out loud: `m:ss`, floored to the
 * second. One implementation, because the limit is JUDGED at this precision
 * too (see {@link exceedsFinalCutLimit}) and a formatter that disagreed with
 * the check is exactly how a cut came to be refused for running "1:00" when
 * the limit was "1:00".
 */
export function formatDurationMs(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, "0")}`;
}

/**
 * Whether a final cut is over the limit — judged at the precision the limit is
 * SPOKEN at, whole seconds, not raw float milliseconds.
 *
 * This is the whole of the fix for a paradox that reached participants: the
 * gates compared floats while every message rendered `m:ss`, so the entire
 * second above the limit was refused AND printed as exactly the limit. The
 * tooltip read "This cut runs 1:00. Trim it to 1:00 or less to submit." — a
 * demand with nothing to do — and the trim button beside it could be a no-op,
 * because a fraction of a second is not something an author can edit away.
 *
 * Compared floored rather than rounded so the rule reads the way the number
 * does: if it says 1:00 it is a minute, and a minute is allowed. The slack is
 * at most one second of render, which costs ~24 frames.
 *
 * Every gate must use THIS — player, submission backstop, and the server's
 * render route — or a cut passes one and is refused by the next.
 */
export function exceedsFinalCutLimit(
  durationMs: number,
  limitMs: number,
): boolean {
  return Math.floor(durationMs / 1000) > Math.floor(limitMs / 1000);
}

/**
 * How much longer than the final cut a capture may RUN, as a multiple of the
 * configured limit.
 *
 * Capture needs room the final cut does not: a participant records loosely and
 * edits down, and a take that stops dead at the submittable length leaves them
 * nothing to cut. It is bounded rather than open-ended because everything
 * captured sits in the browser until it is edited.
 *
 * What makes the headroom safe is that cutting now shrinks the bundle:
 * {@link pruneCutEvents} drops the video a cut removes, so a loose take edited
 * to a minute ships like a minute — not like the take. Before that, headroom
 * would only have produced recordings that could be edited but never uploaded.
 */
export const APP_RECORDING_CAPTURE_HEADROOM = 3;

/**
 * The largest recording bundle (its serialized JSON) the VIDEO RENDERER
 * accepts — a backstop on what may be posted to our own render route, not a
 * statement about what GitHub takes.
 *
 * The gallery submission is bounded separately and far more tightly, by what
 * api.github.com accepts as a request body once base64 has had its way with
 * the bundle. This one only has to keep a renderer from being handed
 * something absurd: capture keeps real bundles orders of magnitude below it —
 * the SDK's governor bounds video at 1 Mbit/s across all streams, so even a
 * three-minute all-motion raw take stays near 30MB serialized.
 */
export const APP_RECORDING_MAX_BUNDLE_BYTES = 100 * 1024 * 1024;

export const APP_RECORDING_RENDER_REGION_ATTR =
  "data-app-recording-render-region";
export const APP_RECORDING_RENDER_REGION_SELECTOR = `[${APP_RECORDING_RENDER_REGION_ATTR}]`;

/**
 * The canonical width:height aspect the app is recorded at — the side panel
 * locks itself to this shape while a recording runs, and the player's app
 * stage replays at the recorded shape. One constant on both ends means a
 * recorded session scales into the player by a single uniform factor: no
 * letterbox, no distortion, and pointer coordinates that line up exactly.
 * 4:5 — the near-square portrait standard (the Instagram-post shape): still
 * a tall column beside the chat, the surface a recording nudges the app
 * into, but square-ish enough that apps aren't forced into a phone-narrow
 * strip and the player splits close to evenly between chat and app.
 */
export const APP_RECORDING_VIEWPORT_ASPECT = 4 / 5;

const AppRecordingEnhancementSchema = z
  .object({
    description: z.string().max(1_000),
    prompt: z.string().max(20_000),
    /** The one closing agent reply ("here is what I built…" plus what the app
     * does) the enhanced replay shows in place of the captured assistant
     * prose — the captured skill/tool activity still replays as-is around it.
     * Optional so bundles saved before this field keep validating (the player
     * falls back to a stock line). */
    response: z.string().max(20_000).optional(),
    /** One-word gallery category ("Development", "Finance", …), drafted with
     * the rest of the enhancement. Optional — older bundles carry none. */
    category: z.string().max(60).optional(),
  })
  .strict();

// =============================================================================
// Portable bundle
// =============================================================================

/**
 * Safety bounds on a recording's timeline (mirrored by the client recorder).
 * The transcript is the complete chat session and is never truncated by count —
 * `maxTranscriptMessages` is only an anti-abuse ceiling far above any real
 * conversation.
 */
export const APP_RECORDING_LIMITS = {
  maxEvents: 50_000,
  maxSegments: 25,
  maxTranscriptMessages: 20_000,
  maxTranscriptPartText: 100_000,
} as const;

/**
 * Portable self-contained export of a recording — everything a foreign viewer
 * needs to replay the demo with zero calls back into this deployment.
 * Assembled client-side; the same contract validates it at record time, at
 * replay time, at download time, and on the server routes that accept it.
 */
export const AppRecordingBundleSchema = z
  .object({
    formatVersion: z.literal(1),
    app: z
      .object({
        id: z.string().uuid().nullable(),
        name: z.string(),
      })
      .strict(),
    recording: z
      .object({
        title: z.string(),
        startedAt: z.string(),
        durationMs: z.number().int(),
        events: z
          .array(AppRecordingEventSchema)
          .max(APP_RECORDING_LIMITS.maxEvents),
        segments: z
          .array(AppRecordingSegmentSchema)
          .min(1)
          .max(APP_RECORDING_LIMITS.maxSegments),
        transcript: z
          .array(AppRecordingTranscriptMessageSchema)
          .max(APP_RECORDING_LIMITS.maxTranscriptMessages),
      })
      .strict(),
    edits: AppRecordingEditsSchema.optional(),
    enhancement: AppRecordingEnhancementSchema.optional(),
    meta: z
      .object({
        authorName: z.string().nullable(),
        createdAt: z.string(),
        platform: z.literal("archestra"),
        /** Gallery facts about the build, captured alongside the recording:
         * the MCP servers the app actually called, and how many app versions
         * the session produced. Built date and total duration are already
         * carried by `createdAt` and `recording.durationMs`. Optional —
         * bundles saved before these fields keep validating. */
        mcpServers: z.array(z.string()).max(50).optional(),
        appVersionCount: z.number().int().nonnegative().optional(),
        /** The LLM model that built the app, as a display name (e.g. "Claude
         * Sonnet") — not a provider id. Set once at record time from the
         * chat's active model; absent when it couldn't be resolved. */
        model: z.string().max(200).optional(),
        /** Count of the builder's own chat messages that produced the app —
         * every `role: "user"` entry in `recording.transcript`, including any
         * pre-recording history it carries. Distinct from `appVersionCount`
         * (app versions, not prompts). */
        userPromptCount: z.number().int().nonnegative().optional(),
        /** The gallery submitter's public GitHub identity, stamped at share
         * time after sign-in. Only the login and public display name — NEVER
         * an email, even though GitHub's user endpoint returns one alongside
         * them. */
        github: z
          .object({
            login: z.string().max(100),
            name: z.string().max(200).nullable(),
          })
          .strict()
          .optional(),
        /** The recording's duration as shown by the editor's final cut
         * (cuts applied, idle time-lapse compressed) — what a gallery viewer
         * should see as "how long this demo is". `recording.durationMs`
         * stays the raw, uncut capture length; this is the one gallery
         * submissions should display and derive a thumbnail's timing from.
         * Absent on bundles saved before this field existed. */
        finalCutDurationMs: z.number().int().nonnegative().optional(),
      })
      .strict(),
  })
  .strict();
export type AppRecordingBundle = z.infer<typeof AppRecordingBundleSchema>;

/**
 * The distinct MCP servers an app is connected to, derived from its assigned
 * tools. Each tool's `name` is a fully-qualified `<server>__<tool>`; the server
 * half is the name — the same convention the captured tool calls use, so a
 * recording's connected-server list and its observed-server list speak the same
 * vocabulary. Sorted and de-duplicated.
 */
export function connectedMcpServerNames(
  appTools: { name: string }[] | undefined | null,
): string[] {
  const names = new Set<string>();
  for (const tool of appTools ?? []) {
    const server = parseFullToolName(tool.name).serverName;
    if (server) names.add(server);
  }
  return [...names].sort();
}

/**
 * Self-heal a recording's connected-MCP list: union whatever the bundle already
 * records with the app's currently-connected servers. A recording captured
 * before the connected list was part of the bundle — or one whose app has since
 * been wired to more servers — then lists every server the app is connected to,
 * not only those the recorded session happened to call. Never shrinks (a server
 * the session used but the app has since disconnected is kept), and returns the
 * same bundle instance when nothing new is added, so an already-complete list
 * is left untouched.
 */
export function healBundleMcpServers(
  bundle: AppRecordingBundle,
  appTools: { name: string }[] | undefined | null,
): AppRecordingBundle {
  const existing = bundle.meta.mcpServers ?? [];
  const merged = new Set(existing);
  for (const server of connectedMcpServerNames(appTools)) merged.add(server);
  if (merged.size === existing.length) return bundle;
  return {
    ...bundle,
    meta: { ...bundle.meta, mcpServers: [...merged].sort() },
  };
}

// =============================================================================
// Validation + redaction — shared by recorder, player, and downloader
// =============================================================================

/**
 * Sensitive values are replaced with this marker at sanitize time. The player
 * renders runs of it blurred; it is plain static text, so a bundle never
 * carries the original value anywhere.
 */
export const APP_RECORDING_REDACTED = "●●●●●●";

/**
 * Detectors for values that must never leave the browser inside a bundle:
 * common API-key/token shapes, JWTs, bearer headers, and key=value pairs whose
 * key smells like a credential. Deliberately conservative — a missed secret is
 * worse than an over-redacted demo, but plain prose must survive intact.
 */
const SENSITIVE_PATTERNS: RegExp[] = [
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/g,
  /\b(?:bearer)\s+[A-Za-z0-9._~+/-]{16,}=*/gi,
];
const KEYED_SECRET_PATTERN =
  /\b(password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)(["']?\s*[:=]\s*["']?)([^\s"',;]{6,})/gi;

/** Redact sensitive values in one string. */
export function redactSensitiveText(text: string): string {
  let out = text;
  for (const pattern of SENSITIVE_PATTERNS) {
    out = out.replace(pattern, APP_RECORDING_REDACTED);
  }
  out = out.replace(
    KEYED_SECRET_PATTERN,
    (_, key, sep) => `${key}${sep}${APP_RECORDING_REDACTED}`,
  );
  return out;
}

/**
 * Sanitize a bundle's data planes in place of a copy: chat text, typed input
 * values, MCP params/results, and the presentation fields. The app segments'
 * HTML is the app's own served code (not user-entered data) and redacting
 * inside it would corrupt the app, so it is exempt; secret form fields are
 * already masked at capture by the recorder SDK.
 */
export function sanitizeRecordingBundle(
  bundle: AppRecordingBundle,
): AppRecordingBundle {
  return {
    ...bundle,
    recording: {
      ...bundle.recording,
      title: redactSensitiveText(bundle.recording.title),
      events: bundle.recording.events.map((event) => {
        if (event.kind === "input" && typeof event.value === "string") {
          return { ...event, value: redactSensitiveText(event.value) };
        }
        if (event.kind === "mcp") {
          return {
            ...event,
            params: redactDeep(event.params),
            result: redactDeep(event.result),
          };
        }
        return event;
      }),
      transcript: bundle.recording.transcript.map((message) => ({
        ...message,
        parts: message.parts.map((part) =>
          part.type === "text"
            ? { ...part, text: redactSensitiveText(part.text) }
            : part,
        ),
      })),
    },
    // Spread, then redact the prose fields. Re-listing the fields instead
    // whitelists them: every field added to the enhancement later is dropped
    // here silently, which is how freshly recorded bundles lost their closing
    // response and their category on the way to storage.
    enhancement: bundle.enhancement
      ? {
          ...bundle.enhancement,
          description: redactSensitiveText(bundle.enhancement.description),
          prompt: redactSensitiveText(bundle.enhancement.prompt),
          ...(bundle.enhancement.response === undefined
            ? {}
            : { response: redactSensitiveText(bundle.enhancement.response) }),
        }
      : bundle.enhancement,
  };
}

/** Redact every string inside an arbitrary JSON-shaped value. */
function redactDeep(value: unknown): unknown {
  if (typeof value === "string") return redactSensitiveText(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        redactDeep(entry),
      ]),
    );
  }
  return value;
}

export type AppRecordingValidation =
  | { ok: true; bundle: AppRecordingBundle }
  | { ok: false; reason: string };

/**
 * Validate a candidate bundle against the contract plus the structural rules a
 * replayable demo requires: schema-valid (strict — static data only), at least
 * one app version with HTML (the session must actually create an app), and a
 * chat transcript. Returns the parsed bundle so callers replay/store exactly
 * what was validated.
 */
export function validateRecordingBundle(
  candidate: unknown,
): AppRecordingValidation {
  const parsed = AppRecordingBundleSchema.safeParse(candidate);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.join(".") ?? "";
    if (path.startsWith("recording.segments")) {
      return {
        ok: false,
        reason:
          "The recording contains no app version — a demo must capture the app being created.",
      };
    }
    return {
      ok: false,
      reason: `The bundle does not match the recording contract (${issue ? `${path || "root"}: ${issue.message}` : "invalid"}).`,
    };
  }
  const bundle = parsed.data;
  if (!bundle.recording.segments.some((segment) => segment.html.trim())) {
    return {
      ok: false,
      reason:
        "The recording contains no app version — a demo must capture the app being created.",
    };
  }
  if (bundle.recording.transcript.length === 0) {
    return {
      ok: false,
      reason: "The recording contains no chat activity.",
    };
  }
  return { ok: true, bundle };
}

// =============================================================================
// Cut pruning — drop what an edit puts permanently out of view
// =============================================================================

type RecordingCut = NonNullable<AppRecordingBundle["edits"]>["cuts"][number];

/**
 * How close to the data's end a cut must reach to count as an END trim rather
 * than a mid cut — a few frames of slop, so a trim dragged to the very end still
 * registers as one. MUST match the player's tail-trim detection in buildPlayback
 * (both import this), or a pruned bundle could diverge from what the player
 * renders.
 */
export const TRIM_EDGE_EPS_MS = 25;

/**
 * Merge stored cuts into sorted, non-overlapping ranges. Cuts may be authored
 * overlapping (each edit just appends a range); playback and pruning both reason
 * over the merged set. Shared so the player and the pruner cannot disagree on
 * what a cut covers.
 */
export function normalizeCuts(cuts: RecordingCut[]): RecordingCut[] {
  const sorted = cuts
    .filter((cut) => cut.toMs > cut.fromMs)
    .sort((a, b) => a.fromMs - b.fromMs);
  const merged: RecordingCut[] = [];
  for (const cut of sorted) {
    const last = merged[merged.length - 1];
    if (last && cut.fromMs <= last.toMs) {
      last.toMs = Math.max(last.toMs, cut.toMs);
    } else {
      merged.push({ ...cut });
    }
  }
  return merged;
}

/**
 * Drop what the recording's cuts put permanently out of view, so an edited
 * recording ships — and renders — at the size of what it actually shows.
 *
 * A size optimization only: the result replays and renders identically to the
 * original. Two passes, each lossless for its own reason — a trailing trim
 * takes everything past it, and a mid cut takes the encoded video it hides
 * (and only that). Neither touches timing, cuts, segments or transcript.
 *
 * Cutting really removing bytes is what lets capture run longer than the final
 * cut may be: a loose take edited down to a minute ships like a minute.
 */
export function pruneCutEvents(bundle: AppRecordingBundle): AppRecordingBundle {
  return pruneCutVideoChunks(pruneTrailingTrimEvents(bundle));
}

/**
 * Drop captured events that a trailing END trim removes, so a trimmed recording
 * ships — and renders — without its cut-away tail. A size optimization only: the
 * result replays and renders byte-for-byte the same as the original.
 *
 * Why it is lossless. The player already excludes events past a trailing trim
 * when it builds playback (its `withinEnd` filter), so those events never reach
 * a rendered frame. This persists exactly that exclusion into the bundle, and
 * ONLY for a trailing trim — mid cuts are left whole, because the player still
 * applies their events (collapsed to one instant) to keep the app's state
 * correct for what plays AFTER them, so removing them would change the replay.
 *
 * What is kept, so the replay's timing is identical:
 *  - `viewport` events at any time — the stage size is a whole-recording
 *    aggregate (`dominantViewport`), so dropping one could resize the video;
 *  - events at or before the trim's start (they still play), and events PAST the
 *    trim's end (their timeline anchor sits outside the collapsed range and so
 *    still shapes the playback clock);
 *  - an `mcp` event that STRADDLES the trim start — its own time is past it, but
 *    it plants a second compression anchor at `t - durationMs` which is not, so
 *    it lands in the kept region and must be preserved (see the filter);
 *  - cuts, durationMs, segments and transcript, all verbatim.
 *
 * Only events whose every timeline anchor falls strictly inside the trailing
 * cut's own [fromMs, toMs] are removed — where playback collapses to zero time,
 * so those anchors carry none. A self-guard bails out entirely in the unusual
 * case where data runs past the recorded duration and removal would move the
 * trim boundary itself.
 */
function pruneTrailingTrimEvents(
  bundle: AppRecordingBundle,
): AppRecordingBundle {
  const cuts = bundle.edits?.cuts;
  if (!cuts || cuts.length === 0) return bundle;

  const { events } = bundle.recording;
  const rawDataEnd = dataEndOf(bundle.recording, events);

  const tail = normalizeCuts(cuts).find(
    (cut) =>
      cut.toMs >= rawDataEnd - TRIM_EDGE_EPS_MS && cut.fromMs < rawDataEnd,
  );
  if (!tail) return bundle;

  const kept = events.filter((event) => {
    // Keep viewport events (stage sizing is a whole-recording aggregate) and
    // anything whose timeline anchor sits OUTSIDE the collapsed range: at or
    // before the trim start (it still plays) or past the trim end (its anchor
    // still shapes the playback clock).
    if (event.kind === "viewport" || event.t > tail.toMs) return true;
    // An mcp event with a duration plants a SECOND compression anchor at its
    // start — max(0, t - durationMs), mirroring buildPlayback. If that start
    // lands at or before the trim it sits in the KEPT region and shapes idle-gap
    // compression (whose per-gap cap is non-additive), so the event must stay.
    // Playback still excludes it from the rendered events — its own time is past
    // the trim — so only the anchor is preserved, at no render cost.
    const anchorStart =
      event.kind === "mcp" && event.durationMs
        ? Math.max(0, event.t - event.durationMs)
        : event.t;
    return anchorStart <= tail.fromMs;
  });
  if (kept.length === events.length) return bundle;

  // Never let the pruned data end fall short of the original: that would move
  // the tail-trim boundary and change the replay. Holds whenever the recorded
  // duration already covers all the data (the normal case).
  if (dataEndOf(bundle.recording, kept) !== rawDataEnd) return bundle;

  return { ...bundle, recording: { ...bundle.recording, events: kept } };
}

/**
 * Drop the encoded video a MID cut hides — the one payload a cut can throw
 * away without changing a single rendered frame.
 *
 * Mid cuts otherwise stay whole (see {@link pruneTrailingTrimEvents}): the
 * player collapses a cut to one instant but still APPLIES the events inside
 * it, because a DOM mutation or an input in there is what leaves the app in
 * the state everything AFTER the cut plays from. Video is the exception. A
 * stream's state lives in its decoder, and a decoder is rebuilt from a
 * keyframe alone — so the frames a cut hides need not ship for the frames
 * after it to decode to the same pixels.
 *
 * KEYFRAME-AWARE, which is the whole of the correctness argument: every kept
 * run of chunks BEGINS with a keyframe. Per stream, the chunks in view are
 * kept, then each run is extended backwards to the last keyframe at or before
 * it, taking the deltas in between — usually chunks the cut hides, which is
 * the point. Hand a decoder a keyframe and the deltas that follow and it
 * produces exactly what the whole stream would have; hand it a delta whose
 * predecessors were dropped and it produces nothing or garbage. Keyframes land
 * on a fixed cadence, so that preamble costs at most one cadence per cut.
 *
 * Timing is untouched: only chunks strictly inside a cut are candidates, and
 * playback collapses a cut to zero time, so nothing in there carries a
 * timeline anchor — the same reason the trailing pass gives. `video-config`
 * events are never candidates; they are a few hundred bytes and they are what
 * opens the stream.
 */
function pruneCutVideoChunks(bundle: AppRecordingBundle): AppRecordingBundle {
  const cuts = normalizeCuts(bundle.edits?.cuts ?? []);
  if (cuts.length === 0) return bundle;

  const { events } = bundle.recording;
  // The trailing pass's boundary treatment exactly: a chunk sitting ON a cut's
  // start still plays, one sitting on its end does not.
  const hidden = (t: number) =>
    cuts.some((cut) => cut.fromMs < t && t <= cut.toMs);

  // Per stream, because chunk dependencies run within one canvas's stream and
  // a keyframe in one says nothing about another.
  const streams = new Map<string, { at: number; t: number; key: boolean }[]>();
  events.forEach((event, at) => {
    if (event.kind !== "video-chunk") return;
    const chunk = { at, t: event.t, key: event.type === "key" };
    const stream = streams.get(event.sel);
    if (stream) stream.push(chunk);
    else streams.set(event.sel, [chunk]);
  });

  const dropped = new Set<number>();
  for (const chunks of streams.values()) {
    const keep = new Set<number>();
    chunks.forEach((chunk, i) => {
      if (!hidden(chunk.t)) keep.add(i);
    });
    for (let i = 0; i < chunks.length; i++) {
      // Only the FIRST chunk of each kept run needs a preamble — every later
      // chunk in the run already has its predecessors in front of it.
      if (!keep.has(i) || keep.has(i - 1)) continue;
      let key = i;
      while (key >= 0 && !chunks[key].key) key--;
      // A run with no keyframe anywhere before it belongs to a stream that
      // cannot be decoded from the middle at all — keep it whole rather than
      // gamble on which of its chunks matter.
      if (key < 0) key = 0;
      for (let back = key; back < i; back++) keep.add(back);
    }
    chunks.forEach((chunk, i) => {
      if (!keep.has(i)) dropped.add(chunk.at);
    });
  }
  if (dropped.size === 0) return bundle;

  const kept = events.filter((_, at) => !dropped.has(at));
  // The same self-guard the trailing pass carries: a bundle whose data runs
  // past its recorded duration could otherwise have its end moved by this,
  // which would move the cut boundaries with it.
  if (dataEndOf(bundle.recording, kept) !== dataEndOf(bundle.recording, events))
    return bundle;

  return { ...bundle, recording: { ...bundle.recording, events: kept } };
}

/**
 * The last moment of real data — mirrors buildPlayback's rawDataEnd, which
 * starts at the recorded duration and grows to the furthest event, segment or
 * message. A trailing trim is a cut that reaches this end.
 */
function dataEndOf(
  recording: AppRecordingBundle["recording"],
  events: AppRecordingBundle["recording"]["events"],
): number {
  let end = Math.max(0, recording.durationMs);
  for (const event of events) end = Math.max(end, event.t);
  for (const segment of recording.segments) end = Math.max(end, segment.atMs);
  for (const message of recording.transcript) end = Math.max(end, message.atMs);
  return end;
}
