import { z } from "zod";

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
 * The viewer's chat edits: hide the AI-enhanced consolidation (replaying the
 * original conversation instead), drop captured messages from the replay, or
 * override a user message's text. All keyed by the captured messages'
 * immutable ids — the capture itself never changes, so clearing an entry
 * restores the original message.
 */
const AppRecordingChatEditsSchema = z
  .object({
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
 * The longest final cut that can be exported to video.
 *
 * Every frame costs about the same to render, so the export's cost is its
 * length: half a minute of video is already a minute of rendering. The limit is
 * as much editorial as technical — a session demo that runs longer than this
 * stops being a demo — so the editor asks for it up front and the export button
 * holds the line rather than starting a render that outlives anyone's patience.
 */
export const APP_RECORDING_MAX_EXPORT_MS = 30_000;

export const APP_RECORDING_RENDER_REGION_ATTR =
  "data-app-recording-render-region";
export const APP_RECORDING_RENDER_REGION_SELECTOR = `[${APP_RECORDING_RENDER_REGION_ATTR}]`;

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
      })
      .strict(),
  })
  .strict();
export type AppRecordingBundle = z.infer<typeof AppRecordingBundleSchema>;

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
