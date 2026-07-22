"use client";

import {
  APP_RECORDING_DESCRIPTION_MAX_CHARS,
  APP_RECORDING_MAX_EXPORT_MS,
  APP_RECORDING_RENDER_REGION_ATTR,
  APP_RECORDING_VIEWPORT_ASPECT,
  ARCHESTRA_MCP_CATALOG_ID,
  getArchestraToolShortName,
  normalizeCuts,
  parseFullToolName,
  TRIM_EDGE_EPS_MS,
  validateRecordingBundle,
} from "@archestra/shared";
import { AppBridge } from "@modelcontextprotocol/ext-apps/app-bridge";
import {
  AppWindow,
  CornerDownLeftIcon,
  Download as DownloadIcon,
  HelpCircle,
  Pause,
  Pencil,
  Play,
  Redo2,
  Scissors,
  Sparkles,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Conversation,
  ConversationContent,
} from "@/components/ai-elements/conversation";
import { Loader } from "@/components/ai-elements/loader";
import { Message, MessageContent } from "@/components/ai-elements/message";
import { Response } from "@/components/ai-elements/response";
import { AppGalleryShareButton } from "@/components/app-session-recording/app-gallery-share-dialog";
import { McpAppPill } from "@/components/mcp-app/mcp-app-chrome";
import {
  buildReplayHostContext,
  SandboxIframe,
} from "@/components/mcp-app/mcp-app-view";
import { McpCatalogIcon } from "@/components/mcp-catalog-icon";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { InputGroupButton } from "@/components/ui/input-group";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  cancelAppRecordingVideoRender,
  fallbackRecordingDescription,
  useAppRecording,
  useAppRecordingEditor,
  useEnhanceAppRecording,
  useIsRenderingAppRecordingVideo,
  useRenderAppRecordingVideo,
} from "@/lib/app-session-recording/app-recording.query";
import {
  type RuntimeRecordingEvent,
  reviveRecordingEvents,
} from "@/lib/app-session-recording/app-recording-binary";
import type { AppRecordingBundle } from "@/lib/app-session-recording/app-recording-store";
import { getMcpSandboxBaseUrl } from "@/lib/config/config";
import { useMcpSandboxDomain } from "@/lib/config/config.query";
import { usePlatform } from "@/lib/hooks/use-platform";
import { cn } from "@/lib/utils";

/**
 * The stored recording flattened for playback: the immutable capture plus the
 * app name and the viewer's edits (cuts), which layer over the capture without
 * ever modifying it. Events are the REVIVED runtime form — frame payloads as
 * Blobs/bytes; their base64 was decoded once when the bundle was opened.
 */
type PlaybackRecording = Omit<AppRecordingBundle["recording"], "events"> & {
  events: RuntimeRecordingEvent[];
  appName: string;
  /** The capture's own transcript, untouched — the chat editor's source. */
  originalTranscript: AppRecordingBundle["recording"]["transcript"];
  edits?: AppRecordingBundle["edits"];
  enhancement?: AppRecordingBundle["enhancement"];
};
type RecordingChatEdits = NonNullable<
  NonNullable<AppRecordingBundle["edits"]>["chat"]
>;
type RecordingEnhancement = NonNullable<AppRecordingBundle["enhancement"]>;
type TimelineEvent = PlaybackRecording["events"][number];
type McpTimelineEvent = Extract<TimelineEvent, { kind: "mcp" }>;
type TranscriptMessage = PlaybackRecording["transcript"][number];

const REPLAY_CONTROL_TYPE = "mcp-apps:replay-control";
/** How often the (rAF-driven) internal clock is mirrored into React state. */
const DISPLAY_CLOCK_INTERVAL_MS = 100;
/** Arrow-key seek step. */
const SEEK_STEP_MS = 5_000;
/**
 * How often a drag-scrub may rewind. Scrubbing forward just applies the
 * skipped events in place, so it follows every pointer move; a rewind remounts
 * the app frame and replays its segment, which per move would be a remount
 * storm that never gets a frame on screen. Rewinds coalesce onto this
 * throttle — leading edge so the first backward tick is immediate, trailing
 * edge so the scrub always settles on the latest point.
 */
const SCRUB_REWIND_THROTTLE_MS = 200;
/**
 * How far ahead of an upcoming assistant message the chat shows a "thinking"
 * loader — the recording has no explicit generation-start marker, so the gap
 * before the message lands stands in for "the assistant is responding".
 */
const THINKING_LEAD_MS = 2_500;
/** Lead time over which the next user message "types" into the chat composer. */
const COMPOSER_TYPE_LEAD_MS = 1_200;
/**
 * After typing finishes, the composer holds the finished message with its send
 * button pressed for this beat before the message posts — the visible "send".
 */
const SEND_PRESS_MS = 220;
/** Streamed chat text reveal rate and the cap on how long one message streams. */
const STREAM_CHARS_PER_MS = 0.16;
const STREAM_MAX_MS = 1_200;
/** How long each tool-call marker takes to reveal, so a burst lands in order. */
const TOOL_REVEAL_MS = 280;

/** How long one part of an assistant message takes to reveal. */
function partRevealMs(part: TranscriptMessage["parts"][number]): number {
  return part.type === "text"
    ? Math.min(STREAM_MAX_MS, part.text.length / STREAM_CHARS_PER_MS)
    : TOOL_REVEAL_MS;
}

/** How long a whole assistant message takes to reveal, part by part. */
function messageRevealMs(parts: TranscriptMessage["parts"]): number {
  return parts.reduce((total, part) => total + partRevealMs(part), 0);
}

/**
 * When the agent answers several times in a row the capture can stamp those
 * messages at (nearly) the same instant. Replaying them by timestamp alone
 * dumps the whole burst on screen at once, so they are scheduled instead: each
 * message starts no earlier than the previous one finished revealing, and every
 * tool marker and line of prose still lands in order.
 *
 * That cascade can push the tail of a burst BEYOND the end of the playback —
 * the clock stops at `durationMs`, so those messages never reveal and the chat
 * replays only partly. The schedule is therefore fitted to the playback:
 * reveals are sped up by whatever uniform `revealScale` makes the last one land
 * on time. The cascade end falls monotonically with that factor (at 0 every
 * message sits on its own timestamp, which is inside the playback by
 * construction), so a short bisection finds it.
 */
/** One AI enhancement draft as the enhance endpoint returns it. */
export interface RecordingEnhancementDraft {
  description: string | null;
  prompt: string | null;
  response: string | null;
  category: string | null;
}

/**
 * What to store when a regenerate lands, so a generated closing response is
 * never thrown away.
 *
 * A bundle whose enhancement was drafted before the closing response existed —
 * or whose one generation failed — carries none, and the replay shows a stock
 * line. Every regenerate the builder then reaches for (description, prompt)
 * produces a fresh response and used to discard it, so the stock line survived
 * forever. Only the MISSING field is adopted: what the builder already has,
 * including anything hand-edited, always wins.
 *
 * Returns null when nothing is missing, so a no-op never costs an undo step.
 */
export function backfilledEnhancement(
  stored: RecordingEnhancement | null,
  result: RecordingEnhancementDraft | null | undefined,
  appName: string,
): RecordingEnhancement | null {
  if (!result?.response?.trim() || stored?.response?.trim()) return null;
  const category = stored?.category ?? result.category ?? undefined;
  return {
    description:
      stored?.description ??
      result.description ??
      fallbackRecordingDescription(appName),
    prompt: stored?.prompt ?? result.prompt ?? "",
    response: result.response,
    ...(category ? { category } : {}),
  };
}

export function revealSchedule(
  transcript: TranscriptMessage[],
  durationMs: number,
): {
  schedule: Map<string, { start: number; end: number }>;
  revealScale: number;
} {
  const build = (scale: number) => {
    const slots = new Map<string, { start: number; end: number }>();
    let previousEnd = Number.NEGATIVE_INFINITY;
    for (const message of transcript) {
      const start = Math.max(message.atMs, previousEnd);
      const end =
        start +
        (message.role === "assistant"
          ? messageRevealMs(message.parts) * scale
          : 0);
      slots.set(message.id, { start, end });
      previousEnd = end;
    }
    return { slots, end: previousEnd };
  };
  const full = build(1);
  if (full.end <= durationMs) return { schedule: full.slots, revealScale: 1 };
  let low = 0;
  let high = 1;
  for (let i = 0; i < 24; i++) {
    const mid = (low + high) / 2;
    if (build(mid).end <= durationMs) low = mid;
    else high = mid;
  }
  return { schedule: build(low).slots, revealScale: low };
}

// ── Player geometry: the render region (chat card + app card) is the sizing
// anchor — its height comes from the screen, each card's width from its
// aspect, and the dialog shell shrink-wraps the result (see
// replayRegionLayout). The user's side-panel width never enters.
/**
 * Vertical chrome around the render region — the dialog header above it plus
 * the transport strip below. An estimate, not a measurement: it only tunes
 * how close the dialog's total height lands to the screen fraction, and the
 * dialog's max-height class still bounds the total.
 */
const REGION_CHROME_PX = 160;
/** Tallest the render region grows on large screens. */
const REGION_MAX_HEIGHT = 1060;
/** Shortest the render region shrinks to before the player stops scaling. */
const REGION_MIN_HEIGHT = 320;
/**
 * Bounds on the app card's width:height in the layout. A recording at a
 * pathological shape (an extremely tall sliver, an ultrawide inline capture)
 * gets a sane card and the stage contain-fits the recorded shape inside it.
 */
const STAGE_ASPECT_MIN = 1 / 3;
const STAGE_ASPECT_MAX = 2;

/**
 * The square "click to edit" chip that fades in over an editable surface — the
 * description, the replayed chat pane, and the AI prompt and response bubbles
 * all wear the same one. Quiet and bordered rather than a bright slab: it
 * hints at the click without covering the text it sits on. Each caller adds
 * its own size and the group-hover trigger for its group.
 */
const EDIT_HINT_CHIP =
  "pointer-events-none absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-md border border-border/50 bg-background/70 text-foreground opacity-0 shadow-sm transition-opacity";

/**
 * Idle gaps longer than this are compressed to this length in playback, so a
 * long wait on the chat — an LLM generating, a slow tool — time-lapses instead
 * of playing out in dead real time.
 *
 * This applies ONLY to stretches where the app did nothing at either end. The
 * app's own time is never compressed: the gap between two app events is the app
 * running, and replaying it faster than it happened is a false recording rather
 * than a time-lapse.
 */
const MAX_IDLE_MS = 900;
/**
 * How long the app can go without input before its time stops counting as a
 * session. Generous, so a pause for thought mid-game keeps playing at real
 * speed; short enough that one stray click during the build does not protect
 * the whole build from the time-lapse.
 */
const APP_ACTIVITY_BREAK_MS = 10_000;
/**
 * How long a filmed frame waits for the app frame to remount after a rewind.
 * Paid per frame, so it is the difference between an export that takes a minute
 * and one that takes half an hour — see the readiness gate in `ready()`.
 */
const FRAME_SETTLE_STEP_MS = 50;
const FRAME_SETTLE_TRIES = 60;
/**
 * How long the render's opening gate waits for the app to appear at all.
 * Longer than a per-frame settle: this one covers the frame's first ever load
 * (fetching, parsing and running the recorded HTML), not a remount.
 */
const APP_FRAME_READY_TRIES = 200;
/**
 * A lead-in before the first message so it types/streams in rather than opening
 * already sent — the whole session, pre-recording history included, replays as
 * one animated timeline.
 */
const PREROLL_MS = 1_200;

type ReplayActivity = { kind: "tool"; name: string } | null;

/** Imminent chat activity reconstructed from transcript timing. */
type ChatPending =
  | { kind: "thinking" }
  | { kind: "typing"; text: string }
  | { kind: "sending"; text: string }
  | null;

/**
 * Controls the surface hands the chat pane for the one-shot prompt bubble:
 * inline edit (a null draft means display mode), save/cancel, and regenerate.
 */
type PromptBubbleEditor = {
  draft: string | null;
  generating: boolean;
  saving: boolean;
  start: () => void;
  change: (text: string) => void;
  save: () => void;
  cancel: () => void;
  regenerate: () => void;
};

/**
 * Built-in player for recorded app demo sessions, styled to read like the real
 * Archestra chat: the recorded conversation replays on the left using the same
 * message/tool primitives as live chat, and a read-only app frame on the right
 * re-drives the captured input events against the recorded app-version
 * snapshots, answering the app's MCP calls from the recorded responses. Version
 * switches on the timeline remount the frame with that segment's HTML. The app
 * frame is isolated from real input — it only responds to the replayed events.
 */
export function AppSessionPlayer({
  conversationId,
  open,
  onOpenChange,
  filming = false,
}: {
  conversationId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Rendering a video off this player rather than showing it to someone: every
   * hover affordance stays down so nothing an operator would never see leaks
   * into an exported frame.
   */
  filming?: boolean;
}) {
  const { data: bundle } = useAppRecording(open ? conversationId : null);
  // The player replays only bundles that honor the shared recording contract —
  // schema-valid static data with an app version and a chat. An invalid bundle
  // gets an explanation instead of a broken replay.
  const validation = useMemo(
    () => (bundle ? validateRecordingBundle(bundle) : null),
    [bundle],
  );
  const validBundle = validation?.ok ? validation.bundle : null;
  const recording = useMemo<PlaybackRecording | null>(
    () =>
      validBundle
        ? {
            ...validBundle.recording,
            // Frame payloads leave base64 exactly once, here at bundle-open;
            // every path after this handles Blobs/bytes only.
            events: reviveRecordingEvents(validBundle.recording.events),
            // The replayed chat is the capture seen through the viewer's
            // presentation edits: the AI consolidation (unless disabled),
            // minus removed messages, with manual user-text overrides.
            transcript: presentedTranscript(
              validBundle.recording.transcript,
              validBundle.enhancement,
              validBundle.edits?.chat,
            ),
            originalTranscript: validBundle.recording.transcript,
            appName: validBundle.app.name,
            edits: validBundle.edits,
            enhancement: validBundle.enhancement,
          }
        : null,
    [validBundle],
  );
  const title = recording ? recording.appName : "Session replay";
  // Video export is rendered offline from the bundle, not filmed from this
  // screen: the button hands the edited recording to the renderer and saves
  // the file it returns.
  const renderVideo = useRenderAppRecordingVideo();
  // Survives closing and reopening the player mid-render.
  const rendering = useIsRenderingAppRecordingVideo();
  // Generation results land async; the description row's handlers must apply
  // them against the LATEST enhancement, not the snapshot captured when the
  // request went out (a prompt edited mid-flight would be clobbered).
  const enhancementRef = useRef<RecordingEnhancement | null>(null);
  enhancementRef.current = recording?.enhancement ?? null;

  // The editor (undo/redo history + cuts + AI enhancement) is owned here so its
  // controls can live in the player's top toolbar; the timeline cutter in the
  // surface below shares the same instance.
  const editor = useAppRecordingEditor(open ? conversationId : null);

  // First-open onboarding: the guided tour runs once per browser, then only
  // on demand via the header's help button. Decided synchronously so the
  // surface below mounts already knowing the tour is up — replay must not
  // auto-play behind it.
  const dialogRef = useRef<HTMLDivElement>(null);
  const [tourOpen, setTourOpen] = useState(
    () =>
      // Never while rendering a video: the renderer drives a fresh browser
      // every time, so "has not seen the tour" is always true there and the
      // tour would dim and cover every exported frame — and it holds playback,
      // so the replay would never advance either.
      !filming &&
      typeof window !== "undefined" &&
      !window.localStorage.getItem(PLAYER_TOUR_SEEN_KEY),
  );
  // The active stop's key while touring. Purely-derived DEMO state hangs off
  // it (the chat editor shown, the AI toggle forced off) — never real editor
  // state — so closing the tour in any way lands back exactly where the
  // editor was before the tour started.
  const [tourStepKey, setTourStepKey] = useState<string | null>(null);
  // Editing the description (in this header) must pause and lock playback
  // down in the surface, exactly like editing the chat or the timeline.
  const [descriptionEditing, setDescriptionEditing] = useState(false);
  // Editing owns playback, and a filmed replay IS playback — so an export can
  // only start once every editor below is closed.
  const [surfaceEditing, setSurfaceEditing] = useState(false);
  // The length of the cut as it would be exported. Every frame costs the same
  // to render, so this IS the export's cost — and past a point the render
  // outlives the author's patience and anything willing to carry the request.
  // The button refuses rather than starting one, and the tour asks for a short
  // cut in the first place so this is a backstop and not a surprise.
  const finalCutMs = useMemo(
    () => (recording ? buildPlayback(recording).duration : 0),
    [recording],
  );
  const tooLongToExport = finalCutMs > APP_RECORDING_MAX_EXPORT_MS;
  const exportBlocked = descriptionEditing || surfaceEditing || tooLongToExport;

  // The quick action behind the tooltip pills (and the timeline's limit
  // mark): one click shortens the current edit — mid cuts, trims and all —
  // from the END of the edited cut down to exactly the allowed length, as
  // one undoable step.
  const trimToExportLimit = useCallback(() => {
    if (!recording) return;
    const next = trimCutsToExportLimit(recording, APP_RECORDING_MAX_EXPORT_MS);
    if (!next) return;
    editor.applyEdits({ cuts: next, chat: recording.edits?.chat });
  }, [recording, editor]);
  // The over-length tooltips end with the fix, not just the diagnosis.
  // Quietly: an invitation to trim, not an alarm — neutral until hovered.
  const trimPill = (
    <button
      type="button"
      className="mt-1.5 flex w-fit items-center gap-1 rounded-full border bg-background px-2 py-0.5 font-medium text-foreground transition-colors hover:border-destructive/50 hover:text-destructive"
      // A tooltip dismisses on pointerdown — its content unmounts before a
      // click can complete inside it — so the action fires on pointerdown
      // alone. (Not also on click: the pair double-commits, because the
      // second call still sees the pre-trim recording and stacks a duplicate
      // undo step.) Keyboard users have the same action on the timeline's
      // limit mark, a real button.
      onPointerDown={trimToExportLimit}
    >
      <Scissors className="size-3" />
      Trim to {MAX_EXPORT_SECONDS}s
    </button>
  );

  const closeTour = useCallback(() => {
    localStorage.setItem(PLAYER_TOUR_SEEN_KEY, "1");
    localStorage.removeItem(PLAYER_TOUR_STEP_KEY);
    setTourOpen(false);
  }, []);

  // Conventional history keys while the player is open: Ctrl/Cmd+Z undoes,
  // Ctrl/Cmd+Shift+Z redoes. Text fields keep their own native undo.
  const { undo, redo, canUndo, canRedo, isSaving } = editor;
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "z")
        return;
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      ) {
        return;
      }
      event.preventDefault();
      if (isSaving) return;
      if (event.shiftKey) {
        if (canRedo) redo();
      } else if (canUndo) {
        undo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, undo, redo, canUndo, canRedo, isSaving]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        // `border-0`: the dialog's default hairline is a light-on-dark token,
        // and this player is full-bleed — the app stage meets the dialog's
        // right and bottom edges with nothing in between, so that hairline
        // lands directly against the app and reads as a stray light border
        // around it rather than as the dialog's own edge. The overlay and
        // shadow already separate the player from the page behind it.
        // `w-fit`: the dialog shrink-wraps the render region — the chat and
        // app cards' explicit widths are the only intrinsic contribution (the
        // header and transport are `w-0 min-w-full`, so a long title can't
        // drive the shell wide) — which keeps the player's shape a property
        // of the recording, not of the viewer's screen width.
        className="flex max-h-[94vh] w-fit max-w-[96vw] flex-col gap-0 overflow-hidden border-0 p-0"
        // The player is an immersive surface: the page behind it drops to the
        // same dim the tour's spotlight uses, so the replay is the one lit
        // thing on screen — and when the tour IS up, its in-dialog scrim and
        // this backdrop read as one uninterrupted dim across the whole page.
        overlayClassName="bg-black/85"
        // The close control lives in the header's own button cluster so every
        // header action shares one size, style, and baseline — the floating
        // default X can't align with an in-flow row.
        showCloseButton={false}
        // Opening must not auto-focus the first header button (its tooltip
        // would pop over a freshly opened player); the player's keyboard
        // controls are window-level, so nothing needs initial focus.
        onOpenAutoFocus={(event) => event.preventDefault()}
        // Escape pressed inside an inline editor (the description input, the
        // prompt textarea) cancels that edit — it must not also close the
        // player. Radix's dismiss listener runs at document capture, before
        // any field's own handler, so the guard has to live here.
        onEscapeKeyDown={(event) => {
          // An open tour swallows the first Escape; the player stays up.
          if (tourOpen) {
            event.preventDefault();
            closeTour();
            return;
          }
          const target = event.target as HTMLElement | null;
          if (
            target &&
            (target.tagName === "INPUT" ||
              target.tagName === "TEXTAREA" ||
              target.isContentEditable)
          ) {
            event.preventDefault();
          }
        }}
        ref={dialogRef}
      >
        <DialogDescription className="sr-only">
          Read-only replay of a recorded app session.
        </DialogDescription>
        {/* `w-0 min-w-full`: span the shrink-wrapped dialog without
            contributing intrinsic width — the render region alone sets it. */}
        <DialogHeader className="w-0 min-w-full flex-row items-start gap-3 space-y-0 border-b px-4 py-4">
          <AppWindow className="mt-px size-4 shrink-0 text-muted-foreground" />
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <DialogTitle className="truncate">{title}</DialogTitle>
            {recording && (
              <ReplayDescriptionRow
                conversationId={conversationId}
                appName={recording.appName}
                enhancement={recording.enhancement ?? null}
                saving={editor.isSaving}
                showEditHint={tourOpen && tourStepKey === "description"}
                onEditingChange={setDescriptionEditing}
                onSave={(description) =>
                  editor.applyEnhancement({
                    description,
                    prompt: enhancementRef.current?.prompt ?? "",
                    response: enhancementRef.current?.response,
                    category: enhancementRef.current?.category,
                  })
                }
                onRegenerated={(result) => {
                  const backfilled = backfilledEnhancement(
                    enhancementRef.current,
                    result,
                    recording.appName,
                  );
                  if (backfilled) editor.applyEnhancement(backfilled);
                }}
              />
            )}
          </div>
          <TooltipProvider delayDuration={200}>
            {/* One control cluster, one rhythm: every header action — history,
                download, close — is the same size-7 ghost button with a size-4
                icon and a tooltip. Nudged up so the row centers on the title
                line. */}
            <div className="-my-1 flex shrink-0 items-center gap-1">
              {recording && (
                <>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="inline-flex" data-tour="history">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="size-7"
                          aria-label="Undo edit"
                          disabled={!editor.canUndo || editor.isSaving}
                          onClick={editor.undo}
                        >
                          <Undo2 className="size-4" />
                        </Button>
                      </span>
                    </TooltipTrigger>
                    <TooltipContent>Undo</TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="inline-flex">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="size-7"
                          aria-label="Redo edit"
                          disabled={!editor.canRedo || editor.isSaving}
                          onClick={editor.redo}
                        >
                          <Redo2 className="size-4" />
                        </Button>
                      </span>
                    </TooltipTrigger>
                    <TooltipContent>Redo</TooltipContent>
                  </Tooltip>

                  <span
                    className="mx-1 h-4 w-px bg-border"
                    aria-hidden="true"
                  />

                  <Tooltip>
                    {/* The wrapper is what makes the blocked case explain
                        itself: a disabled button fires no pointer events, so
                        the tooltip below — the only thing that says WHY the
                        export is unavailable — never opened on the one button
                        that needed it. Same span the play and replay buttons
                        use. */}
                    <TooltipTrigger asChild>
                      <span className="inline-flex">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="group size-7 text-muted-foreground hover:text-foreground"
                          aria-label={
                            rendering
                              ? "Cancel preparing the video"
                              : "Download a video of this session"
                          }
                          data-tour="download"
                          // Live while rendering — this is the way back out of
                          // a render started by mistake, and the spinner is
                          // where the author looks for it.
                          disabled={!rendering && exportBlocked}
                          onClick={() => {
                            if (rendering) {
                              cancelAppRecordingVideoRender();
                              return;
                            }
                            if (!recording) return;
                            renderVideo.mutate({ conversationId, title });
                          }}
                        >
                          {rendering ? (
                            <>
                              <Loader
                                size={14}
                                className="group-hover:hidden"
                              />
                              <X className="hidden size-4 group-hover:block" />
                            </>
                          ) : (
                            <DownloadIcon className="size-4" />
                          )}
                        </Button>
                      </span>
                    </TooltipTrigger>
                    <TooltipContent className="max-w-[260px] text-xs">
                      {rendering ? (
                        "Preparing your video — click to cancel."
                      ) : tooLongToExport ? (
                        <>
                          This cut runs {formatMs(finalCutMs)}. Trim it to{" "}
                          {MAX_EXPORT_SECONDS} seconds or less to export a
                          video.
                          {trimPill}
                        </>
                      ) : descriptionEditing || surfaceEditing ? (
                        "Finish editing to export a video."
                      ) : (
                        "Downloads a video of this session with your edits applied. Takes up to a minute."
                      )}
                    </TooltipContent>
                  </Tooltip>

                  {/* Renders nothing unless the deployment offers the gallery.
                      Blocked exactly like the download — mid-edit AND over the
                      export length cap: the gallery renders the submitted cut
                      to video downstream, so the same 30-second bound applies. */}
                  <AppGalleryShareButton
                    conversationId={conversationId}
                    disabled={exportBlocked}
                    disabledReason={
                      tooLongToExport ? (
                        <>
                          This cut runs {formatMs(finalCutMs)}. Trim it to{" "}
                          {MAX_EXPORT_SECONDS} seconds or less to submit.
                          {trimPill}
                        </>
                      ) : (
                        "Finish editing to submit."
                      )
                    }
                  />

                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="size-7 text-muted-foreground hover:text-foreground"
                        aria-label="Show the player tour"
                        data-tour="tour"
                        onClick={() => setTourOpen(true)}
                      >
                        <HelpCircle className="size-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      Learn how to use the session recording editor
                    </TooltipContent>
                  </Tooltip>

                  <span
                    className="mx-1 h-4 w-px bg-border"
                    aria-hidden="true"
                  />
                </>
              )}
              <Tooltip>
                <TooltipTrigger asChild>
                  <DialogClose asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-7 text-muted-foreground hover:text-foreground"
                      aria-label="Close player"
                    >
                      <X className="size-4" />
                    </Button>
                  </DialogClose>
                </TooltipTrigger>
                <TooltipContent>Close</TooltipContent>
              </Tooltip>
            </div>
          </TooltipProvider>
        </DialogHeader>
        {recording ? (
          <PlayerSurface
            key={conversationId}
            conversationId={conversationId}
            recording={recording}
            editor={editor}
            tourActive={tourOpen}
            tourStepKey={tourOpen ? tourStepKey : null}
            descriptionEditing={descriptionEditing}
            filming={filming}
            onEditingChange={setSurfaceEditing}
          />
        ) : validation && !validation.ok ? (
          // The shrink-wrapped dialog has no size of its own, so the
          // placeholder states bring their own.
          <div className="flex min-h-[40vh] min-w-[560px] flex-1 items-center justify-center px-8 text-center text-sm text-muted-foreground">
            This recording can't be replayed. {validation.reason}
          </div>
        ) : (
          <div className="flex min-h-[40vh] min-w-[560px] flex-1 items-center justify-center text-sm text-muted-foreground">
            Loading recording…
          </div>
        )}
        {tourOpen && recording && (
          <PlayerTour
            containerRef={dialogRef}
            onClose={closeTour}
            onStepKeyChange={setTourStepKey}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function PlayerSurface({
  conversationId,
  recording,
  editor,
  tourActive,
  tourStepKey,
  descriptionEditing,
  filming,
  onEditingChange,
}: {
  /** Rendering a video: hold every hover affordance down. */
  filming: boolean;
  /** Reports this surface's editors so the toolbar can gate the export. */
  onEditingChange: (editing: boolean) => void;
  conversationId: string;
  recording: PlaybackRecording;
  editor: ReturnType<typeof useAppRecordingEditor>;
  /** The guided tour is up — playback must not run (or start) behind it. */
  tourActive: boolean;
  /**
   * The tour's active stop. The chat-editor stops render their subject as a
   * DEMO — the pane shows and the AI toggle flips visually off — derived
   * purely from this key, never by touching real editor state, so any tour
   * exit reverts everything by construction.
   */
  tourStepKey: string | null;
  /** The header's description editor is open. */
  descriptionEditing: boolean;
}) {
  // Playback is the recording with idle gaps compressed (time-lapse). Every
  // clock, event, segment and transcript offset below is on this compressed
  // timeline.
  const playback = useMemo(() => buildPlayback(recording), [recording]);
  const events = useMemo(
    () => [...playback.events].sort((a, b) => a.t - b.t),
    [playback],
  );
  const segments = playback.segments;
  const transcript = playback.transcript;
  const duration = Math.max(playback.duration, 1);

  // Auto-play the moment the frame is ready (see the frame-ready gate below)
  // — unless the guided tour opened with the player, which trumps auto-play.
  const [playState, setPlayState] = useState<"paused" | "playing" | "ended">(
    // Filming never auto-plays: the renderer owns the clock and steps it frame
    // by frame. A clock advancing on its own races ahead of those steps, which
    // makes every forward step look like a rewind to `seekTo` — remounting the
    // app frame on each one, so the export both flickers and crawls.
    tourActive || filming ? "paused" : "playing",
  );
  // The tour can also open mid-playback (the header's help button): pause,
  // and stay paused when it closes — resuming is the viewer's call.
  useEffect(() => {
    if (tourActive) {
      setPlayState((state) => (state === "playing" ? "paused" : state));
    }
  }, [tourActive]);
  const [displayClock, setDisplayClock] = useState(0);
  const [segmentIndex, setSegmentIndex] = useState(0);
  const [runNonce, setRunNonce] = useState(0);
  // The app renders for the whole replay at the recorded viewport it was used
  // at — the size that carried the actual interaction, not merely the one left
  // on screen the longest (see dominantViewport) — uniformly scaled into the
  // stage. Laying it out at its recorded size in both dimensions means pointer
  // coordinates map 1:1 (the visual scale doesn't touch the frame's coordinate
  // space) and a viewport-sized surface (a game, a WebGL canvas) keeps its
  // recorded shape instead of reflowing to the stage's.
  const viewport = useMemo(() => dominantViewport(events), [events]);
  // The region's two format cards — chat at the canonical recording aspect,
  // app at the recorded one — sized from the screen height alone.
  const layout = useReplayRegionLayout(viewport);
  // False while the (re)mounted app frame's SDK hasn't connected yet — the
  // clock and event dispatch hold until it does, so no event is lost to a
  // frame whose replay listener isn't attached (fresh play, restart, seek, or
  // a mid-timeline version switch that remounts the frame).
  const [frameReady, setFrameReady] = useState(false);
  /**
   * Bumped per replay-frame announcement. The sandbox can navigate its inner
   * document more than once while settling, and each document announces for
   * itself — every announcement gets its own full catch-up delivery, so the
   * document that ends up on screen has everything regardless of how many
   * came before it.
   */
  const [frameReadyNonce, setFrameReadyNonce] = useState(0);
  /** Pending ready-fallback for a stale cached SDK without the announcement. */
  const legacyReadyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

  const clockRef = useRef(0);
  const appliedRef = useRef(0);
  const segmentIndexRef = useRef(0);
  segmentIndexRef.current = segmentIndex;
  const iframeElRef = useRef<HTMLIFrameElement | null>(null);
  /** `frameReady` for non-reactive readers: seeks and the filming driver. */
  const frameReadyRef = useRef(frameReady);
  frameReadyRef.current = frameReady;

  // A remount (version switch, restart, or seek) makes the frame not-ready
  // until its SDK reconnects. The deps ARE the remount triggers even though the
  // body only resets the flag.
  // biome-ignore lint/correctness/useExhaustiveDependencies: segmentIndex/runNonce are the intended re-run triggers
  useEffect(() => {
    setFrameReady(false);
    if (legacyReadyTimerRef.current) {
      clearTimeout(legacyReadyTimerRef.current);
      legacyReadyTimerRef.current = null;
    }
  }, [segmentIndex, runNonce]);

  // Which recorded version segment is visible at a given clock time, by the
  // segment's own `atMs` — independent of the `segment` marker events (which a
  // very long recording could drop at the event cap), so a version switch is
  // never stranded.
  const segmentIndexForClock = useCallback(
    (clock: number) => {
      let target = 0;
      for (let i = 0; i < segments.length; i++) {
        if (segments[i].atMs <= clock) target = i;
        else break;
      }
      return target;
    },
    [segments],
  );

  // The recorded MCP exchanges, consumed in order as the replayed app re-makes
  // its calls. Reset alongside restart/seek so a rerun replays the same answers.
  const mcpLogRef = useRef<(McpTimelineEvent & { used: boolean })[]>([]);
  const resetMcpLog = useCallback(() => {
    mcpLogRef.current = events
      .filter((event): event is McpTimelineEvent => event.kind === "mcp")
      .map((event) => ({ ...event, used: false }));
  }, [events]);
  useEffect(() => {
    resetMcpLog();
  }, [resetMcpLog]);

  // ── Editing on the FULL (uncut) timeline. The single timeline strip shows
  // the whole session with removed regions shaded and draggable, Loom-style,
  // while playback itself runs on the cut timeline (skipped stretches simply
  // don't exist there). Base timeline = the same compression with no cuts
  // applied; cuts are stored in raw time, so both spaces convert through it.
  const basePlayback = useMemo(
    () => buildPlayback(uncutRecording(recording)),
    [recording],
  );
  const baseDuration = Math.max(basePlayback.duration, 1);
  // The raw extent of the timeline, lead-in included: raw time is the space
  // cuts are stored in (stable across player versions), so trim-vs-mid
  // classification happens there too. `rawStart` sits PREROLL_MS below the
  // earliest content — the synthetic lead has real, cuttable coordinates.
  const rawStart = Math.round(basePlayback.toRawMs(0));
  const rawEnd = Math.round(basePlayback.toRawMs(baseDuration));
  const chatEdits = recording.edits?.chat;
  const storedCuts = useMemo(
    () => recording.edits?.cuts ?? [],
    [recording.edits?.cuts],
  );
  // A committed edit round-trips through the recording store before the new
  // cuts flow back in as props; rendering the committed list optimistically
  // bridges that gap, so a released handle never blinks back to its pre-drag
  // position. Cleared the moment the store catches up.
  const [pendingCuts, setPendingCuts] = useState<typeof storedCuts | null>(
    null,
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: storedCuts is the intended reset trigger
  useEffect(() => {
    setPendingCuts(null);
  }, [storedCuts]);
  const cuts = pendingCuts ?? storedCuts;
  const baseCuts = useMemo(
    () =>
      cuts.map((cut) => ({
        fromMs: basePlayback.toPlaybackMs(cut.fromMs),
        toMs: basePlayback.toPlaybackMs(cut.toMs),
        kind: classifyCut(cut, rawStart, rawEnd),
      })),
    [cuts, basePlayback, rawStart, rawEnd],
  );
  const { applyEdits } = editor;
  const cutBaseRange = useCallback(
    (range: { fromMs: number; toMs: number }) => {
      // Store cuts in RAW timeline time (lead-in included) — stable across
      // player versions.
      const fromMs = Math.round(basePlayback.toRawMs(range.fromMs));
      const toMs = Math.round(basePlayback.toRawMs(range.toMs));
      if (toMs - fromMs < 1) return;
      const next = [...cuts, { fromMs, toMs }];
      setPendingCuts(next);
      applyEdits({ cuts: next, chat: chatEdits });
    },
    [basePlayback, cuts, chatEdits, applyEdits],
  );
  const resizeCutBase = useCallback(
    (index: number, range: { fromMs: number; toMs: number }) => {
      const fromMs = Math.round(basePlayback.toRawMs(range.fromMs));
      const toMs = Math.round(basePlayback.toRawMs(range.toMs));
      if (toMs - fromMs < 1) return;
      const next = cuts.map((cut, i) => (i === index ? { fromMs, toMs } : cut));
      setPendingCuts(next);
      applyEdits({ cuts: next, chat: chatEdits });
    },
    [basePlayback, cuts, chatEdits, applyEdits],
  );
  const restoreCut = useCallback(
    (index: number) => {
      const next = cuts.filter((_, i) => i !== index);
      setPendingCuts(next);
      applyEdits({ cuts: next, chat: chatEdits });
    },
    [cuts, chatEdits, applyEdits],
  );
  // Trimming is dragging the timeline's own ends: the head/tail becomes an
  // edge-touching cut (same storage, same undo), no explicit Cut press. A
  // boundary dragged back to the edge removes the trim again. Mid cuts fully
  // swallowed by a new trim are dropped so the stored list stays clean.
  const trimBase = useCallback(
    (edge: "start" | "end", boundaryMs: number) => {
      const kept = cuts.filter((cut, i) => {
        const base = baseCuts[i];
        if (!base) return true;
        const kind = classifyCut(cut, rawStart, rawEnd);
        return edge === "start"
          ? !(kind === "start" || base.toMs <= boundaryMs)
          : !(kind === "end" || base.fromMs >= boundaryMs);
      });
      const keptStartRaw = kept
        .filter((cut) => classifyCut(cut, rawStart, rawEnd) === "start")
        .reduce((max, cut) => Math.max(max, cut.toMs), rawStart);
      const keptEndRaw = kept
        .filter((cut) => classifyCut(cut, rawStart, rawEnd) === "end")
        .reduce((min, cut) => Math.min(min, cut.fromMs), rawEnd);
      const next = [...kept];
      // Any nonzero boundary is a trim (however small — same as a mid cut);
      // dragged fully back to the timeline's edge, no cut is pushed and the
      // trim is thereby restored.
      if (edge === "start" && boundaryMs > 0) {
        const toRaw = Math.round(basePlayback.toRawMs(boundaryMs));
        // A boundary at or past the kept tail would swallow the whole
        // session — refuse. (Raw time covers the lead-in, so a boundary
        // inside the opening beat trims exactly that much of it.)
        if (toRaw >= keptEndRaw) return;
        if (toRaw - rawStart >= 1) next.push({ fromMs: rawStart, toMs: toRaw });
      }
      if (edge === "end" && boundaryMs < baseDuration) {
        const fromRaw = Math.round(basePlayback.toRawMs(boundaryMs));
        // The trim's start must sit strictly inside the kept stretch, or the
        // "cut" would swallow the entire session — refuse.
        if (fromRaw <= keptStartRaw) return;
        if (rawEnd - fromRaw >= 1) next.push({ fromMs: fromRaw, toMs: rawEnd });
      }
      // A no-move release must not spend an undo step.
      if (JSON.stringify(next) === JSON.stringify(cuts)) return;
      setPendingCuts(next);
      applyEdits({ cuts: next, chat: chatEdits });
    },
    [
      basePlayback,
      cuts,
      baseCuts,
      chatEdits,
      rawStart,
      rawEnd,
      baseDuration,
      applyEdits,
    ],
  );
  // The timeline's export-limit mark: where played time crosses the allowed
  // length on the FULL strip, and the one-click trim down to it. Committed
  // with the same optimistic-cuts bridge every other timeline edit uses.
  const exportLimitBaseMs =
    duration > APP_RECORDING_MAX_EXPORT_MS
      ? basePlayback.toPlaybackMs(playback.toRawMs(APP_RECORDING_MAX_EXPORT_MS))
      : null;
  const trimToExportLimit = useCallback(() => {
    const next = trimCutsToExportLimit(recording, APP_RECORDING_MAX_EXPORT_MS);
    if (!next) return;
    setPendingCuts(next);
    applyEdits({ cuts: next, chat: chatEdits });
  }, [recording, applyEdits, chatEdits]);

  // ── Chat edits: presentation-only operations over the captured transcript
  // (drop a message, override a user message's text, hide the AI-enhanced
  // consolidation), committed through the same undoable history as cuts.
  const [chatEditing, setChatEditing] = useState(false);
  const [timelineEditing, setTimelineEditing] = useState(false);
  // The one-shot prompt's and closing response's inline drafts (null = display
  // mode); declared here because the play-lock below depends on them.
  const [promptDraft, setPromptDraft] = useState<string | null>(null);
  const [responseDraft, setResponseDraft] = useState<string | null>(null);
  const commitChatEdits = useCallback(
    (change: Partial<RecordingChatEdits>) => {
      applyEdits({ cuts, chat: { ...chatEdits, ...change } });
    },
    [applyEdits, cuts, chatEdits],
  );
  const toggleEnhancementDisabled = useCallback(() => {
    commitChatEdits({ enhancementDisabled: !chatEdits?.enhancementDisabled });
  }, [commitChatEdits, chatEdits?.enhancementDisabled]);
  // Removals address whole messages OR single parts of one (an agent turn's
  // prose bubble, one tool row), so both take a list of ids and land as one
  // undoable step.
  const removeChatMessage = useCallback(
    (ids: string[]) => {
      commitChatEdits({
        removedMessageIds: [
          ...new Set([...(chatEdits?.removedMessageIds ?? []), ...ids]),
        ],
      });
    },
    [commitChatEdits, chatEdits?.removedMessageIds],
  );
  const restoreChatMessage = useCallback(
    (ids: string[]) => {
      const dropped = new Set(ids);
      commitChatEdits({
        removedMessageIds: (chatEdits?.removedMessageIds ?? []).filter(
          (removed) => !dropped.has(removed),
        ),
      });
    },
    [commitChatEdits, chatEdits?.removedMessageIds],
  );
  // The playhead's position on the full timeline. Raw time covers the whole
  // axis, lead-in included, so one round-trip places every playback moment.
  // A cut's collapse instant maps to BOTH sides of its gap, so a seek aimed
  // at the strip also remembers where it was aimed: until the clock moves on,
  // the playhead sits under the clicked point (say, a section's end handle),
  // not at the mapping's pick of the gap's far side.
  const seekIntentRef = useRef<{ baseMs: number; clock: number } | null>(null);
  const seekIntent = seekIntentRef.current;
  const playheadBaseMs =
    seekIntent && seekIntent.clock === displayClock
      ? seekIntent.baseMs
      : basePlayback.toPlaybackMs(playback.toRawMs(displayClock));

  // A drag-scrub's not-yet-performed rewind (see scrubBase): the latest point
  // the cursor asked for, waiting out the rewind throttle.
  const scrubRewindRef = useRef<{
    timer: ReturnType<typeof setTimeout> | null;
    pendingClock: number | null;
    lastAt: number;
  }>({ timer: null, pendingClock: null, lastAt: 0 });
  const cancelPendingScrub = useCallback(() => {
    const scrub = scrubRewindRef.current;
    if (scrub.timer !== null) clearTimeout(scrub.timer);
    scrub.timer = null;
    scrub.pendingClock = null;
  }, []);
  useEffect(() => cancelPendingScrub, [cancelPendingScrub]);

  // An edit retimes the whole playback, so the applied-event cursor and MCP log
  // are positionally invalid for the new event list: restart the run from a
  // clean, paused frame whenever the playback identity changes after mount.
  // The author's PLACE survives the restart: raw time is stable across edits,
  // so their point maps into the new playback exactly — through a Cut the
  // playhead visibly stays where the selection was released (the cut's
  // collapse instant) instead of snapping to the start, and it holds there
  // until playback resumes or the timeline is clicked anew.
  const playbackRef = useRef(playback);
  useEffect(() => {
    if (playbackRef.current === playback) return;
    const rawMs = playbackRef.current.toRawMs(clockRef.current);
    playbackRef.current = playback;
    cancelPendingScrub();
    const clock = Math.max(
      0,
      Math.min(playback.toPlaybackMs(rawMs), playback.duration),
    );
    const seg = segmentIndexForClock(clock);
    const segStart = segments[seg]?.atMs ?? 0;
    let idx = 0;
    while (idx < events.length && events[idx].t < segStart) idx++;
    clockRef.current = clock;
    appliedRef.current = idx;
    resetMcpLog();
    // Pin the playhead to the base-time spot it occupied, not to the far side
    // of a collapse gap the raw round-trip would pick (see seekIntentRef).
    seekIntentRef.current = { baseMs: basePlayback.toPlaybackMs(rawMs), clock };
    setDisplayClock(clock);
    segmentIndexRef.current = seg;
    setSegmentIndex(seg);
    setRunNonce((nonce) => nonce + 1);
    setPlayState("paused");
  }, [
    playback,
    basePlayback,
    segments,
    events,
    segmentIndexForClock,
    resetMcpLog,
    cancelPendingScrub,
  ]);

  // The replay owns the app's clock. The app's timers and animation frames fire
  // against this rather than the wall, so it advances exactly as far as the
  // replay has — and no further. Without it the app free-runs at its own pace
  // and a recorded keypress lands on a state the app was never in when that key
  // was pressed, which is how a replayed game plays a different game. It is
  // also what makes an export reproducible: the renderer steps this clock frame
  // by frame, far slower than real time, and the app steps with it.
  const sendAppClock = useCallback((clock: number) => {
    iframeElRef.current?.contentWindow?.postMessage(
      { type: REPLAY_CONTROL_TYPE, action: "clock", t: Math.max(0, clock) },
      "*",
    );
  }, []);

  /**
   * Put every canvas back to the state the clock says it is in.
   *
   * A canvas is state, not an event: what it shows is the last frame drawn to
   * it, and a fresh one shows nothing at all. Replaying only the frames inside
   * some unapplied range leaves it blank in two ordinary cases — at the very
   * start, because the first sample lands a few milliseconds after recording
   * begins and so sits just past a clock of zero; and after any remount, where
   * the element is new but the applied cursor has long since moved past its
   * frames. Both showed as a black screen with the app's markup around it.
   */
  const primeCanvases = useCallback(
    (clock: number) => {
      const paint = (event: PaintDispatch) => {
        iframeElRef.current?.contentWindow?.postMessage(
          { type: REPLAY_CONTROL_TYPE, action: "paint", event },
          "*",
        );
      };
      const latest = new Map<string, TimelineEvent>();
      // Encoded streams whose first keyframe the clock hasn't reached yet:
      // their poster is the stream's opening config + first keyframe — before
      // the first frame the app looked like its first frame, never like an
      // empty canvas. Streams the clock is inside were already fed by the
      // catch-up walk (which re-sends the config and decodes from the last
      // keyframe), so re-posting them here would only decode the span twice.
      const posters = new Map<
        string,
        { config: TimelineEvent; key: TimelineEvent | null; reached: boolean }
      >();
      for (const event of events) {
        if (event.kind === "canvas") {
          // The newest frame this clock has reached, or failing that the
          // oldest there is.
          if (event.t <= clock || !latest.has(event.sel))
            latest.set(event.sel, event);
        } else if (event.kind === "video-config") {
          if (!posters.has(event.sel))
            posters.set(event.sel, {
              config: event,
              key: null,
              reached: false,
            });
        } else if (event.kind === "video-chunk" && event.type === "key") {
          const poster = posters.get(event.sel);
          if (!poster) continue;
          if (event.t <= clock) poster.reached = true;
          else if (!poster.key) poster.key = event;
        }
      }
      for (const event of latest.values()) paint(event);
      for (const [sel, poster] of posters) {
        if (poster.reached || !poster.key) continue;
        paint(poster.config);
        paint(poster.key);
        // A lone keyframe sits inside the decoder until flushed out.
        paint({ kind: "video-flush", sel });
      }
    },
    [events],
  );

  const applyEventsUpTo = useCallback(
    (clock: number) => {
      sendAppClock(clock);
      // Frame paints (stills and encoded-video events) are collected over the
      // advanced range and flushed through `planPaintFlush` after the walk: a
      // deep catch-up (a seek, a remount) spans hundreds of frames, and the
      // plan reduces them to what actually needs decoding — the newest still
      // per canvas, and for a video stream its config plus the span from the
      // last keyframe. During normal playback the range is a frame or two
      // wide and the plan passes it through. Flushing after the loop also
      // lands the survivors on the range's final DOM.
      const paints: TimelineEvent[] = [];
      while (
        appliedRef.current < events.length &&
        events[appliedRef.current].t <= clock
      ) {
        const event = events[appliedRef.current++];
        if (
          event.kind === "canvas" ||
          event.kind === "video-config" ||
          event.kind === "video-chunk"
        ) {
          paints.push(event);
        } else if (event.kind === "dom") {
          // What the app produced, put back exactly. The replayed document runs
          // none of the app's own code, so these are not corrections applied
          // over a live app — they ARE the app, played back.
          iframeElRef.current?.contentWindow?.postMessage(
            { type: REPLAY_CONTROL_TYPE, action: "paint", event },
            "*",
          );
        } else if (
          event.kind === "viewport" ||
          event.kind === "mcp" ||
          event.kind === "segment"
        ) {
          // viewport: the stage is fixed to the dominant size (see `viewport`);
          // mcp/segment are handled host-side (mocks, segment switching).
        } else {
          // pointer / key / input / scroll — re-driven inside the app frame by
          // the injected SDK's replay driver (which also paints the cursor).
          // The app is laid out at its recorded viewport (the stage scales it
          // visually, which doesn't touch the frame's coordinate space), so
          // coordinates replay 1:1; each pointer event's target anchor lets the
          // SDK self-correct if the layout ever drifts from the recording.
          iframeElRef.current?.contentWindow?.postMessage(
            { type: REPLAY_CONTROL_TYPE, action: "apply", event },
            "*",
          );
        }
      }
      for (const event of planPaintFlush(paints)) {
        iframeElRef.current?.contentWindow?.postMessage(
          { type: REPLAY_CONTROL_TYPE, action: "paint", event },
          "*",
        );
      }
    },
    [events, sendAppClock],
  );

  // When a (re)mounted frame becomes ready, sync it to the current clock: apply
  // every event from the applied cursor up to `clock`, so a fresh play,
  // restart, seek, or version switch lands the app at the right state even
  // while paused.
  /**
   * A replay document announced its listener is live: reset the applied
   * cursor to its segment's start and deliver everything up to the clock
   * (the catch-up effect below). Runs once per announcing document.
   */
  const armReplayFrame = useCallback(() => {
    if (legacyReadyTimerRef.current) {
      clearTimeout(legacyReadyTimerRef.current);
      legacyReadyTimerRef.current = null;
    }
    const segStart = segments[segmentIndexRef.current]?.atMs ?? 0;
    let idx = 0;
    while (idx < events.length && events[idx].t < segStart) idx++;
    appliedRef.current = idx;
    setFrameReady(true);
    setFrameReadyNonce((nonce) => nonce + 1);
  }, [segments, events]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: frameReadyNonce re-delivers to each announcing document
  useEffect(() => {
    if (!frameReady) return;
    applyEventsUpTo(clockRef.current);
    primeCanvases(clockRef.current);
    setDisplayClock(clockRef.current);
  }, [frameReady, frameReadyNonce, applyEventsUpTo, primeCanvases]);

  // Freeze the app frame when the replay is paused: the injected SDK halts the
  // app's own animations and timers so nothing keeps moving inside the frame.
  // Re-sent on frame-ready so a fresh frame adopts the current play state.
  useEffect(() => {
    if (!frameReady) return;
    iframeElRef.current?.contentWindow?.postMessage(
      {
        type: REPLAY_CONTROL_TYPE,
        action: playState === "playing" ? "resume" : "pause",
      },
      "*",
    );
  }, [playState, frameReady]);

  useEffect(() => {
    // Hold the clock until the current app frame's SDK has connected, so events
    // aren't posted into a frame that can't yet receive them.
    if (playState !== "playing" || !frameReady) return;
    let raf = 0;
    let last = performance.now();
    let lastDisplay = 0;
    const tick = (now: number) => {
      clockRef.current = Math.min(clockRef.current + (now - last), duration);
      last = now;
      // Switch to the version segment this clock time belongs to before
      // applying its events. A switch remounts the frame (frameReady → false),
      // which pauses this loop until the new frame's SDK connects.
      const targetSegment = segmentIndexForClock(clockRef.current);
      if (targetSegment !== segmentIndexRef.current) {
        segmentIndexRef.current = targetSegment;
        setSegmentIndex(targetSegment);
        setDisplayClock(clockRef.current);
        return;
      }
      applyEventsUpTo(clockRef.current);
      if (now - lastDisplay > DISPLAY_CLOCK_INTERVAL_MS) {
        setDisplayClock(clockRef.current);
        lastDisplay = now;
      }
      if (clockRef.current >= duration) {
        setDisplayClock(duration);
        setPlayState("ended");
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playState, frameReady, duration, applyEventsUpTo, segmentIndexForClock]);

  const restart = useCallback(() => {
    cancelPendingScrub();
    clockRef.current = 0;
    appliedRef.current = 0;
    resetMcpLog();
    setDisplayClock(0);
    segmentIndexRef.current = 0;
    setSegmentIndex(0);
    // remount the app frame so the demo restarts from a fresh app instance
    setRunNonce((nonce) => nonce + 1);
    setPlayState("playing");
  }, [resetMcpLog, cancelPendingScrub]);

  // Editing anything — the description, the chat, the one-shot prompt, or a
  // timeline selection — owns the moment: the replay pauses and the play
  // controls lock until the edit is done.
  const editingActive =
    descriptionEditing ||
    chatEditing ||
    timelineEditing ||
    promptDraft !== null ||
    responseDraft !== null;
  useEffect(() => {
    if (!editingActive) return;
    setPlayState((state) => (state === "playing" ? "paused" : state));
  }, [editingActive]);

  useEffect(() => {
    onEditingChange(editingActive);
  }, [editingActive, onEditingChange]);

  const togglePlay = useCallback(() => {
    if (editingActive) return;
    if (playState === "playing") {
      setPlayState("paused");
    } else if (playState === "ended") {
      restart();
    } else {
      setPlayState("playing");
    }
  }, [playState, restart, editingActive]);

  // Seek to an absolute time. Forward within the same version just dispatches
  // the skipped events onto the running frame; backward or a version change
  // remounts a fresh app and replays that segment from its start, because app
  // state is cumulative and can't be rewound in place.
  const seekTo = useCallback(
    (rawTarget: number) => {
      const target = Math.max(0, Math.min(duration, rawTarget));
      const seg = segmentIndexForClock(target);
      const rewind =
        target < clockRef.current - 1 || seg !== segmentIndexRef.current;
      clockRef.current = target;
      setDisplayClock(target);
      if (playState === "ended" && target < duration) setPlayState("paused");
      if (!rewind) {
        // Only a READY frame can take the skipped events now. While the frame
        // is still (re)connecting — the player just opened, or another seek's
        // remount is in flight — posting would consume the events into a frame
        // whose replay listener isn't attached yet: the proxy drops them and
        // the applied cursor moves past them for good. The recording then
        // looks broken from this point on (an intro-dismissal that never
        // replays, an app that never appears). Moving only the clock leaves
        // delivery to the frame-ready catch-up effect, which applies
        // everything up to the latest clock once the frame connects.
        if (frameReadyRef.current) applyEventsUpTo(target);
        return;
      }
      const segStart = segments[seg]?.atMs ?? 0;
      let idx = 0;
      while (idx < events.length && events[idx].t < segStart) idx++;
      appliedRef.current = idx;
      resetMcpLog();
      segmentIndexRef.current = seg;
      setSegmentIndex(seg);
      // remount → frameReady:false → the catch-up effect replays up to `target`
      setRunNonce((nonce) => nonce + 1);
    },
    [
      duration,
      events,
      segments,
      segmentIndexForClock,
      applyEventsUpTo,
      resetMcpLog,
      playState,
    ],
  );

  // ── Rendering a video: publish the controls the offline renderer drives.
  // It seeks to an exact millisecond per frame and screenshots the result, so
  // nothing here may depend on wall-clock time. Playback stays paused
  // throughout — the renderer advances the clock itself.
  useEffect(() => {
    if (!filming) return;
    const settled = async () => {
      // Two frames: one for React to commit the seek, one for the compositor
      // to paint it. Capturing earlier catches the PREVIOUS frame.
      for (let i = 0; i < FRAME_SETTLE_TRIES && !frameReadyRef.current; i++) {
        await new Promise((resolve) =>
          setTimeout(resolve, FRAME_SETTLE_STEP_MS),
        );
      }
      // Every frame is a still, so nothing may be caught mid-transition: run
      // the enter animations to their end rather than letting the capture land
      // on whatever opacity they happened to reach. Endless ones (spinners,
      // pulses) have no end to run to and stay where they are.
      for (const animation of document.getAnimations()) {
        try {
          animation.finish();
        } catch {}
      }
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
    };
    window.__archestraReplay = {
      // The gate for the whole render, and the only place a never-loading app
      // frame is cheap to notice. Past here every seek waits the same bounded
      // spell for a frame that will never arrive, which does not fail the
      // render — it multiplies it by that timeout, turning a one-minute export
      // into a half-hour one that looks indistinguishable from a hang. The
      // usual cause is an origin the sandbox refuses to be framed by, so say
      // so rather than reporting a generic stall much later.
      ready: async () => {
        // Renderer check: every codec this recording's video streams use must
        // be decodable in THIS browser, or each affected canvas silently films
        // as an empty rectangle. Recording sticks to VP9/VP8 exactly so any
        // Chromium can decode it; this guards the contract (and any bundle
        // recorded by a future codec) with a loud, immediate failure.
        const codecs = new Set<string>();
        for (const event of events) {
          if (event.kind === "video-config") codecs.add(event.codec);
        }
        if (codecs.size > 0 && typeof VideoDecoder === "undefined") {
          throw new Error(
            "This recording carries encoded video, but the render browser has no WebCodecs decoder.",
          );
        }
        for (const codec of codecs) {
          const support = await VideoDecoder.isConfigSupported({
            codec,
          }).catch(() => null);
          if (!support?.supported) {
            throw new Error(
              `This recording's video codec (${codec}) is not decodable in the render browser.`,
            );
          }
        }
        for (
          let i = 0;
          i < APP_FRAME_READY_TRIES && !frameReadyRef.current;
          i++
        ) {
          await new Promise((resolve) =>
            setTimeout(resolve, FRAME_SETTLE_STEP_MS),
          );
        }
        if (!frameReadyRef.current) {
          throw new Error(
            "The recorded app never loaded in the render browser — check that the renderer's base URL is an origin the app sandbox allows.",
          );
        }
        await settled();
      },
      durationMs: () => duration,
      seek: async (ms: number) => {
        seekTo(ms);
        await settled();
      },
    };
    return () => {
      window.__archestraReplay = undefined;
    };
  }, [filming, duration, seekTo, events]);

  // The single timeline runs on the FULL (uncut) session; a click there seeks
  // the cut playback to the same moment (a click inside a removed stretch
  // snaps to the point it collapses to). Raw time covers the lead-in too, so
  // the plain round-trip is seek-complete over the whole strip.
  const seekBase = useCallback(
    (baseMs: number) => {
      // A click-seek supersedes any scrub rewind still waiting out its
      // throttle — the stale point must not land after this one.
      cancelPendingScrub();
      const clock = playback.toPlaybackMs(basePlayback.toRawMs(baseMs));
      seekIntentRef.current = { baseMs, clock };
      seekTo(clock);
    },
    [playback, basePlayback, seekTo, cancelPendingScrub],
  );

  // Live scrub while a selection is being drawn on the timeline: the replay —
  // chat and app both — tracks the cursor's point. Forward motion applies the
  // skipped events onto the running frame, cheap enough to follow every move;
  // backward motion (or a segment change) needs the remount-and-replay rewind,
  // so those coalesce onto SCRUB_REWIND_THROTTLE_MS, ticking backward as fast
  // as the rebuild allows and always settling on the latest point — the
  // release point included, which is exactly where the playhead then stays.
  const scrubBase = useCallback(
    (baseMs: number) => {
      const clock = playback.toPlaybackMs(basePlayback.toRawMs(baseMs));
      seekIntentRef.current = { baseMs, clock };
      const scrub = scrubRewindRef.current;
      const rewind =
        clock < clockRef.current - 1 ||
        segmentIndexForClock(clock) !== segmentIndexRef.current;
      if (!rewind && scrub.timer === null) {
        seekTo(clock);
        return;
      }
      // A rewind — or one already pending, which a forward step must not
      // overtake. The playhead and readout track the cursor immediately; the
      // replay follows when the throttle fires.
      scrub.pendingClock = clock;
      setDisplayClock(clock);
      if (scrub.timer !== null) return;
      const wait = Math.max(
        0,
        SCRUB_REWIND_THROTTLE_MS - (performance.now() - scrub.lastAt),
      );
      scrub.timer = setTimeout(() => {
        scrub.timer = null;
        scrub.lastAt = performance.now();
        const pending = scrub.pendingClock;
        scrub.pendingClock = null;
        if (pending !== null) seekTo(pending);
      }, wait);
    },
    [playback, basePlayback, segmentIndexForClock, seekTo],
  );

  // ── The one-shot prompt bubble's editor. The bubble in the chat pane is the
  // replay's opening ask; its controls edit or regenerate the enhancement
  // in place (no dialog). Entering edit mode pauses the replay; display-mode
  // regeneration applies the fresh draft directly, edit-mode regeneration only
  // refills the draft for the builder to confirm.
  const generateEnhancement = useEnhanceAppRecording();
  const promptDraftRef = useRef(promptDraft);
  promptDraftRef.current = promptDraft;
  // Generation is slow; by the time a result lands, other edits may have
  // changed the enhancement. Apply against the LATEST state, never the
  // snapshot captured when the request went out.
  const enhancementRef = useRef(recording.enhancement ?? null);
  enhancementRef.current = recording.enhancement ?? null;
  const { applyEnhancement } = editor;
  const savePrompt = useCallback(() => {
    const prompt = (promptDraftRef.current ?? "").trim();
    if (!prompt) return;
    applyEnhancement({
      description:
        enhancementRef.current?.description ??
        fallbackRecordingDescription(recording.appName),
      prompt,
      response: enhancementRef.current?.response,
      category: enhancementRef.current?.category,
    });
    setPromptDraft(null);
  }, [applyEnhancement, recording.appName]);
  const regeneratePrompt = useCallback(() => {
    // The mode is decided when the request goes out: a regenerate started
    // from the open draft only ever refills that draft (and a draft canceled
    // mid-flight discards the result); one started from display mode applies
    // directly.
    const wasEditing = promptDraftRef.current !== null;
    generateEnhancement.mutate(
      { conversationId, appName: recording.appName },
      {
        onSuccess: (result) => {
          if (!result?.prompt) return;
          if (wasEditing) {
            if (promptDraftRef.current !== null) setPromptDraft(result.prompt);
            const backfilled = backfilledEnhancement(
              enhancementRef.current,
              result,
              recording.appName,
            );
            if (backfilled) applyEnhancement(backfilled);
            return;
          }
          applyEnhancement({
            description:
              enhancementRef.current?.description ||
              result.description ||
              fallbackRecordingDescription(recording.appName),
            prompt: result.prompt,
            // A display-mode regenerate refreshes the closing response too;
            // keep the stored one when generation returned none.
            response: result.response ?? enhancementRef.current?.response,
            category: result.category ?? enhancementRef.current?.category,
          });
        },
      },
    );
  }, [
    generateEnhancement.mutate,
    conversationId,
    recording.appName,
    applyEnhancement,
  ]);
  const promptEditor = useMemo<PromptBubbleEditor>(
    () => ({
      draft: promptDraft,
      generating: generateEnhancement.isPending,
      saving: editor.isSaving,
      start: () => {
        setPlayState((state) => (state === "playing" ? "paused" : state));
        setPromptDraft(recording.enhancement?.prompt ?? "");
      },
      change: setPromptDraft,
      save: savePrompt,
      cancel: () => setPromptDraft(null),
      regenerate: regeneratePrompt,
    }),
    [
      promptDraft,
      generateEnhancement.isPending,
      editor.isSaving,
      recording.enhancement?.prompt,
      savePrompt,
      regeneratePrompt,
    ],
  );

  // ── The closing AI response's inline editor. Same contract as the prompt's:
  // hand-edit or regenerate, saved into the bundle's `enhancement` layer.
  const responseDraftRef = useRef(responseDraft);
  responseDraftRef.current = responseDraft;
  const saveResponse = useCallback(() => {
    const response = (responseDraftRef.current ?? "").trim();
    if (!response) return;
    applyEnhancement({
      description:
        enhancementRef.current?.description ??
        fallbackRecordingDescription(recording.appName),
      prompt: enhancementRef.current?.prompt ?? "",
      response,
      category: enhancementRef.current?.category,
    });
    setResponseDraft(null);
  }, [applyEnhancement, recording.appName]);
  const regenerateResponse = useCallback(() => {
    const wasEditing = responseDraftRef.current !== null;
    generateEnhancement.mutate(
      { conversationId, appName: recording.appName },
      {
        onSuccess: (result) => {
          if (!result?.response) return;
          if (wasEditing) {
            if (responseDraftRef.current !== null) {
              setResponseDraft(result.response);
            }
            return;
          }
          applyEnhancement({
            description:
              enhancementRef.current?.description ||
              result.description ||
              fallbackRecordingDescription(recording.appName),
            prompt: enhancementRef.current?.prompt ?? result.prompt ?? "",
            response: result.response,
            category: result.category ?? enhancementRef.current?.category,
          });
        },
      },
    );
  }, [
    generateEnhancement.mutate,
    conversationId,
    recording.appName,
    applyEnhancement,
  ]);
  const responseEditor = useMemo<PromptBubbleEditor>(
    () => ({
      draft: responseDraft,
      generating: generateEnhancement.isPending,
      saving: editor.isSaving,
      start: () =>
        setResponseDraft(
          recording.enhancement?.response?.trim() || FALLBACK_ENHANCED_RESPONSE,
        ),
      change: setResponseDraft,
      save: saveResponse,
      cancel: () => setResponseDraft(null),
      regenerate: regenerateResponse,
    }),
    [
      responseDraft,
      generateEnhancement.isPending,
      editor.isSaving,
      recording.enhancement?.response,
      saveResponse,
      regenerateResponse,
    ],
  );

  // Media-player keyboard controls while the player is mounted: space/k
  // play-pause, ←/→ seek, Home/End jump. (Esc closes via the dialog.)
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      // Let text fields and any open menu/listbox keep their own keys.
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable ||
          target.closest('[role="combobox"],[role="listbox"],[role="menu"]'))
      ) {
        return;
      }
      switch (event.key) {
        case " ":
        case "k":
          event.preventDefault();
          togglePlay();
          break;
        case "ArrowLeft":
          event.preventDefault();
          seekTo(clockRef.current - SEEK_STEP_MS);
          break;
        case "ArrowRight":
          event.preventDefault();
          seekTo(clockRef.current + SEEK_STEP_MS);
          break;
        case "Home":
          event.preventDefault();
          seekTo(0);
          break;
        case "End":
          event.preventDefault();
          seekTo(duration);
          break;
        default:
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePlay, seekTo, duration]);

  // Strict keyboard isolation for the read-only app frame. The pointer overlay
  // blocks clicks, but keyboard follows focus: if anything inside the frame
  // (an autofocused field, a replay-driven control) takes focus, the viewer's
  // keystrokes — Space to play/pause, arrows to seek — would land in the app
  // instead of the player. This yanks focus back to the host document the
  // instant the frame grabs it, so the player always owns the keyboard.
  useEffect(() => {
    const yankFocusBack = () => {
      const iframe = iframeElRef.current;
      if (iframe && document.activeElement === iframe) iframe.blur();
    };
    // `activeElement` settles just after the top window blurs to the frame.
    const onWindowBlur = () => setTimeout(yankFocusBack, 0);
    document.addEventListener("focusin", yankFocusBack, true);
    window.addEventListener("blur", onWindowBlur);
    return () => {
      document.removeEventListener("focusin", yankFocusBack, true);
      window.removeEventListener("blur", onWindowBlur);
    };
  }, []);

  // Resolved BEFORE the bridge below, which keys on it: the sandbox origin is
  // not known on first paint. `mcpSandboxDomain` arrives with the config, so on
  // a cold load this URL changes from same-origin to the dedicated sandbox
  // subdomain once that request lands, and the app frame is pointed somewhere
  // new. Read via useMcpSandboxDomain so the session-less offline video
  // renderer gets it from the public config too — without that fallback the
  // renderer stays on the same-origin URL, which the backend refuses with a 403
  // sandbox-host check, and the app pane films empty.
  const mcpSandboxDomain = useMcpSandboxDomain();
  const sandboxResult = useMemo(
    () =>
      getMcpSandboxBaseUrl(
        mcpSandboxDomain,
        `archestra-app-replay-${conversationId}`,
      ),
    [mcpSandboxDomain, conversationId],
  );
  const sandboxUrl = useMemo(
    () =>
      new URL(
        `${sandboxResult.baseUrl}/_sandbox/mcp-sandbox-proxy.html`,
        window.location.origin,
      ),
    [sandboxResult.baseUrl],
  );

  // Replay bridge: same protocol surface as the live runtime's bridge, but
  // every MCP answer comes from the recording — the "mocked MCP responses".
  // Rebuilt per app-frame instance (segment switch / restart / seek) because a
  // bridge instance can only connect once — and a changed `sandboxUrl` is a new
  // frame just as much as a segment switch is. Without that dependency a late
  // public config reloads the iframe against an already-connected bridge, whose
  // second connect throws, and the app pane never becomes ready: the replay
  // then reports that the recorded app never loaded. Only a cold load on a
  // deployment with a sandbox domain loses that race, which is why it stayed
  // invisible everywhere except the offline video render.
  // biome-ignore lint/correctness/useExhaustiveDependencies: rebuilt per frame instance via segmentIndex/runNonce/sandboxUrl
  const bridge = useMemo(() => {
    const replayBridge = new AppBridge(
      null,
      {
        name: "Archestra",
        version: process.env.NEXT_PUBLIC_APP_VERSION ?? "0.0.0",
      },
      { openLinks: {}, logging: {}, serverResources: {}, serverTools: {} },
      {
        hostContext: buildReplayHostContext("inline") as ConstructorParameters<
          typeof AppBridge
        >[3] extends {
          hostContext?: infer H;
        }
          ? H
          : never,
      },
    );
    type ReplayToolResult = Awaited<
      ReturnType<NonNullable<AppBridge["oncalltool"]>>
    >;
    replayBridge.oncalltool = async (params) =>
      takeRecordedToolResult(mcpLogRef.current, params) as ReplayToolResult;
    replayBridge.onreadresource = async () => ({ contents: [] });
    replayBridge.onlistresources = async () => ({ resources: [] });
    replayBridge.onlistresourcetemplates = async () => ({
      resourceTemplates: [],
    });
    replayBridge.onlistprompts = async () => ({ prompts: [] });
    replayBridge.onrequestdisplaymode = async ({ mode }) => ({ mode });
    replayBridge.onopenlink = async () => ({});
    replayBridge.onmessage = async () => ({});
    replayBridge.onloggingmessage = () => {};
    return replayBridge;
  }, [conversationId, segmentIndex, runNonce, sandboxUrl.href]);

  // A tool call's `t` is its completion time, so its in-flight window is
  // [t - durationMs, t] — the app top bar shows a "running" chip during it.
  const mcpWindows = useMemo(
    () =>
      events
        .filter((event): event is McpTimelineEvent => event.kind === "mcp")
        .filter((event) => event.toolName)
        .map((event) => ({
          start: event.t - (event.durationMs ?? 0),
          end: event.t,
          name: event.toolName as string,
        })),
    [events],
  );
  const activity = useMemo<ReplayActivity>(() => {
    const running = mcpWindows.find(
      (window) => window.start <= displayClock && displayClock <= window.end,
    );
    return running ? { kind: "tool", name: running.name } : null;
  }, [displayClock, mcpWindows]);

  // The chat's imminent activity, reconstructed from the transcript's timing:
  // the next user message "types" into the composer over the lead-up to its
  // send time; before an assistant message a "thinking" loader stands in for
  // generation (the recording has no explicit generation-start marker).
  const nextMessage = useMemo(() => {
    let best: TranscriptMessage | null = null;
    for (const message of transcript) {
      if (message.atMs > displayClock && (!best || message.atMs < best.atMs)) {
        best = message;
      }
    }
    return best;
  }, [transcript, displayClock]);
  const pending = useMemo<ChatPending>(() => {
    if (!nextMessage || displayClock <= 0 || displayClock >= duration) {
      return null;
    }
    // The prompting message must already be on screen before its follow-up
    // indicator shows — otherwise a compressed gap could put "thinking" or the
    // composer typing ahead of the message that triggers it.
    let prevAtMs = 0;
    for (const message of transcript) {
      if (message.atMs < nextMessage.atMs && message.atMs > prevAtMs) {
        prevAtMs = message.atMs;
      }
    }
    if (nextMessage.role === "user") {
      const full = transcriptText(nextMessage);
      if (!full) return null;
      const start = Math.max(
        prevAtMs,
        nextMessage.atMs - COMPOSER_TYPE_LEAD_MS,
      );
      if (displayClock < start) return null;
      // Type over the lead-up, then hold the finished message with the send
      // button pressed for a beat, so the "send" reads before the post.
      const typeEnd = Math.max(start, nextMessage.atMs - SEND_PRESS_MS);
      if (displayClock >= typeEnd) return { kind: "sending", text: full };
      const span = Math.max(1, typeEnd - start);
      const revealed = Math.min(1, (displayClock - start) / span);
      const chars = Math.max(1, Math.round(full.length * revealed));
      return { kind: "typing", text: full.slice(0, chars) };
    }
    if (nextMessage.role === "assistant") {
      const start = Math.max(prevAtMs, nextMessage.atMs - THINKING_LEAD_MS);
      if (displayClock < start) return null;
      return { kind: "thinking" };
    }
    return null;
  }, [nextMessage, transcript, displayClock, duration]);

  const segment = segments[segmentIndex] ?? segments[0];
  // Recomputed only when the shown version changes — rebuilding this string on
  // every render would hand SandboxIframe new HTML each time and remount the
  // app, throwing away the very run we are trying to reproduce.
  const replayHtml = useMemo(
    () => neutralizeAppScripts(segment?.html ?? ""),
    [segment?.html],
  );

  return (
    <div className="flex min-h-0 flex-col">
      {/* Paused means fully frozen: halt every CSS animation/transition in the
          chat pane and app stage (the app's own frame is frozen via the SDK).
          Lifted while the prompt editor or a generation is live — their
          spinners must keep spinning even though playback is paused. */}
      <div
        // The rendered region: the two viewports and nothing else — the
        // toolbar, description and timeline stay out of the exported video.
        // Its explicit card widths are what the shrink-wrapped dialog sizes
        // itself around.
        {...{ [APP_RECORDING_RENDER_REGION_ATTR]: "" }}
        className={cn(
          "flex min-h-0 shrink-0",
          playState !== "playing" &&
            promptDraft === null &&
            !chatEditing &&
            !generateEnhancement.isPending &&
            "[&_*]:![animation-play-state:paused] [&_*]:!transition-none",
        )}
        style={layout ? { height: layout.regionHeight } : undefined}
      >
        {/* The chat replays as a format card of its own — the canonical
            recording aspect, the same shape the app card takes for a
            locked-aspect session — so the player reads as two matched cards
            whatever screen it opens on. */}
        <div
          className={cn("flex min-h-0", layout ? "shrink-0" : "min-w-0 flex-1")}
          style={layout ? { width: layout.chatWidth } : undefined}
        >
          {chatEditing ||
          tourStepKey === "chat-toggle" ||
          tourStepKey === "chat-message" ? (
            <ReplayChatEditPane
              transcript={recording.originalTranscript}
              enhancement={recording.enhancement ?? null}
              chat={chatEdits}
              saving={editor.isSaving}
              promptEditor={promptEditor}
              responseEditor={responseEditor}
              // The tour's message stop demonstrates the original-chat view;
              // display-only, the stored toggle state is untouched.
              forceEnhancementOff={tourStepKey === "chat-message"}
              highlightFirstMessage={tourStepKey === "chat-message"}
              onToggleEnhancement={toggleEnhancementDisabled}
              onRemove={removeChatMessage}
              onRestore={restoreChatMessage}
              onDone={() => setChatEditing(false)}
            />
          ) : (
            <ReplayChatPane
              transcript={transcript}
              clockMs={displayClock}
              durationMs={duration}
              paused={playState !== "playing"}
              filming={filming}
              pending={pending}
              promptEditor={promptEditor}
              showEditHint={tourStepKey === "chat"}
              // Idle at the very start, or spotlighted by the tour: show the
              // finished conversation rather than an empty pane that says
              // nothing about the recording. Never while filming — that is
              // paused at every frame, so the first frame would open on the
              // whole finished chat before the second one snapped back to the
              // timed reveal and began building it up again.
              preview={
                !filming &&
                ((playState !== "playing" && displayClock <= 0) ||
                  tourStepKey === "chat")
              }
              onEnterEdit={() => {
                setChatEditing(true);
                setPlayState((state) =>
                  state === "playing" ? "paused" : state,
                );
              }}
            />
          )}
        </div>
        {/* The app view shares the dialog's single top bar (app icon + name);
            the only per-app chrome is the running-tool chip, floated over the
            stage so it doesn't reintroduce a second header. */}
        {/* The app card takes the RECORDED shape (clamped to sane bounds —
            see replayRegionLayout): a session recorded at the canonical
            locked aspect fills its stage exactly, one uniform scale, no
            margins, and sits as the chat card's twin; an off-shape recording
            gets a sane card whose stage contain-fits it with neutral
            margins. */}
        <div
          className={cn(
            "relative flex select-none flex-col bg-muted/20",
            layout ? "shrink-0" : "min-w-0 flex-1",
          )}
          style={layout ? { width: layout.appWidth } : undefined}
          data-tour="stage"
        >
          {activity && (
            <div className="pointer-events-none absolute right-3 top-3 z-20">
              <ReplayActivityChip activity={activity} />
            </div>
          )}
          {/* The whole stage is a play/pause surface: hovering names the
              action, clicking toggles it — same contract as the transport
              button below. */}
          {/* z-20: must sit ABOVE the stage's own read-only shield (z-10,
              painted later), which would otherwise swallow hover and click. */}
          <button
            type="button"
            aria-label={
              playState === "playing" ? "Pause playback" : "Resume playback"
            }
            className="group absolute inset-0 z-20 cursor-pointer disabled:pointer-events-none"
            // Filming: the export is a clean take, so no hover affordance may
            // surface in it (disabled also drops pointer-events, hence hover).
            disabled={editingActive || filming}
            onClick={togglePlay}
          >
            <span
              className={cn(
                "absolute left-1/2 top-1/2 flex size-10 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-md bg-foreground/60 text-background opacity-0 shadow-sm backdrop-blur-sm transition-opacity group-hover:opacity-100",
                // Hover can't reach under the tour overlay; its stop shows it.
                tourStepKey === "stage" && "opacity-100",
              )}
            >
              {playState === "playing" ? (
                <Pause className="size-4 fill-current" />
              ) : (
                <Play className="size-4 fill-current" />
              )}
            </span>
          </button>
          <ReplayAppStage viewport={viewport}>
            {segment ? (
              <SandboxIframe
                key={`${conversationId}:${segmentIndex}:${runNonce}`}
                html={replayHtml}
                sandboxUrl={sandboxUrl}
                appBridge={bridge}
                useDedicatedOrigin={sandboxResult.hasCrossOrigin}
                initialHeight={viewport.height}
                ownedApp
                onIframeElement={(el) => {
                  iframeElRef.current = el;
                  // Belt-and-suspenders isolation: out of the tab order and
                  // inert so the frame can't take keyboard focus (the focus
                  // guard below is the runtime backstop).
                  if (el) {
                    el.setAttribute("tabindex", "-1");
                    el.setAttribute("inert", "");
                  }
                }}
                // Readiness comes from the SDK's own announcement (relayed on
                // the recording-event channel), NOT from the bridge connect:
                // connect can resolve against a transient document while the
                // sandbox settles, and paints delivered then die with it.
                onRecordingEvents={(data) => {
                  if ((data as { replayReady?: boolean } | null)?.replayReady) {
                    armReplayFrame();
                  }
                }}
                // Fallback for a stale cached SDK that predates the
                // announcement: after a beat, treat connect as ready.
                onConnected={() => {
                  if (legacyReadyTimerRef.current) return;
                  legacyReadyTimerRef.current = setTimeout(() => {
                    if (!frameReadyRef.current) armReplayFrame();
                  }, 1500);
                }}
              />
            ) : null}
          </ReplayAppStage>
        </div>
      </div>
      {/* One transport row, one timeline: the strip below is scrubber and
          cutter at once — click seeks, hold-and-drag selects a stretch to
          Cut, removed stretches are the bare gaps between section cards, and
          the timeline's own ends drag inward to trim the head or tail. */}
      <TooltipProvider delayDuration={300}>
        {/* The timeline column stacks a ruler above the strip, so the row's
            other controls bottom-align and each carries the margin that
            centers it on the 32px STRIP — centering on the whole column would
            hang everything ruler-height too high. */}
        {/* No `border-t`: the app stage ends directly above this row, so the
            standard border token draws a light hairline straight across the
            replayed app and reads as a stray white line around it. The strip's
            own filled bar already separates the transport from the stage. */}
        {/* `w-0 min-w-full`: span the shrink-wrapped dialog without
            contributing intrinsic width — the render region alone sets it. */}
        {/* Filming: invisible, not gone. The offline renderer composites the
            whole viewport and skips frames without damage, so the transport's
            per-seek ticks (readout, playhead pin) would mark every frame as
            changed and defeat that. Visibility keeps the layout — the render
            region must not move — while a hidden repaint is no damage. */}
        <div
          className={cn(
            "flex w-0 min-w-full shrink-0 items-end gap-3 px-4 py-2.5",
            filming && "invisible",
          )}
        >
          {(() => {
            const playButton = (
              <Button
                type="button"
                size="icon"
                variant="default"
                className="-mb-0.5 size-9 rounded-md"
                aria-label={playState === "playing" ? "Pause" : "Play"}
                disabled={editingActive}
                onClick={togglePlay}
              >
                {playState === "playing" ? (
                  <Pause className="h-4 w-4 fill-current" />
                ) : (
                  <Play className="h-4 w-4 fill-current" />
                )}
              </Button>
            );
            // Playing is self-evident and needs no tooltip; a play button that
            // will not respond does — it has to say why. (A disabled button
            // fires no pointer events, hence the wrapper.)
            return editingActive ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="-mb-0.5 inline-flex">{playButton}</span>
                </TooltipTrigger>
                <TooltipContent side="top" className="text-xs">
                  Finish editing to play the recording
                </TooltipContent>
              </Tooltip>
            ) : (
              playButton
            );
          })()}
          {/* No fixed-width reserve: tabular-nums keeps the readout stable,
              and a sized box would pad one side and break the row's even
              gap rhythm. */}
          <span className="mb-2 shrink-0 whitespace-nowrap text-xs tabular-nums text-muted-foreground">
            {formatMs(displayClock)} / {formatMs(duration)}
          </span>
          <ReplayTimeline
            durationMs={baseDuration}
            cuts={baseCuts}
            playheadMs={playheadBaseMs}
            contentStartMs={basePlayback.toPlaybackMs(rawStart + PREROLL_MS)}
            saving={editor.isSaving}
            onEditingChange={setTimelineEditing}
            demo={
              tourStepKey === "timeline-cut"
                ? "cut"
                : tourStepKey === "timeline-restore"
                  ? "restore"
                  : tourStepKey === "timeline-resize"
                    ? "resize"
                    : null
            }
            exportLimit={exportLimitBaseMs}
            onSeek={seekBase}
            onScrub={scrubBase}
            onCut={cutBaseRange}
            onResize={resizeCutBase}
            onRestore={restoreCut}
            onTrim={trimBase}
            onTrimToLimit={trimToExportLimit}
          />
        </div>
      </TooltipProvider>
    </div>
  );
}

/**
 * Inline editor for the one-shot build prompt, rendered in the chat pane in
 * place of the prompt bubble. Hand-edit freely, or regenerate from the session
 * (implicitly over the chat's connected agent) to refill the draft; saving is
 * a mutating editor action (undoable like any other) that lands in the
 * bundle's separate `enhancement` object, never in the captured session data.
 * Escape cancels, Ctrl/Cmd+Enter saves.
 */
function ReplayPromptEditorCard({
  editor,
  from = "user",
}: {
  editor: PromptBubbleEditor;
  from?: "user" | "assistant";
}) {
  const draft = editor.draft ?? "";
  // The field the caret has already been placed in — re-running on every
  // render would fight the user's own cursor.
  const focusedFieldRef = useRef<HTMLTextAreaElement | null>(null);
  return (
    <Message from={from}>
      {/* The same editor as the app description's — one seamless field with
          the actions on a quiet footer rail — wearing the bubble's own colors
          so entering edit mode doesn't repaint the message. */}
      <MessageContent className="!pointer-events-auto w-[85%] select-text overflow-hidden p-0">
        <Textarea
          // Focused with the caret AFTER the existing text: this edits a
          // prompt that is already written.
          ref={(node) => {
            if (!node || node === focusedFieldRef.current) return;
            focusedFieldRef.current = node;
            node.focus();
            const end = node.value.length;
            node.setSelectionRange(end, end);
          }}
          rows={6}
          value={draft}
          disabled={editor.generating || editor.saving}
          onChange={(event) => editor.change(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              editor.cancel();
            }
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              editor.save();
            }
          }}
          placeholder={
            editor.generating
              ? "Generating from the chat session…"
              : "The single prompt that would have produced the final app."
          }
          className="!pointer-events-auto min-h-0 select-text resize-none rounded-none border-0 bg-transparent px-4 pb-1 pt-3 text-sm leading-relaxed shadow-none focus-visible:ring-0 dark:bg-transparent"
          aria-label="One-shot build prompt"
        />
        <div className="flex items-center justify-end gap-2 border-t border-black/10 bg-black/5 px-2 py-1.5">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            // Outlined like the description's Regenerate, but in the bubble's
            // own ink: `border` would resolve against the pane, not the tint.
            className="!pointer-events-auto h-7 gap-1.5 border border-black/15 px-2.5 text-xs hover:bg-black/10"
            disabled={editor.generating || editor.saving}
            onClick={editor.regenerate}
          >
            {editor.generating ? (
              <Loader size={12} />
            ) : (
              <Sparkles className="size-3" />
            )}
            {editor.generating ? "Regenerating…" : "Regenerate"}
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="!pointer-events-auto h-7 px-3 text-xs"
            disabled={editor.generating || editor.saving || !draft.trim()}
            onClick={editor.save}
          >
            Save
          </Button>
        </div>
      </MessageContent>
    </Message>
  );
}
function ReplayDescriptionRow({
  conversationId,
  appName,
  enhancement,
  saving,
  showEditHint,
  onEditingChange,
  onSave,
  onRegenerated,
}: {
  conversationId: string;
  appName: string;
  enhancement: RecordingEnhancement | null;
  saving: boolean;
  /** Tour spotlight: hover can't reach under the tour overlay, so the stop
   * forces the edit chip visible while it points here. */
  showEditHint?: boolean;
  /** Editing anything pauses the replay and locks the play controls. */
  onEditingChange?: (editing: boolean) => void;
  onSave: (description: string) => void;
  /** A regenerate landed: the player adopts any field the bundle is missing. */
  onRegenerated?: (result: RecordingEnhancementDraft | null) => void;
}) {
  const generate = useEnhanceAppRecording();
  // null = display mode; a string = the in-edit draft.
  const [draft, setDraft] = useState<string | null>(null);
  // Enter-save, Escape-discard and the editor's unmount can race the
  // textarea's blur; the first close wins and later ones must be no-ops.
  const closedRef = useRef(false);
  const editorRef = useRef<HTMLDivElement>(null);
  // The field instance the caret has already been placed in — re-running on
  // every render would fight the user's own cursor.
  const focusedFieldRef = useRef<HTMLTextAreaElement | null>(null);
  const description =
    enhancement?.description ?? fallbackRecordingDescription(appName);

  const close = (commit: boolean) => {
    if (closedRef.current) return;
    closedRef.current = true;
    focusedFieldRef.current = null;
    if (commit) {
      const text = draft?.trim().slice(0, APP_RECORDING_DESCRIPTION_MAX_CHARS);
      // An unchanged (or emptied) draft must not spend an undo step.
      if (text && text !== description) onSave(text);
    }
    setDraft(null);
  };
  // Clicking anywhere outside the editor saves-and-closes. Blur cannot be
  // trusted for this inside the dialog's focus trap (a press on non-focusable
  // chrome may never move focus off the textarea), so a document-level
  // listener watches the actual pointer presses instead.
  const closeLatestRef = useRef(close);
  closeLatestRef.current = close;
  const editing = draft !== null;
  useEffect(() => {
    onEditingChange?.(editing);
  }, [editing, onEditingChange]);
  useEffect(() => {
    if (!editing) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!editorRef.current?.contains(event.target as Node)) {
        closeLatestRef.current(true);
      }
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () =>
      document.removeEventListener("pointerdown", onPointerDown, true);
  }, [editing]);

  // One static layout for both modes: the display text always occupies its
  // slot, and the editor floats OVER it as a popover-style card — entering
  // and leaving edit mode never reflows the header or the player below.
  return (
    <div className="relative w-full max-w-2xl">
      <button
        type="button"
        aria-label="Edit description"
        title="Click to edit"
        disabled={saving || editing}
        data-tour="description"
        className={cn(
          // Negative margins cancel the padding, so the roomier hover box
          // grows around the text without moving it.
          "group/desc relative -mx-2.5 -my-2 flex max-w-2xl items-start rounded-md px-2.5 py-2 text-left text-sm text-muted-foreground transition-colors cursor-text hover:bg-muted hover:text-foreground",
          editing && "invisible",
        )}
        onClick={() => {
          closedRef.current = false;
          setDraft(description);
        }}
      >
        <span className="line-clamp-3 min-w-0">{description}</span>
        {/* The hover hint says what a click does: edit. Sized down from the
            chat's chip because a one-line description is barely taller than
            the chip itself, and a full-size one swallows the line. */}
        <span
          className={cn(
            EDIT_HINT_CHIP,
            "size-7 group-hover/desc:opacity-100",
            showEditHint && "opacity-100",
          )}
        >
          <Pencil className="size-3.5" />
        </span>
      </button>
      {editing && (
        // One seamless field-in-a-card: the textarea carries no chrome of its
        // own (a bordered field inside a bordered card reads as nested boxes)
        // and the actions sit on a quiet footer rail under it.
        <div
          ref={editorRef}
          className="absolute -left-2.5 -top-2 z-30 w-[calc(100%+1.25rem)] overflow-hidden rounded-lg border bg-popover shadow-lg ring-1 ring-black/5"
        >
          <Textarea
            // Focused with the caret AFTER the existing text: this edits a
            // sentence that is already written, so autoFocus alone (which
            // selects nothing and can leave the caret at position 0) is the
            // wrong starting point.
            ref={(node) => {
              if (!node || node === focusedFieldRef.current) return;
              focusedFieldRef.current = node;
              node.focus();
              const end = node.value.length;
              node.setSelectionRange(end, end);
            }}
            rows={2}
            maxLength={APP_RECORDING_DESCRIPTION_MAX_CHARS}
            value={draft ?? ""}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                close(true);
              }
              if (event.key === "Escape") close(false);
            }}
            disabled={saving}
            className="min-h-0 resize-none rounded-none border-0 bg-transparent px-3 pb-1 pt-2.5 text-sm leading-relaxed shadow-none focus-visible:ring-0 dark:bg-transparent"
            aria-label="One-sentence description"
          />
          <div className="flex items-center gap-2 border-t bg-muted/30 px-2 py-1.5">
            <span className="pl-1 text-[11px] tabular-nums text-muted-foreground">
              {(draft ?? "").length}/{APP_RECORDING_DESCRIPTION_MAX_CHARS}
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="ml-auto h-7 gap-1.5 px-2.5 text-xs"
              disabled={saving || generate.isPending}
              onClick={() =>
                generate.mutate(
                  { conversationId, appName },
                  {
                    onSuccess: (result) => {
                      // The draft is worth adopting even if the response is
                      // not, and vice versa — they are independent.
                      onRegenerated?.(result);
                      // Landing after the editor closed must not reopen it.
                      if (closedRef.current || !result?.description) return;
                      setDraft(
                        result.description.slice(
                          0,
                          APP_RECORDING_DESCRIPTION_MAX_CHARS,
                        ),
                      );
                    },
                  },
                )
              }
            >
              {generate.isPending ? (
                <Loader size={12} />
              ) : (
                <Sparkles className="size-3" />
              )}
              {generate.isPending ? "Regenerating…" : "Regenerate"}
            </Button>
            <Button
              type="button"
              size="sm"
              className="h-7 px-3 text-xs"
              disabled={saving}
              onClick={() => close(true)}
            >
              Save
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Which timeline gesture the tour is illustrating on the strip. */
type TimelineTourGesture = "cut" | "restore" | "resize";

/** Smallest selectable/keepable stretch on the timeline, in timeline ms. */
const MIN_CUT_TIMELINE_MS = 250;
/** Pointer travel at or past this many px is always a drag-selection. */
const CLICK_DRAG_PX = 5;
/** A press released within this many ms AND under CLICK_DRAG_PX of travel is
 * a click; real clicks release fast, deliberate presses hold longer. */
const CLICK_MAX_HOLD_MS = 250;

/**
 * How a completed press on the timeline strip resolves. Travel past the
 * click threshold always selects, however quick the gesture. Below it, a
 * press HELD longer than any real click still selects — on a long recording
 * a sliver-thin stretch spans fewer px than the click threshold, so hold
 * time is the only signal that can express cutting it. Only a quick,
 * near-motionless press is a click (seek).
 */
export function classifyTimelineGesture(gesture: {
  travelPx: number;
  heldMs: number;
}): "seek" | "select" {
  if (gesture.travelPx >= CLICK_DRAG_PX) return "select";
  return gesture.heldMs > CLICK_MAX_HOLD_MS ? "select" : "seek";
}

/**
 * The kept stretches of the timeline — the complement of the removed ranges
 * over [0, durationMs]. Stored cuts may overlap (each Cut just appends its
 * range), so removals are merged first; the result is the disjoint, ordered
 * list of sections the strip renders as content cards.
 */
export function keptTimelineRanges(
  durationMs: number,
  removed: { fromMs: number; toMs: number }[],
): { fromMs: number; toMs: number }[] {
  const merged: { fromMs: number; toMs: number }[] = [];
  const sorted = removed
    .map((range) => ({
      fromMs: Math.max(0, range.fromMs),
      toMs: Math.min(durationMs, range.toMs),
    }))
    .filter((range) => range.toMs > range.fromMs)
    .sort((a, b) => a.fromMs - b.fromMs);
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range.fromMs <= last.toMs) {
      last.toMs = Math.max(last.toMs, range.toMs);
    } else {
      merged.push({ ...range });
    }
  }
  const kept: { fromMs: number; toMs: number }[] = [];
  let cursor = 0;
  for (const range of merged) {
    if (range.fromMs - cursor >= 1) {
      kept.push({ fromMs: cursor, toMs: range.fromMs });
    }
    cursor = Math.max(cursor, range.toMs);
  }
  if (durationMs - cursor >= 1) kept.push({ fromMs: cursor, toMs: durationMs });
  return kept;
}

/**
 * Classify a stored cut against the timeline's raw extent (lead-in included):
 * touching the raw start makes it a head trim, touching the raw end a tail
 * trim, anything else a mid cut. Classification happens in raw time — the
 * space cuts are stored in, and the same space buildPlayback's end-trim
 * handling compares in — so the strip and the playback always agree on what
 * is a trim.
 */
export function classifyCut(
  cut: { fromMs: number; toMs: number },
  rawStart: number,
  rawEnd: number,
): "start" | "end" | "mid" {
  if (cut.fromMs <= rawStart + TRIM_EDGE_EPS_MS) return "start";
  if (cut.toMs >= rawEnd - TRIM_EDGE_EPS_MS) return "end";
  return "mid";
}

/**
 * One-click "trim to the export limit": the cut list that keeps the CURRENT
 * edit — mid cuts, head trim and all — and shortens it from the END of the
 * edited playback until it runs exactly `limitMs`. Null when the cut already
 * fits (nothing to do) or the recording is degenerate.
 *
 * The boundary is found by verification, never a single mapping pass: cut
 * edges land on whole raw milliseconds, and the limit instant can fall
 * inside an idle-compressed gap, where a mapped-and-rounded edge re-expands
 * to MORE playback than the limit — and a cut even one millisecond over
 * still displays as "30s" while the export refuses it. Duration grows
 * monotonically with the trim boundary, so the largest fitting boundary is
 * found by bisection, each candidate proven by rebuilding the playback it
 * would produce.
 */
export function trimCutsToExportLimit(
  recording: PlaybackRecording,
  limitMs: number,
): { fromMs: number; toMs: number }[] | null {
  const playback = buildPlayback(recording);
  if (playback.duration <= limitMs) return null;
  const base = buildPlayback(uncutRecording(recording));
  const rawStart = Math.round(base.toRawMs(0));
  const rawEnd = Math.round(base.toRawMs(Math.max(base.duration, 1)));
  const cuts = recording.edits?.cuts ?? [];
  const trial = (fromMs: number) => {
    // Existing end trims are replaced by the new one, and mid cuts swallowed
    // whole by it are dropped — the same rule the end bracket's drag applies,
    // so the stored list stays clean.
    const kept = cuts.filter((cut) => {
      const kind = classifyCut(cut, rawStart, rawEnd);
      return kind !== "end" && !(kind === "mid" && cut.fromMs >= fromMs);
    });
    const next = [...kept, { fromMs, toMs: rawEnd }];
    const duration = buildPlayback({
      ...recording,
      edits: { ...recording.edits, cuts: next },
    }).duration;
    return { next, fits: duration <= limitMs };
  };
  // The natural candidate: the raw instant currently playing at the limit.
  let hi = Math.round(playback.toRawMs(limitMs));
  if (hi - rawStart < 1 || rawEnd - hi < 1) return null;
  const first = trial(hi);
  if (first.fits) return first.next;
  let lo = rawStart + 1; // a whole-session trim always fits
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (trial(mid).fits) lo = mid;
    else hi = mid;
  }
  const best = trial(lo);
  return best.fits ? best.next : null;
}

type TimelineDrag =
  | {
      kind: "select";
      anchorMs: number;
      anchorClientX: number;
      anchorTime: number;
      currentMs: number;
      currentClientX: number;
    }
  | {
      kind: "resize";
      index: number;
      edge: "from" | "to";
      anchorClientX: number;
      anchorMs: number;
      currentMs: number;
      currentClientX: number;
    }
  | {
      kind: "trim";
      edge: "start" | "end";
      anchorClientX: number;
      anchorMs: number;
      currentMs: number;
      currentClientX: number;
    };

/**
 * The player's single, Loom-style timeline: it lays out the FULL (uncut)
 * session and is scrubber, cutter, and trimmer at once. Click to seek. Drag
 * across the strip to select a stretch, then press Cut; a cut renders dimmed
 * to background, its edge grips drag to grow or shrink it, with a restore
 * button inside. The timeline's own ends are brackets that drag inward to
 * trim the head or tail (an edge-touching cut, no Cut press needed) and drag
 * back out to restore. The replay simply skips removed regions as if they
 * were never there — while underneath nothing captured is ever discarded, so
 * restoring (or undoing) brings any stretch back exactly.
 */
function ReplayTimeline({
  durationMs,
  cuts,
  playheadMs,
  contentStartMs,
  saving,
  exportLimit,
  onSeek,
  onScrub,
  demo,
  onEditingChange,
  onCut,
  onResize,
  onRestore,
  onTrim,
  onTrimToLimit,
}: {
  durationMs: number;
  /** Existing cuts in full-timeline ms, in stored order, pre-classified. */
  cuts: { fromMs: number; toMs: number; kind: "start" | "end" | "mid" }[];
  playheadMs: number;
  /** Where real session content begins on this timeline — before it lies the
   * synthetic (still cuttable) lead-in beat; an end trim must always keep
   * some content past this point. */
  contentStartMs: number;
  saving: boolean;
  /** Tour demo: illustrate one timeline gesture over the strip. Illustration
   * only — non-interactive, and no edit state is touched. */
  demo?: TimelineTourGesture | null;
  /** Where played time crosses the export cap on this strip — the clickable
   * "trim to the limit" mark; null while the cut already fits. */
  exportLimit: number | null;
  /** Editing anything pauses the replay and locks the play controls. */
  onEditingChange?: (editing: boolean) => void;
  onSeek: (ms: number) => void;
  /** Live scrub while a selection is drawn: the replay follows the cursor. */
  onScrub: (ms: number) => void;
  /** One click cuts the edit down to exactly the export limit. */
  onTrimToLimit: () => void;
  onCut: (range: { fromMs: number; toMs: number }) => void;
  onResize: (index: number, range: { fromMs: number; toMs: number }) => void;
  onRestore: (index: number) => void;
  onTrim: (edge: "start" | "end", boundaryMs: number) => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<TimelineDrag | null>(null);
  const [selection, setSelection] = useState<{
    fromMs: number;
    toMs: number;
  } | null>(null);
  // Where a click would land playback: tracks the cursor over the strip and
  // the ruler band, rendered as the playhead's quiet grey twin.
  const [hoverMs, setHoverMs] = useState<number | null>(null);
  // Whether the current select-drag has crossed the click threshold and become
  // a scrubbing selection. Latched for the rest of the drag: a cursor that
  // doubles back over its own anchor keeps scrubbing rather than going quiet
  // inside the click-sized dead zone.
  const scrubLatchedRef = useRef(false);

  // Committing an edit re-times the timeline; a stale selection would point at
  // the wrong stretch, so any change to the cut list clears it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: cuts is the intended reset trigger
  useEffect(() => {
    setSelection(null);
    setDrag(null);
  }, [cuts]);

  // A press alone is not yet an edit: it may resolve to a click-seek, which
  // must leave a running replay running (pausing it here would strand playback
  // at the clicked point, never resuming). So a drag owns the moment only once
  // it has travelled past the click threshold into a genuine selection, resize
  // or trim — the same line the release handler draws between seek and select.
  // A committed selection (its Cut/Dismiss prompt showing) always counts.
  const dragEditing =
    drag !== null &&
    Math.abs(drag.currentClientX - drag.anchorClientX) >= CLICK_DRAG_PX;
  useEffect(() => {
    onEditingChange?.(selection !== null || dragEditing);
  }, [selection, dragEditing, onEditingChange]);

  const msAtClientX = (clientX: number): number => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return 0;
    const fraction = Math.min(
      1,
      Math.max(0, (clientX - rect.left) / rect.width),
    );
    return fraction * durationMs;
  };
  const leftPct = (ms: number) => `${(Math.max(0, ms) / durationMs) * 100}%`;
  const widthPct = (fromMs: number, toMs: number) =>
    `${(Math.max(0, toMs - fromMs) / durationMs) * 100}%`;

  // Trim boundaries: where the kept portion of the timeline begins and ends.
  // Edge-touching cuts ARE the trims; mid cuts render with their own controls.
  const startTrimMs = cuts
    .filter((cut) => cut.kind === "start")
    .reduce((max, cut) => Math.max(max, cut.toMs), 0);
  const endTrimMs = cuts
    .filter((cut) => cut.kind === "end")
    .reduce((min, cut) => Math.min(min, cut.fromMs), durationMs);
  const midCutIndexes = cuts
    .map((_, index) => index)
    .filter((index) => cuts[index].kind === "mid");

  // A trim can never eat the whole timeline: each bracket stops a beat short
  // of the other, and the end bracket also stops a beat past where real
  // content begins (a demo of pure lead-in is nothing).
  const clampStart = (ms: number) =>
    Math.min(Math.max(0, ms), Math.max(0, endTrimMs - MIN_CUT_TIMELINE_MS));
  const clampEnd = (ms: number) =>
    Math.max(
      Math.min(durationMs, ms),
      Math.min(
        durationMs,
        Math.max(startTrimMs, contentStartMs) + MIN_CUT_TIMELINE_MS,
      ),
    );
  const startBoundary =
    drag?.kind === "trim" && drag.edge === "start"
      ? clampStart(drag.currentMs)
      : startTrimMs;
  const endBoundary =
    drag?.kind === "trim" && drag.edge === "end"
      ? clampEnd(drag.currentMs)
      : endTrimMs;

  // Live cut ranges: while an edge is dragged, preview the new range locally;
  // the edit commits (one undo step) on release. An edge may travel all the
  // way to its opposite edge — gluing the section cards back together — which
  // commits as a restore of the cut.
  const liveCuts = cuts.map((cut, index) => {
    if (drag?.kind !== "resize" || drag.index !== index) return cut;
    return drag.edge === "from"
      ? { fromMs: Math.min(drag.currentMs, cut.toMs), toMs: cut.toMs }
      : { fromMs: cut.fromMs, toMs: Math.max(drag.currentMs, cut.fromMs) };
  });

  // Handle drags are RELATIVE: the press anchors the boundary at its current
  // value (the press may land anywhere in the grip's hit slack, and the
  // boundary must not jump to the cursor) and the boundary then moves by the
  // pointer's travel.
  const beginResize =
    (index: number, edge: "from" | "to") =>
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (saving || event.button !== 0) return;
      event.stopPropagation();
      trackRef.current?.setPointerCapture(event.pointerId);
      setSelection(null);
      const anchorMs = edge === "from" ? cuts[index].fromMs : cuts[index].toMs;
      setDrag({
        kind: "resize",
        index,
        edge,
        anchorClientX: event.clientX,
        anchorMs,
        currentMs: anchorMs,
        currentClientX: event.clientX,
      });
    };

  const beginTrim =
    (edge: "start" | "end") => (event: React.PointerEvent<HTMLDivElement>) => {
      if (saving || event.button !== 0) return;
      event.stopPropagation();
      trackRef.current?.setPointerCapture(event.pointerId);
      setSelection(null);
      const anchorMs = edge === "start" ? startTrimMs : endTrimMs;
      setDrag({
        kind: "trim",
        edge,
        anchorClientX: event.clientX,
        anchorMs,
        currentMs: anchorMs,
        currentClientX: event.clientX,
      });
    };

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (saving || event.button !== 0) return;
    trackRef.current?.setPointerCapture(event.pointerId);
    const at = msAtClientX(event.clientX);
    setSelection(null);
    scrubLatchedRef.current = false;
    setDrag({
      kind: "select",
      anchorMs: at,
      anchorClientX: event.clientX,
      anchorTime: performance.now(),
      currentMs: at,
      currentClientX: event.clientX,
    });
  };
  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const at = msAtClientX(event.clientX);
    setHoverMs(at);
    if (!drag) return;
    // Selection endpoints track the cursor absolutely; handle drags move
    // their anchored boundary by the pointer's travel (see beginResize).
    const currentMs =
      drag.kind === "select"
        ? at
        : drag.anchorMs + (at - msAtClientX(drag.anchorClientX));
    setDrag({ ...drag, currentMs, currentClientX: event.clientX });
    // A selection drag scrubs as it draws: past the click threshold the
    // replay follows the cursor point for point, forward and back.
    if (drag.kind === "select") {
      if (
        scrubLatchedRef.current ||
        Math.abs(event.clientX - drag.anchorClientX) >= CLICK_DRAG_PX
      ) {
        scrubLatchedRef.current = true;
        onScrub(at);
      }
    }
  };
  const handlePointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    scrubLatchedRef.current = false;
    if (!drag) return;
    if (trackRef.current?.hasPointerCapture(event.pointerId)) {
      trackRef.current.releasePointerCapture(event.pointerId);
    }
    setDrag(null);
    // A capture can end with the cursor far away; the next move re-seeds it.
    setHoverMs(null);
    if (drag.kind === "select") {
      const fromMs = Math.min(drag.anchorMs, drag.currentMs);
      const toMs = Math.max(drag.anchorMs, drag.currentMs);
      const gesture = classifyTimelineGesture({
        travelPx: Math.abs(event.clientX - drag.anchorClientX),
        heldMs: performance.now() - drag.anchorTime,
      });
      // A zero-span drag (pure vertical wobble) has nothing to select.
      if (gesture === "seek" || toMs - fromMs < 1) {
        // The everyday interaction: a click fast-forwards (or rewinds)
        // playback to the PRESSED point — release drift is accidental.
        setSelection(null);
        onSeek(drag.anchorMs);
        return;
      }
      setSelection({ fromMs, toMs });
      return;
    }
    if (drag.kind === "resize") {
      // A no-move press on a grip is a seek to the boundary under it — the
      // grip must not shadow that moment (and a no-op resize would waste an
      // undo step).
      if (Math.abs(event.clientX - drag.anchorClientX) < CLICK_DRAG_PX) {
        onSeek(drag.currentMs);
        return;
      }
      const live = liveCuts[drag.index];
      if (live) {
        // Edges dragged together glue the neighboring sections back: the
        // closed cut is restored rather than kept as an ungrabbable sliver.
        if (live.toMs - live.fromMs < 1) {
          onRestore(drag.index);
          return;
        }
        onResize(drag.index, {
          fromMs: Math.max(0, Math.min(live.fromMs, durationMs)),
          toMs: Math.max(0, Math.min(live.toMs, durationMs)),
        });
      }
      return;
    }
    // Trim: commit the dragged boundary — any size, exactly like a mid cut.
    // Dragged all the way back to the timeline's edge, the boundary glues the
    // edge shut and the trim is removed instead. A no-move press seeks to the
    // boundary — same rule as the cut-edge grips.
    if (Math.abs(event.clientX - drag.anchorClientX) < CLICK_DRAG_PX) {
      onSeek(drag.currentMs);
      return;
    }
    if (drag.edge === "start") {
      onTrim("start", clampStart(drag.currentMs));
    } else {
      onTrim("end", clampEnd(drag.currentMs));
    }
  };

  // The ruler doubles as a pure seek bar, Loom-style: pressing anywhere on it
  // (the playhead pin's zone included) jumps there. This is also the escape
  // hatch for moments the strip's drag grips sit over — a grip swallows strip
  // presses at its boundary, but never the ruler above it.
  const rulerSeekingRef = useRef(false);
  const handleRulerPointerDown = (
    event: React.PointerEvent<HTMLDivElement>,
  ) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    rulerSeekingRef.current = true;
    onSeek(msAtClientX(event.clientX));
  };
  const handleRulerPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!rulerSeekingRef.current) return;
    rulerSeekingRef.current = false;
    onSeek(msAtClientX(event.clientX));
  };

  const selectionActive =
    drag?.kind === "select"
      ? Math.abs(drag.currentMs - drag.anchorMs) >= 1
        ? {
            fromMs: Math.min(drag.anchorMs, drag.currentMs),
            toMs: Math.max(drag.anchorMs, drag.currentMs),
          }
        : null
      : selection;

  const playheadClampedMs = Math.min(playheadMs, durationMs);
  // The strip renders the KEPT session as section cards; removed stretches
  // (trims and cuts, live drag previews included) are the gaps between them.
  const removedRanges = [
    ...(startBoundary > 0 ? [{ fromMs: 0, toMs: startBoundary }] : []),
    ...midCutIndexes.map((index) => liveCuts[index]),
    ...(endBoundary < durationMs
      ? [{ fromMs: endBoundary, toMs: durationMs }]
      : []),
  ];
  const keptRanges = keptTimelineRanges(durationMs, removedRanges);

  return (
    <>
      {/* Loom-style timeline: a ruler of evenly spaced time marks on top of
          the strip. The KEPT session renders as bordered section cards whose
          fill doubles as the scrubber's progress; removed stretches read as
          bare gaps between cards; every remove-boundary carries an identical
          drag pill; and the one strong color on the surface is the playhead
          pin dropping from the ruler through the strip. */}
      <div
        className={cn(
          "relative flex min-w-0 flex-1 flex-col",
          // A held handle keeps the closed-hand cursor for the WHOLE drag:
          // pointer capture routes the pointer across other elements (strip,
          // ruler), whose own cursors must not flicker through mid-drag.
          (drag?.kind === "resize" || drag?.kind === "trim") &&
            "cursor-grabbing [&_*]:!cursor-grabbing",
        )}
        data-tour="timeline"
      >
        {/* The ruler's whole band (down to the strip's edge) is a seek
            surface; the ruler marks themselves stay pointer-transparent. */}
        <div
          className="cursor-pointer touch-none pb-1"
          onPointerDown={handleRulerPointerDown}
          onPointerUp={handleRulerPointerUp}
          onPointerMove={(event) => setHoverMs(msAtClientX(event.clientX))}
          onPointerLeave={() => setHoverMs(null)}
        >
          <TimelineRuler durationMs={durationMs} />
        </div>
        <div
          ref={trackRef}
          className="relative h-8 cursor-crosshair touch-none select-none overflow-hidden rounded-md border bg-muted/60"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerLeave={() => setHoverMs(null)}
        >
          {/* Kept sections; their fill doubles as the scrubber's progress. */}
          {keptRanges.map((range) => {
            const spanMs = range.toMs - range.fromMs;
            const playedMs = Math.min(
              Math.max(playheadClampedMs - range.fromMs, 0),
              spanMs,
            );
            return (
              <div
                key={`kept-${range.fromMs}`}
                className="pointer-events-none absolute inset-y-0 overflow-hidden rounded-md border border-primary/50 bg-primary/10"
                style={{
                  left: leftPct(range.fromMs),
                  width: widthPct(range.fromMs, range.toMs),
                }}
              >
                <div
                  className="absolute inset-y-0 left-0 bg-primary/30"
                  style={{ width: `${(playedMs / spanMs) * 100}%` }}
                />
              </div>
            );
          })}
          {/* Pending selection — the stretch a Cut would remove. */}
          {selectionActive && selectionActive.toMs > selectionActive.fromMs && (
            <div
              className="absolute inset-y-0 border-x border-destructive bg-destructive/25"
              style={{
                left: leftPct(selectionActive.fromMs),
                width: widthPct(selectionActive.fromMs, selectionActive.toMs),
              }}
            />
          )}
          {/* One shared pill grip per remove-boundary: the whole timeline's
              trim ends and every cut edge drag with the same handle. */}
          {midCutIndexes.map((index) => (
            <TimelineGrip
              key={`cut-from-${index}`}
              atMs={liveCuts[index].fromMs}
              keptSide="left"
              leftPct={leftPct}
              onPointerDown={beginResize(index, "from")}
            />
          ))}
          {midCutIndexes.map((index) => (
            <TimelineGrip
              key={`cut-to-${index}`}
              atMs={liveCuts[index].toMs}
              keptSide="right"
              leftPct={leftPct}
              onPointerDown={beginResize(index, "to")}
            />
          ))}
          <TimelineGrip
            atMs={startBoundary}
            keptSide="right"
            leftPct={leftPct}
            onPointerDown={beginTrim("start")}
          />
          <TimelineGrip
            atMs={endBoundary}
            keptSide="left"
            leftPct={leftPct}
            onPointerDown={beginTrim("end")}
          />
        </div>
        {/* Each cut's restore control is its WHOLE column — the gap on the
            strip plus the ruler band above it: hovering anywhere in it shows
            the hint (gap highlight, ⟲ badge emphasis, tooltip) and clicking
            anywhere in it restores the cut. The ⟲ badge's midline sits on
            the ruler's time-label line (h-2.5 = the 10px label row), which
            centers it in the whole area above the strip — the transport
            row's top padding included — without crowding the drag grips at
            the gap's edges. */}
        {liveCuts.map((cut, index) => {
          // EVERY cut gets the treatment, trims included — a trimmed head or
          // tail is just an edge-touching cutout. Except the one being
          // trim-dragged: its gap tracks the live boundary and the stale
          // column would lag it, so it sits the drag out.
          if (
            drag?.kind === "trim" &&
            cuts[index].kind === (drag.edge === "start" ? "start" : "end")
          ) {
            return null;
          }
          return (
            <Tooltip
              key={`cut-restore-${cuts[index].fromMs}-${cuts[index].toMs}`}
            >
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label="Restore this cut"
                  className="group absolute inset-y-0 z-10 cursor-pointer"
                  style={{
                    left: leftPct(cut.fromMs),
                    width: widthPct(cut.fromMs, cut.toMs),
                  }}
                  onClick={() => onRestore(index)}
                >
                  <span className="absolute inset-x-0 bottom-0 h-8 rounded-md border border-destructive/50 bg-destructive/10 opacity-0 transition-opacity group-hover:opacity-100" />
                  <span className="absolute inset-x-0 top-0 flex h-2.5 items-center justify-center">
                    <span className="flex size-5 items-center justify-center rounded-full border bg-background text-muted-foreground shadow-sm transition-colors group-hover:text-foreground">
                      <Undo2 className="size-3" />
                    </span>
                  </span>
                </button>
              </TooltipTrigger>
              <TooltipContent className="text-xs">
                Restore this cut
              </TooltipContent>
            </Tooltip>
          );
        })}
        {/* A released selection asks its question right where it was made:
            cut the stretch, or dismiss it. (There is no standing Cut button —
            the tour teaches the gesture.) Same band and midline as the
            restore badges. */}
        {selection && !drag && (
          <div
            className="absolute top-0 z-30 flex h-2.5 -translate-x-1/2 items-center gap-1"
            style={{ left: leftPct((selection.fromMs + selection.toMs) / 2) }}
          >
            {/* Cut sits on the RIGHT: selections are mostly drawn left to
                right, leaving the cursor nearest that side — the primary
                action should be the closest one. */}
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label="Dismiss the selection"
                  // A definite border: the default one is too faint to read
                  // against the ruler band this sits on.
                  className="flex size-5 items-center justify-center rounded-full border border-muted-foreground/60 bg-background text-muted-foreground shadow-sm hover:border-foreground hover:text-foreground"
                  onClick={() => setSelection(null)}
                >
                  <X className="size-3" />
                </button>
              </TooltipTrigger>
              <TooltipContent className="text-xs">Dismiss</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label="Cut the selection"
                  className="flex size-5 items-center justify-center rounded-full border border-destructive/50 bg-background text-destructive shadow-sm hover:bg-destructive/10 disabled:opacity-50"
                  disabled={saving}
                  onClick={() => {
                    onCut(selection);
                    setSelection(null);
                  }}
                >
                  <Scissors className="size-3" />
                </button>
              </TooltipTrigger>
              <TooltipContent className="text-xs">Cut</TooltipContent>
            </Tooltip>
          </div>
        )}
        {/* Cursor pin: where a click would land playback — the playhead's
            quiet grey twin, following the pointer over the strip and ruler
            band. Hidden while a drag owns the pointer. */}
        {hoverMs !== null && !drag && (
          <div
            className="pointer-events-none absolute top-3 bottom-0 z-10 flex -translate-x-1/2 flex-col items-center"
            style={{ left: leftPct(Math.min(hoverMs, durationMs)) }}
          >
            <div className="h-0 w-0 border-x-[5px] border-t-[6px] border-x-transparent border-t-muted-foreground/60" />
            <div className="w-0.5 flex-1 rounded-full bg-muted-foreground/40" />
          </div>
        )}
        {/* Current-time pin: flag tucked between the ruler's ticks and the
            strip, line through the strip only — the surface's one standout
            color. It must never reach the ruler labels or spill past the
            strip into neighboring UI. */}
        <div
          className="pointer-events-none absolute top-3 bottom-0 z-20 flex -translate-x-1/2 flex-col items-center"
          style={{ left: leftPct(playheadClampedMs) }}
        >
          <div className="h-0 w-0 border-x-[5px] border-t-[6px] border-x-transparent border-t-destructive" />
          <div className="w-0.5 flex-1 rounded-full bg-destructive/90" />
        </div>
        {/* Export-limit mark: where played time crosses the allowed length —
            everything right of it is what the video export and the gallery
            refuse to take. One click trims the edit down to exactly this
            point (the same end trim the bracket drag makes, one undoable
            step). The mark's position is played time mapped onto the full
            strip, so it moves as cuts change — on COMMITTED cuts only, so it
            holds still through a drag (blinking out mid-gesture uncovered
            the ruler's own 0:30 label underneath and read as a glitch).
            Deliberately QUIET: a badge in the ruler band only — muted until
            hovered, no line through the strip (that would read as a second
            playhead), and no hit area over the strip itself, where an end
            bracket dragged to ~30s must stay grabbable. */}
        {exportLimit !== null && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label="Trim to the maximum allowed length"
                className="group absolute top-0 z-30 flex h-2.5 -translate-x-1/2 cursor-pointer items-center"
                style={{ left: leftPct(exportLimit) }}
                disabled={saving}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={onTrimToLimit}
              >
                <span className="flex h-4 items-center gap-0.5 rounded-full border bg-background px-1 font-medium text-[10px] text-muted-foreground shadow-sm transition-colors group-hover:border-destructive/50 group-hover:text-destructive">
                  <Scissors className="size-2.5" />
                  {MAX_EXPORT_SECONDS}s
                </span>
              </button>
            </TooltipTrigger>
            <TooltipContent className="text-xs">
              Trim to the max allowed length ({MAX_EXPORT_SECONDS}s)
            </TooltipContent>
          </Tooltip>
        )}
        {demo && <TimelineTourSamples gesture={demo} />}
      </div>
    </>
  );
}

/**
 * One shared drag pill for every remove-boundary on the strip — the whole
 * timeline's trim ends and each cut's edges look and feel identical. The hit
 * area hangs off the boundary INTO the kept section (`keptSide`), with the
 * pill floating just inside that section's edge, so no grip ever overhangs a
 * removed gap or the strip's rounded ends.
 */
/**
 * The tour's timeline stop, illustrated: one worked example of each gesture
 * the hint names — a pending selection with its Cut/Dismiss pair, a cut gap
 * with its restore badge, and a kept section with its drag grips — drawn
 * over the strip in the real components' own styling. Non-interactive, and
 * nothing here touches the recording or the editor's state.
 */
/**
 * The OS "grabbing" mouse cursor, drawn as a solid closed hand — a white
 * silhouette with a dark outline, like the system cursor on macOS and
 * Windows. (An outline icon filled white reads as a blob at this size, so the
 * shape is authored as one filled path.)
 */
function GrabbingCursorGlyph({
  className,
  style,
}: {
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <svg
      viewBox="4 2 24 20"
      className={className}
      style={style}
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M8 6a2 2 0 0 1 4 0a2 2 0 0 1 4 0a2 2 0 0 1 4 0a2 2 0 0 1 4 0v6a6 6 0 0 1-6 6h-4a6 6 0 0 1-6-6z"
        fill="#fff"
        stroke="#111"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function TimelineTourSamples({ gesture }: { gesture: TimelineTourGesture }) {
  // One fixed stretch of strip for all three stops — the head of the
  // timeline, where the samples sit clear of the card above them; only the
  // illustration inside it changes, so nothing jumps between stops.
  const SPAN = { left: "3%", width: "22%" };
  const CENTER = "14%";
  const sample = "pointer-events-none absolute bottom-0 h-8";
  const badgeBand =
    "pointer-events-none absolute top-0 flex h-2.5 -translate-x-1/2 items-center gap-1";
  return (
    <div className="pointer-events-none absolute inset-0 z-30">
      {/* What the tour spotlights and anchors its card to: the stretch every
          sample fills, rather than the whole timeline. */}
      <div
        data-tour="timeline-sample"
        className="pointer-events-none absolute inset-y-0"
        style={SPAN}
      />
      {gesture === "cut" && (
        <>
          <div
            className={cn(
              sample,
              "border-x border-destructive bg-destructive/25",
            )}
            style={SPAN}
          />
          <div className={badgeBand} style={{ left: CENTER }}>
            <span className="flex size-5 items-center justify-center rounded-full border border-muted-foreground/60 bg-background text-muted-foreground shadow-sm">
              <X className="size-3" />
            </span>
            <span className="flex size-5 items-center justify-center rounded-full border border-destructive/50 bg-background text-destructive shadow-sm">
              <Scissors className="size-3" />
            </span>
          </div>
        </>
      )}
      {gesture === "restore" && (
        <>
          {/* A cutout is bare tray; the tint is the highlight it wears when
              its restore control is under the pointer. */}
          <div className={cn(sample, "rounded-md bg-muted")} style={SPAN} />
          <div
            className={cn(
              sample,
              "rounded-md border border-destructive/50 bg-destructive/10",
            )}
            style={SPAN}
          />
          <div className={badgeBand} style={{ left: CENTER }}>
            <span className="flex size-5 items-center justify-center rounded-full border border-muted-foreground/60 bg-background text-muted-foreground shadow-sm">
              <Undo2 className="size-3" />
            </span>
          </div>
        </>
      )}
      {gesture === "resize" && (
        <>
          <div
            className={cn(
              sample,
              "overflow-hidden rounded-md border border-primary/50 bg-primary/10",
            )}
            style={SPAN}
          >
            <div className="absolute left-1 top-1/2 h-5 w-1.5 -translate-y-1/2 rounded-full bg-primary" />
            <div className="absolute right-1 top-1/2 h-5 w-1.5 -translate-y-1/2 rounded-full bg-primary" />
          </div>
          {/* The grab cursor you get on a real handle, centered ON that
              handle: the grip pill sits 4px inside the section's edge and is
              6px wide, and the strip's mid-line is 16px above its bottom. */}
          <GrabbingCursorGlyph
            className="pointer-events-none absolute h-5 w-5 -translate-x-1/2 translate-y-1/2"
            style={{
              // The section's END handle — the one nearest the hint card.
              left: `calc(${SPAN.left} + ${SPAN.width} - 7px)`,
              bottom: 16,
            }}
          />
        </>
      )}
    </div>
  );
}

function TimelineGrip({
  atMs,
  keptSide,
  leftPct,
  onPointerDown,
}: {
  atMs: number;
  keptSide: "left" | "right";
  leftPct: (ms: number) => string;
  onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void;
}) {
  // No tooltip: the hand cursor alone says "draggable" — a popover here only
  // muddied the drag-vs-click double duty.
  return (
    <div
      className={cn(
        "group absolute inset-y-0 z-10 w-4 cursor-grab active:cursor-grabbing",
        keptSide === "left" && "-translate-x-full",
      )}
      style={{ left: leftPct(atMs) }}
      onPointerDown={onPointerDown}
    >
      <div
        className={cn(
          "absolute top-1/2 h-5 w-1.5 -translate-y-1/2 rounded-full bg-primary/80 group-hover:bg-primary",
          keptSide === "left" ? "right-1" : "left-1",
        )}
      />
    </div>
  );
}

/** Nice ruler label step: the largest round unit giving at most 8 intervals. */
function rulerStepMs(durationMs: number): number {
  const steps = [
    1_000, 2_000, 5_000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000,
    600_000,
  ];
  for (const step of steps) {
    if (durationMs / step <= 8) return step;
  }
  return 1_800_000;
}

/**
 * Ruler above the timeline strip: evenly spaced minor ticks with labeled
 * (rounded-down) major marks, in the strip's own percentage space so every
 * mark stays glued to the moment it names at any width.
 */
function TimelineRuler({ durationMs }: { durationMs: number }) {
  const stepMs = rulerStepMs(durationMs);
  const minorMs = stepMs / 5;
  const ticks: { atMs: number; major: boolean }[] = [];
  for (let atMs = 0; atMs <= durationMs; atMs += minorMs) {
    ticks.push({ atMs, major: atMs % stepMs === 0 });
  }
  return (
    <div className="pointer-events-none relative h-4 select-none">
      {ticks.map((tick) => (
        <div
          key={tick.atMs}
          className="absolute inset-y-0"
          style={{ left: `${(tick.atMs / durationMs) * 100}%` }}
        >
          <div
            className={cn(
              "absolute bottom-0 left-0 w-px",
              tick.major
                ? "h-[5px] bg-muted-foreground/60"
                : "h-[3px] bg-muted-foreground/30",
            )}
          />
          {tick.major && (
            <span
              className={cn(
                "absolute top-0 left-0 whitespace-nowrap text-[10px] leading-none text-muted-foreground tabular-nums",
                tick.atMs > 0 && "-translate-x-1/2",
              )}
            >
              {formatMs(tick.atMs)}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

/** The in-flight signal shown in the app frame's top bar during replay. */
function ReplayActivityChip({ activity }: { activity: ReplayActivity }) {
  if (!activity) return null;
  return (
    <div className="mr-1 flex items-center gap-1.5 rounded-full border bg-background/80 px-2.5 py-1 text-[11px] font-medium text-muted-foreground">
      <span className="size-1.5 animate-pulse rounded-full bg-blue-500" />
      <span className="max-w-[180px] truncate font-mono">{activity.name}</span>
    </div>
  );
}

/**
 * The recorded conversation, rendered with the same message and tool primitives
 * as live chat. The whole session — the pre-recording history and the recording
 * window alike — animates in as the clock passes each message.
 */
function ReplayChatPane({
  transcript,
  clockMs,
  durationMs,
  paused,
  filming,
  pending,
  promptEditor,
  showEditHint,
  preview,
  onEnterEdit,
}: {
  transcript: TranscriptMessage[];
  clockMs: number;
  /** The playback's end. The reveal schedule must fit inside it — see below. */
  durationMs: number;
  /** Playback is not running: every animation in the pane holds its frame. */
  paused: boolean;
  /** A video export is running — hover affordances must stay out of the film. */
  filming?: boolean;
  pending: ChatPending;
  promptEditor: PromptBubbleEditor;
  /** Tour spotlight: hover can't reach under the tour overlay, so the stop
   * forces the edit affordance visible while it points here. */
  showEditHint?: boolean;
  /** Show the conversation's FINAL state instead of the clock's slice — an
   * empty pane says nothing about what this recording contains. */
  preview?: boolean;
  onEnterEdit: () => void;
}) {
  const { schedule, revealScale } = useMemo(
    () => revealSchedule(transcript, durationMs),
    [transcript, durationMs],
  );
  const visible = useMemo(
    () =>
      preview
        ? transcript
        : transcript.filter(
            (message) =>
              (schedule.get(message.id)?.start ?? message.atMs) <= clockMs,
          ),
    [transcript, schedule, clockMs, preview],
  );
  // The opening ask carries the one-shot prompt controls — the consolidated
  // prompt stands in for the first user message, so they are the same bubble.
  const firstUserId = useMemo(
    () => transcript.find((message) => message.role === "user")?.id,
    [transcript],
  );
  // A preview is a still of the finished conversation: no typing, no
  // thinking, nothing mid-stream.
  const livePending = preview ? null : pending;
  const composerText =
    livePending?.kind === "typing" || livePending?.kind === "sending"
      ? livePending.text
      : null;
  const isSending = livePending?.kind === "sending";

  // Reveal the newest assistant message part by part, in order, like live chat:
  // text streams in char by char and each tool marker lands after it. Only the
  // last visible message can be mid-reveal; a newer one means it's complete.
  // Whichever message the clock is inside is the one mid-reveal — not simply
  // the newest one on screen, which is what let a burst render complete.
  const reveal = useMemo(() => {
    if (preview) return null;
    for (const message of transcript) {
      if (message.role !== "assistant") continue;
      const slot = schedule.get(message.id);
      if (!slot || clockMs < slot.start || clockMs >= slot.end) continue;
      const elapsed = clockMs - slot.start;
      let cumulative = 0;
      for (let i = 0; i < message.parts.length; i++) {
        const part = message.parts[i];
        const partMs = partRevealMs(part) * revealScale;
        if (elapsed < cumulative + partMs) {
          const streamChars =
            part.type === "text"
              ? Math.max(
                  1,
                  Math.floor(
                    part.text.length * ((elapsed - cumulative) / partMs),
                  ),
                )
              : undefined;
          return { id: message.id, count: i + 1, streamChars };
        }
        cumulative += partMs;
      }
    }
    return null;
  }, [transcript, schedule, revealScale, clockMs, preview]);

  return (
    <div
      className={cn(
        "group/pane relative isolate flex min-h-0 min-w-0 flex-1 flex-col border-r bg-background select-none [&_*]:pointer-events-none",
        // A message caught mid-reveal must freeze with the rest of the replay:
        // its stream is clock-driven and stops on its own, but the CSS enter
        // animations and pulses around it would otherwise play on. Never while
        // filming, which is paused for every frame: freezing there pins each
        // message's enter animation at its first frame — fully transparent —
        // and the exported video loses the chat entirely.
        paused && !filming && "animations-paused",
      )}
      data-tour="chat"
    >
      {/* The hover tint, painted behind the conversation exactly like the
          description's — a negative layer inside this pane's own stacking
          context, so it washes the surface without covering the messages. */}
      {promptEditor.draft === null && !filming && (
        <span
          className={cn(
            "pointer-events-none absolute inset-0 -z-10 bg-muted opacity-0 transition-opacity group-hover/pane:opacity-100",
            showEditHint && "opacity-100",
          )}
        />
      )}
      {/* The whole replayed chat is one edit affordance: hovering names the
          action, clicking opens the chat editor. (Hidden while the prompt
          editor is open — that IS editing.) */}
      {promptEditor.draft === null && !filming && (
        <button
          type="button"
          aria-label="Edit the replayed chat"
          className="!pointer-events-auto absolute inset-0 z-20 cursor-pointer"
          onClick={onEnterEdit}
        >
          {/* Same square overlay chip as the description's hint. */}
          <span
            className={cn(
              EDIT_HINT_CHIP,
              "size-10 group-hover/pane:opacity-100",
              showEditHint && "opacity-100",
            )}
          >
            <Pencil className="size-4" />
          </span>
        </button>
      )}
      <Conversation className="flex-1">
        <ConversationContent>
          {/* The editor card lives at the pane level, not inside the bubble:
              an open draft must survive seeks that hide the bubble itself. */}
          {promptEditor.draft !== null && (
            <ReplayPromptEditorCard editor={promptEditor} />
          )}
          {transcript.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No chat activity in this recording.
            </p>
          ) : (
            visible.map((message) => (
              <ReplayChatMessage
                key={message.id}
                message={message}
                promptEditor={
                  message.id === firstUserId ? promptEditor : undefined
                }
                // The whole session animates, so every user message types and
                // sends in as the clock reaches it.
                animateIn={!preview && message.role === "user"}
                reveal={reveal?.id === message.id ? reveal : undefined}
              />
            ))
          )}
          {livePending?.kind === "thinking" && (
            <div className="mb-4 flex items-center gap-2 text-muted-foreground">
              <Loader size={16} />
              <span className="text-sm">Thinking…</span>
            </div>
          )}
        </ConversationContent>
      </Conversation>
      <ReplayComposer text={composerText} sending={isSending} />
    </div>
  );
}

/**
 * The chat editor: the captured conversation with every presentation edit
 * laid bare, diff-style. The AI consolidation renders as an ADDED bubble
 * (primary ring) above the struck-through originals it replaces; viewer-
 * removed messages strike through with an in-place restore; manual user-text
 * overrides wear their own (amber) mark so they never read as AI output.
 * Everything commits through the shared undo history; the capture itself
 * never changes.
 */
function ReplayChatEditPane({
  transcript,
  enhancement,
  chat,
  saving,
  promptEditor,
  responseEditor,
  forceEnhancementOff,
  highlightFirstMessage,
  onToggleEnhancement,
  onRemove,
  onRestore,
  onDone,
}: {
  transcript: TranscriptMessage[];
  enhancement: RecordingEnhancement | null;
  chat: RecordingChatEdits | undefined;
  saving: boolean;
  promptEditor: PromptBubbleEditor;
  /** The closing AI response's inline editor — same contract as the prompt's. */
  responseEditor: PromptBubbleEditor;
  /** Tour demo: render the original-chat view without touching the stored
   * toggle state. */
  forceEnhancementOff?: boolean;
  /** Tour demo: reveal the first card's edit/delete affordances (hover can't
   * reach under the tour overlay). */
  highlightFirstMessage?: boolean;
  onToggleEnhancement: () => void;
  onRemove: (ids: string[]) => void;
  onRestore: (ids: string[]) => void;
  onDone: () => void;
}) {
  const removedIds = useMemo(
    () => new Set(chat?.removedMessageIds ?? []),
    [chat?.removedMessageIds],
  );
  const overrides = useMemo(
    () =>
      new Map((chat?.editedMessages ?? []).map((edit) => [edit.id, edit.text])),
    [chat?.editedMessages],
  );
  // The card the tour points at: the chat's very first message (the tour
  // scrolls it into view), which is the opening ask.
  // "Edit or delete any chat message" is about prose — the first user ask or
  // agent reply. Anchoring at transcript[0] pointed the card at whatever came
  // first, which is usually captured tool activity that carries no controls
  // at all.
  const tourMessageId = transcript.find(hasEditableProse)?.id;
  const hasPrompt = !!enhancement?.prompt.trim();
  const enhancementOn =
    hasPrompt && !chat?.enhancementDisabled && !forceEnhancementOff;
  const firstUserId = transcript.find((message) => message.role === "user")?.id;

  return (
    <TooltipProvider delayDuration={300}>
      <div
        className="flex min-h-0 min-w-0 flex-1 flex-col border-r bg-background"
        data-tour="chat"
      >
        <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
          {hasPrompt ? (
            // Off replays the original conversation; on replays the
            // AI-consolidated one. Purely presentational, so flipping it
            // back and forth loses nothing.
            <span
              className="flex items-center gap-1.5 text-xs text-muted-foreground"
              data-tour="chat-toggle"
            >
              <Sparkles className="size-3" />
              AI-enhanced
              <Switch
                aria-label="AI-enhanced chat"
                checked={enhancementOn}
                disabled={saving}
                onCheckedChange={onToggleEnhancement}
              />
            </span>
          ) : (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 gap-1 text-xs"
              disabled={promptEditor.generating || saving}
              onClick={promptEditor.regenerate}
            >
              {promptEditor.generating ? (
                <Loader size={12} />
              ) : (
                <Sparkles className="size-3" />
              )}
              {promptEditor.generating ? "Drafting…" : "Draft AI prompt"}
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            className="ml-auto h-7 px-3 text-xs"
            onClick={onDone}
          >
            Save
          </Button>
        </div>
        <Conversation className="flex-1">
          <ConversationContent>
            {transcript.map((message) => (
              <Fragment key={message.id}>
                {message.id === firstUserId &&
                  enhancementOn &&
                  (promptEditor.draft !== null ? (
                    <ReplayPromptEditorCard editor={promptEditor} />
                  ) : (
                    <ReplayAiPromptBubble
                      prompt={enhancement?.prompt ?? ""}
                      promptEditor={promptEditor}
                    />
                  ))}
                <ReplayEditableRow
                  message={message}
                  // With the AI version replaying, the captured messages are
                  // not what plays — editing them there means nothing. Turn
                  // the toggle off to edit the original chat.
                  controlsHidden={enhancementOn}
                  showHints={
                    highlightFirstMessage && message.id === tourMessageId
                  }
                  folded={enhancementOn && message.role === "user"}
                  proseFolded={enhancementOn && message.role === "assistant"}
                  removed={removedIds.has(message.id)}
                  removedIds={removedIds}
                  overrideText={overrides.get(message.id)}
                  saving={saving}
                  onRemove={onRemove}
                  onRestore={onRestore}
                />
              </Fragment>
            ))}
            {enhancementOn &&
              (responseEditor.draft !== null ? (
                <ReplayPromptEditorCard
                  editor={responseEditor}
                  from="assistant"
                />
              ) : (
                <ReplayAiResponseBubble
                  response={
                    enhancement?.response?.trim() || FALLBACK_ENHANCED_RESPONSE
                  }
                  responseEditor={responseEditor}
                />
              ))}
          </ConversationContent>
        </Conversation>
      </div>
    </TooltipProvider>
  );
}

/**
 * The closing AI response as an ADDED assistant bubble in the editor — like
 * the AI prompt it belongs to the enhancement layer (toggled and regenerated
 * with it), and like every agent message its text is never hand-edited.
 */
function ReplayAiResponseBubble({
  response,
  responseEditor,
}: {
  response: string;
  responseEditor: PromptBubbleEditor;
}) {
  return (
    <div>
      <div className="mb-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
        {responseEditor.generating ? (
          <Loader size={12} />
        ) : (
          <Sparkles className="size-3" />
        )}
        AI-generated response
      </div>
      <Message from="assistant" className="group/row">
        <MessageContent className="relative ring-2 ring-primary/50">
          {/* The bubble itself is the edit control — same as the AI prompt,
              the description and every captured message. */}
          <button
            type="button"
            aria-label="Edit the AI response"
            className="group/msg absolute inset-0 z-10 cursor-pointer rounded-[inherit]"
            disabled={responseEditor.saving || responseEditor.generating}
            onClick={responseEditor.start}
          >
            <span
              className={cn(
                EDIT_HINT_CHIP,
                "size-10 group-hover/msg:opacity-100",
              )}
            >
              <Pencil className="size-4" />
            </span>
          </button>
          <div className="whitespace-pre-wrap break-words">
            <RedactedText text={response} />
          </div>
        </MessageContent>
      </Message>
    </div>
  );
}

/**
 * A message's one corner action, in the bottom-right INSIDE its box (pass
 * `className="static …"` to sit inline instead, as the tool-pill rows do).
 * Remove appears on row hover; restore takes the very same spot on a removed
 * message and stays visible, so the way back is where the way out was. The
 * button must stay within the box's bounds: the bubble is `overflow-x-auto`,
 * so anything hanging outside it grows scrollbars instead of overhanging.
 */
function MessageCornerAction({
  action,
  saving,
  showHints,
  className,
  onClick,
}: {
  action: "remove" | "restore";
  saving: boolean;
  showHints?: boolean;
  className?: string;
  onClick: () => void;
}) {
  const removing = action === "remove";
  return (
    <button
      type="button"
      aria-label={removing ? "Remove from the replay" : "Restore message"}
      className={cn(
        // Same footprint as the edit chip, and translucent like it: both read
        // as overlays you can see the message text through.
        "absolute bottom-1 right-1 z-20 flex size-10 items-center justify-center rounded-md shadow-sm transition-all disabled:opacity-50",
        removing
          ? "bg-destructive/20 text-destructive opacity-0 hover:bg-destructive/35 focus-visible:opacity-100 group-hover/block:opacity-100 group-hover/row:opacity-100"
          : "border border-border/50 bg-background/70 text-foreground hover:bg-background",
        removing && showHints && "opacity-100",
        className,
      )}
      disabled={saving}
      onClick={onClick}
    >
      {removing ? <Trash2 className="size-4" /> : <Undo2 className="size-4" />}
    </button>
  );
}

/**
 * Whether a message renders anything at all: prose with content, or tool
 * activity. A capture can carry messages that render to nothing — an empty
 * user turn, or an assistant turn whose only text part is whitespace.
 */
function hasRenderableContent(message: TranscriptMessage): boolean {
  // A user turn renders its prose and nothing else, so a non-text part (an
  // attachment, say) does NOT make it visible.
  if (message.role === "user") return transcriptText(message).trim().length > 0;
  return message.parts.some((part) =>
    part.type === "text" ? part.text.trim().length > 0 : isPillPart(part),
  );
}

/**
 * Whether a message carries prose the editor can act on — a user ask or an
 * agent reply. Captured skill and tool activity is replayed as-is and has no
 * controls, so it is never what an edit affordance should point at.
 */
function hasEditableProse(message: TranscriptMessage): boolean {
  return message.role === "user"
    ? transcriptText(message).trim().length > 0
    : message.parts.some(
        (part) => part.type === "text" && part.text.trim().length > 0,
      );
}

/** Whether a non-text part actually draws a tool pill. */
function isPillPart(part: TranscriptMessage["parts"][number]): boolean {
  return part.type !== "text" && typeof part.name === "string" && !!part.name;
}

/** Whether a captured message carries any prose (text parts with content). */
function hasProse(message: TranscriptMessage): boolean {
  return message.parts.some(
    (part) => part.type === "text" && part.text.trim().length > 0,
  );
}

/**
 * The consolidated AI prompt as an ADDED bubble — primary ring, provenance
 * tag, and the prompt's edit/regenerate controls. While the enhancement is
 * on it stands in for the struck-through original user messages below it.
 */
function ReplayAiPromptBubble({
  prompt,
  promptEditor,
}: {
  prompt: string;
  promptEditor: PromptBubbleEditor;
}) {
  return (
    <Message from="user" className="group/row">
      <MessageContent className="relative ring-2 ring-primary/50">
        <div className="mb-1 flex items-center gap-1.5 text-[11px] opacity-80">
          {promptEditor.generating ? (
            <Loader size={12} />
          ) : (
            <Sparkles className="size-3" />
          )}
          AI-generated prompt
        </div>
        {/* The bubble itself is the edit control, like the description and
            every captured message: click it, edit and regenerate in the card
            that replaces it. */}
        <button
          type="button"
          aria-label="Edit the AI prompt"
          className="group/msg absolute inset-0 z-10 cursor-pointer rounded-[inherit]"
          disabled={promptEditor.saving || promptEditor.generating}
          onClick={promptEditor.start}
        >
          <span
            className={cn(
              EDIT_HINT_CHIP,
              "size-10 group-hover/msg:opacity-100",
            )}
          >
            <Pencil className="size-4" />
          </span>
        </button>
        <div className="whitespace-pre-wrap break-words">
          <RedactedText text={prompt} />
        </div>
      </MessageContent>
    </Message>
  );
}
/**
 * One captured message in the chat editor. Captured text is never rewritten —
 * it is what the session actually said — so a row offers exactly one thing:
 * take it out of the replay, or put it back. An agent turn replays as several
 * boxes (prose bubbles, tool rows) and each is removable on its own; a user
 * message goes as a whole. Rows fold away (dim, struck through) when the AI
 * version stands in for them.
 */
function ReplayEditableRow({
  message,
  controlsHidden,
  showHints,
  folded,
  proseFolded,
  removed,
  removedIds,
  overrideText,
  saving,
  onRemove,
  onRestore,
}: {
  message: TranscriptMessage;
  /** The AI version is replaying: this captured message is not part of that
   * replay, so it carries no delete or restore controls. */
  controlsHidden?: boolean;
  /** Tour demo: show this card's hover affordances without a real hover. */
  showHints?: boolean;
  folded: boolean;
  /** Assistant prose folds into the closing AI response; tools replay as-is. */
  proseFolded: boolean;
  /** The whole message is out of the replay. */
  removed: boolean;
  /** Every removed id, so each part can show its own state. */
  removedIds: Set<string>;
  overrideText: string | undefined;
  saving: boolean;
  onRemove: (ids: string[]) => void;
  onRestore: (ids: string[]) => void;
}) {
  const dimmed = folded || removed;

  if (message.role === "user") {
    const text = overrideText ?? transcriptText(message);
    // Trimmed: a whitespace-only turn is a non-empty STRING but renders as an
    // empty bubble carrying nothing but a delete button.
    if (!text.trim()) return null;
    return (
      <Message from="user" className={cn("group/row", dimmed && "opacity-60")}>
        <MessageContent
          data-tour={showHints ? "chat-message" : undefined}
          className="relative"
        >
          {folded && (
            <div className="mb-1 flex items-center gap-1.5 text-[11px] opacity-80">
              <Sparkles className="size-3" />
              Replaced by the AI prompt
            </div>
          )}
          {/* The control is laid out, not overlaid: it takes the end of the
              last line, so a one-liner puts it beside the text and a wrapped
              message puts it in the bottom-right corner — neither ever has
              text running underneath it. */}
          <div className="flex items-end gap-2">
            <div
              className={cn(
                "min-w-0 flex-1 whitespace-pre-wrap break-words",
                dimmed && "line-through",
              )}
            >
              <RedactedText text={text} />
            </div>
            {!controlsHidden && (!dimmed || removed) && (
              <MessageCornerAction
                action={removed ? "restore" : "remove"}
                saving={saving}
                showHints={showHints}
                className="static shrink-0"
                onClick={() =>
                  removed ? onRestore([message.id]) : onRemove([message.id])
                }
              />
            )}
          </div>
        </MessageContent>
      </Message>
    );
  }

  // An agent turn: each box carries its own corner control, so one tool row or
  // a single prose bubble can leave the replay without the rest of the turn.
  const blocks = groupParts(message.parts);
  // Every block empty (whitespace-only prose, no tool activity) would still
  // paint the wrapper — an empty bubble carrying nothing but a delete button.
  if (!hasRenderableContent(message)) return null;
  return (
    <div
      data-tour={showHints ? "chat-message" : undefined}
      className={cn("relative mb-1", dimmed && "opacity-60")}
    >
      {!removed && proseFolded && hasProse(message) && (
        <div className="mb-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <Sparkles className="size-3" />
          Text replaced by the AI response
        </div>
      )}
      {blocks.map((block) => {
        const partIds =
          block.kind === "text"
            ? [partEditId(message.id, block.index)]
            : block.parts.map((_, offset) =>
                partEditId(message.id, block.startIndex + offset),
              );
        const blockRemoved =
          removed || partIds.every((id) => removedIds.has(id));
        const struck = blockRemoved || (proseFolded && !removed);
        const onClick = () =>
          blockRemoved ? onRestore(partIds) : onRemove(partIds);
        if (block.kind === "text") {
          if (!block.text.trim()) return null;
          return (
            <Message
              key={`text-${block.index}`}
              from="assistant"
              className={cn("group/block", struck && "opacity-60")}
            >
              <MessageContent
                className={cn("relative", struck && "line-through")}
              >
                <div className="flex items-end gap-2">
                  <div className="min-w-0 flex-1">
                    <Response>{block.text}</Response>
                  </div>
                  {!controlsHidden && (
                    <MessageCornerAction
                      action={blockRemoved ? "restore" : "remove"}
                      saving={saving || removed}
                      showHints={showHints}
                      className="static shrink-0"
                      onClick={onClick}
                    />
                  )}
                </div>
              </MessageContent>
            </Message>
          );
        }
        // Captured skill and tool activity replays exactly as it happened: it
        // is neither editable nor deletable, so the row carries no controls
        // and needs no gutter reserved for them. A block with no drawable pill
        // renders nothing at all.
        if (!block.parts.some(isPillPart)) return null;
        return (
          <div
            key={`tools-${block.startIndex}`}
            className={cn(
              "relative mb-4 flex flex-wrap items-center gap-1.5",
              blockRemoved && "line-through opacity-60",
            )}
          >
            {block.parts.filter(isPillPart).map((part, offset) => (
              <ReplayToolPill
                // biome-ignore lint/suspicious/noArrayIndexKey: parts are fixed within a message
                key={`${block.startIndex}-${offset}`}
                part={part}
                // The editor is a still, not a replay: an enter animation here
                // is held at its first frame while playback is paused, which
                // renders the pill invisible.
                animate={false}
              />
            ))}
          </div>
        );
      })}
    </div>
  );
}

/**
 * A read-only stand-in for the chat composer. It stays inert, but when the
 * recording leads up to a user message it replays that message being typed in,
 * then briefly presses the send button as the message posts — the same signals
 * the live composer gives while a user writes and sends.
 */
function ReplayComposer({
  text,
  sending,
}: {
  text: string | null;
  sending: boolean;
}) {
  const active = text != null;
  return (
    <div className="shrink-0 p-3">
      {/* Mirrors the real chat composer: a bordered input group with the message
          area on top (placeholder anchored top-left) and the submit button in a
          toolbar row below. Inert — it only reflects the recorded typing. */}
      <div className="flex flex-col gap-1 rounded-md border border-input px-4 py-3 dark:bg-input/30">
        <div className="min-h-8 whitespace-pre-wrap break-words text-sm leading-6">
          {active ? (
            <>
              <span>
                <RedactedText text={text} />
              </span>
              {/* The caret blinks while typing; it's gone the instant we send. */}
              {!sending && (
                <span className="ml-px inline-block h-[1.05em] w-px translate-y-[0.15em] animate-pulse bg-foreground align-baseline" />
              )}
            </>
          ) : (
            // Matches the real chat composer's active-conversation placeholder.
            <span className="text-muted-foreground">Ask a follow-up...</span>
          )}
        </div>
        <div className="flex justify-end">
          <InputGroupButton
            size="icon-sm"
            variant={active ? "default" : "secondary"}
            className={cn(
              "pointer-events-none transition-transform duration-150",
              // Depress the button on send, like a real click.
              sending && "scale-90",
            )}
            tabIndex={-1}
            aria-hidden="true"
          >
            <CornerDownLeftIcon className="size-4" />
          </InputGroupButton>
        </div>
      </div>
    </div>
  );
}

type TranscriptToolPart = Extract<
  TranscriptMessage["parts"][number],
  { type: "tool" }
>;

/** Consecutive tool markers render as one row, like the live chat's tool group. */
type ReplayBlock =
  | { kind: "text"; index: number; text: string }
  | { kind: "tools"; startIndex: number; parts: TranscriptToolPart[] };

function groupParts(parts: TranscriptMessage["parts"]): ReplayBlock[] {
  const blocks: ReplayBlock[] = [];
  parts.forEach((part, index) => {
    if (part.type === "text") {
      blocks.push({ kind: "text", index, text: part.text });
      return;
    }
    const last = blocks[blocks.length - 1];
    if (last?.kind === "tools") last.parts.push(part);
    else blocks.push({ kind: "tools", startIndex: index, parts: [part] });
  });
  return blocks;
}

function ReplayChatMessage({
  message,
  reveal,
  animateIn,
  promptEditor,
}: {
  message: TranscriptMessage;
  reveal?: { count: number; streamChars?: number };
  animateIn?: boolean;
  /** Present only on the opening ask — the one-shot prompt bubble. */
  promptEditor?: PromptBubbleEditor;
}) {
  // A user message posts as one bubble; the composer already "typed" it.
  if (message.role === "user") {
    // In edit mode the pane shows the editor card in this bubble's place.
    if (promptEditor && promptEditor.draft !== null) return null;
    const text = transcriptText(message);
    if (!text) return null;
    return (
      <Message
        from="user"
        className={cn(
          animateIn && "duration-300 animate-in fade-in slide-in-from-bottom-2",
        )}
      >
        <MessageContent>
          {/* No provenance tags in the replay — it reads as a real chat.
              Provenance and editing live in the chat editor (click anywhere
              on the pane to open it). */}
          <div className="whitespace-pre-wrap break-words">
            <RedactedText text={text} />
          </div>
        </MessageContent>
      </Message>
    );
  }

  // An assistant turn reveals its parts in order — text bubbles and tool rows
  // interleaved exactly as they occurred — up to the revealed part count.
  const shown = reveal ? message.parts.slice(0, reveal.count) : message.parts;
  const lastIndex = shown.length - 1;

  return (
    <>
      {groupParts(shown).map((block) => {
        if (block.kind === "text") {
          const streaming = reveal != null && block.index === lastIndex;
          const text =
            streaming && reveal?.streamChars != null
              ? block.text.slice(0, reveal.streamChars)
              : block.text;
          if (!text.trim()) return null;
          return (
            <Message
              key={`text-${block.index}`}
              from="assistant"
              className="duration-300 animate-in fade-in"
            >
              <MessageContent>
                <Response isStreaming={streaming}>{text}</Response>
              </MessageContent>
            </Message>
          );
        }
        return (
          <div
            key={`tools-${block.startIndex}`}
            className="mb-4 flex flex-wrap items-center gap-1.5"
          >
            {block.parts.map((part, offset) => (
              <ReplayToolPill
                // biome-ignore lint/suspicious/noArrayIndexKey: parts are fixed within a message
                key={`${block.startIndex}-${offset}`}
                part={part}
              />
            ))}
          </div>
        );
      })}
    </>
  );
}

/**
 * A completed tool-call marker, reusing the live chat's pill chrome (catalog
 * icon + label + green status dot). A loaded skill reads "Skill: <name>" like
 * the chat's skill pill; every other call shows the tool's own name and icon.
 */
function ReplayToolPill({
  part,
  animate = true,
}: {
  part: TranscriptToolPart;
  /** Replay animates each pill in; a static editor list must not. */
  animate?: boolean;
}) {
  const enter = animate
    ? "shrink-0 duration-300 animate-in fade-in slide-in-from-bottom-1"
    : "shrink-0";

  if (part.name.endsWith("load_skill")) {
    return (
      <div
        className={cn(
          "inline-flex h-8 items-center gap-1.5 rounded-full border bg-background px-3",
          enter,
        )}
      >
        <span className="text-xs text-muted-foreground">Skill:</span>
        <span className="text-xs font-medium">{part.label ?? "skill"}</span>
      </div>
    );
  }

  const catalogId =
    getArchestraToolShortName(part.name) != null
      ? ARCHESTRA_MCP_CATALOG_ID
      : undefined;
  return (
    <div className={cn("pointer-events-none inline-flex", enter)}>
      <McpAppPill
        label={parseFullToolName(part.name).toolName.replace(/_/g, " ")}
        icon={<McpCatalogIcon catalogId={catalogId} size={16} />}
        state="completed"
        onClick={() => {}}
      />
    </div>
  );
}

/**
 * Shows the app exactly as it was recorded. The frame is laid out at the
 * recorded viewport in BOTH dimensions and uniformly scaled to fit the stage,
 * centered — so recorded x/y positions hold (width drives an app's reflow,
 * height drives a viewport-sized canvas), and a WebGL scene or game keeps its
 * recorded shape instead of stretching to the stage's. A recording made at the
 * canonical locked aspect (APP_RECORDING_VIEWPORT_ASPECT — the side panel's
 * shape while recording) fills the stage edge to edge, because the stage
 * column takes the recorded shape too; any other recording sits centered with
 * the surface's own background as the margin. The CSS transform is purely
 * visual and never touches the frame's coordinate space. A transparent overlay
 * makes the frame read-only — real clicks, scrolls, and keystrokes never reach
 * the app, which responds only to the replayed events.
 */
function ReplayAppStage({
  viewport,
  children,
}: {
  viewport: { width: number; height: number };
  children: React.ReactNode;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState({ scale: 1, offsetX: 0, offsetY: 0 });
  const { width: recordedWidth, height: recordedHeight } = viewport;

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => {
      // clientWidth/Height, NOT getBoundingClientRect: the rect is the
      // TRANSFORMED box, and the dialog opens with a zoom-in animation. A
      // measurement taken mid-animation would lock in a scale a few percent
      // short, and no ResizeObserver callback would ever correct it — the
      // layout size never changes, only the transform — leaving the app
      // letterboxed inside the stage for the rest of the session.
      const next = replayStageFit({
        stageWidth: el.clientWidth,
        stageHeight: el.clientHeight,
        viewport: { width: recordedWidth, height: recordedHeight },
      });
      if (next) setFit(next);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [recordedWidth, recordedHeight]);

  return (
    <div
      ref={containerRef}
      // The margins the fit leaves are the surface's own background: a tinted
      // letterbox would read as a stray border around the app rather than as
      // empty stage.
      className="relative min-h-0 min-w-0 flex-1 overflow-hidden bg-background"
    >
      <div
        className="absolute left-0 top-0 origin-top-left [&>div]:!h-full [&>div]:!w-full [&_iframe]:!h-full [&_iframe]:!max-h-none [&_iframe]:!min-h-0 [&_iframe]:!w-full"
        style={{
          width: recordedWidth,
          height: recordedHeight,
          transform: `translate(${fit.offsetX}px, ${fit.offsetY}px) scale(${fit.scale})`,
        }}
      >
        {children}
      </div>
      {/* Read-only isolation: swallows every real pointer event so the viewer
          can't drive the app. Transparent, so the replayed cursor painted
          inside the frame shows through. */}
      <div
        className="absolute inset-0 z-10"
        aria-hidden="true"
        style={{ cursor: "default" }}
      />
    </div>
  );
}

// =============================================================================
// Internal helpers
// =============================================================================

/**
 * Compress idle gaps so long waits time-lapse, and lay the whole session on one
 * animated timeline. Every timestamp that must stay a boundary — each event,
 * each MCP call's start and end, each transcript message (including the
 * pre-recording history at negative offsets), each segment — is an anchor; the
 * span between consecutive anchors is capped at MAX_IDLE_MS. The result is a
 * shorter timeline, starting a PREROLL_MS beat before the first message, where
 * dead air (an LLM generating, a slow tool, a pause between keystrokes) plays in
 * a brief beat while every real action keeps its order and its own duration.
 *
 * The viewer's cuts (from the bundle's separate `edits` object) collapse their
 * raw-time ranges to zero: nothing captured is discarded — a cut range's events
 * apply instantly at the cut point, so the app state stays in sync while the
 * playback simply skips over the removed stretch. The one exception is a cut
 * that reaches the session's end (an end trim): playback genuinely stops at
 * its start, and everything inside it is left out instead of applied — nothing
 * follows that could depend on that state, and applying it would flash the
 * trimmed tail into the final frame.
 */
export function buildPlayback(recording: PlaybackRecording): {
  events: TimelineEvent[];
  segments: PlaybackRecording["segments"];
  transcript: TranscriptMessage[];
  duration: number;
  /** Map a playback-timeline time back to raw recording time — the coordinate
   * space cuts are stored in, stable across player versions. */
  toRawMs: (playbackMs: number) => number;
  /** The forward counterpart: raw recording time → playback-timeline time. */
  toPlaybackMs: (rawMs: number) => number;
} {
  const source = finalVersionOnly(recording);
  const cuts = normalizeCuts(source.edits?.cuts ?? []);
  const anchors = new Set<number>([0, Math.max(0, source.durationMs)]);
  // When the author was actually USING the app, bounded by their first and last
  // input to it. Time inside that stretch is never compressed: it is the app
  // running — a snake crossing the board, an animation playing, a timer
  // counting — and squeezing it replays the app faster than it happened, which
  // is a false recording rather than a time-lapse.
  //
  // Only direct input marks it. The recorder is conversation-scoped and usually
  // starts before the app exists, so `mcp` and `segment` land all through the
  // BUILD — the agent scaffolding, editing and validating — which is chat, and
  // is exactly the dead waiting the time-lapse is for. Counting those as app
  // activity replayed a 19-second game as a 36-minute sit-through of its build.
  const usedAppAt: number[] = [];
  for (const event of source.events) {
    anchors.add(event.t);
    if (
      event.kind === "pointer" ||
      event.kind === "key" ||
      event.kind === "input" ||
      event.kind === "scroll"
    ) {
      usedAppAt.push(event.t);
    }
    if (event.kind === "mcp" && event.durationMs) {
      anchors.add(Math.max(0, event.t - event.durationMs));
    }
  }
  // Runs of that input, not one span from the first to the last. A single stray
  // click on the app early in the build would otherwise stretch the protected
  // stretch across the entire build and replay all of it in real time.
  const appRuns: { from: number; to: number }[] = [];
  for (const at of usedAppAt.sort((a, b) => a - b)) {
    const open = appRuns[appRuns.length - 1];
    if (open && at - open.to <= APP_ACTIVITY_BREAK_MS) open.to = at;
    else appRuns.push({ from: at, to: at });
  }
  /** Whether a gap falls inside a stretch the author spent using the app. */
  const insideAppSession = (from: number, to: number) =>
    appRuns.some((run) => to > run.from && from < run.to);
  for (const segment of source.segments) anchors.add(segment.atMs);
  // Every message anchors the timeline, the pre-recording history (negative
  // offsets) included: the whole session replays as one animated stream rather
  // than a dump of settled history followed by the recording window.
  for (const message of source.transcript) anchors.add(message.atMs);
  // The synthetic opening lead-in gets real coordinates: the raw axis extends
  // PREROLL_MS below the earliest content anchor. That makes the lead
  // addressable by stored cuts like any recorded stretch — cutting a slice of
  // the opening beat removes exactly that slice — instead of being an
  // inexpressible gap that every edit near the head would swallow whole.
  // Reduced rather than spread: `anchors` holds one entry per event, and a long
  // session's worth of them spread into `Math.min` is an argument list long
  // enough to overflow the stack.
  let contentStart = Number.POSITIVE_INFINITY;
  for (const anchor of anchors) {
    if (anchor < contentStart) contentStart = anchor;
  }
  const leadStart = contentStart - PREROLL_MS;
  anchors.add(leadStart);
  // Cut edges are anchors too, so every inter-anchor gap is either fully
  // inside a cut (contributes zero time) or fully outside it. Edges are
  // clamped onto the addressable axis.
  for (const cut of cuts) {
    anchors.add(Math.max(leadStart, cut.fromMs));
    anchors.add(Math.max(leadStart, cut.toMs));
  }

  // The last moment of real session data (cut edges excluded). A cut reaching
  // it is an end trim: everything past its start is dropped from playback.
  let rawDataEnd = Math.max(0, source.durationMs);
  for (const event of source.events) {
    rawDataEnd = Math.max(rawDataEnd, event.t);
  }
  for (const segment of source.segments) {
    rawDataEnd = Math.max(rawDataEnd, segment.atMs);
  }
  for (const message of source.transcript) {
    rawDataEnd = Math.max(rawDataEnd, message.atMs);
  }
  const tailCut = cuts.find(
    (cut) =>
      cut.toMs >= rawDataEnd - TRIM_EDGE_EPS_MS && cut.fromMs < rawDataEnd,
  );
  const withinEnd = (t: number) => !tailCut || t <= tailCut.fromMs;
  // A chat message that happened during a removed stretch must not replay AT
  // ALL — without this it would burst in at the cut's collapse instant. App
  // events are different: they DO collapse to that instant, because replaying
  // them (invisibly, in one beat) is what keeps the app's state correct after
  // the cut. Only the open interval is removed, so boundary-exact messages
  // survive.
  const inCut = (t: number) =>
    cuts.some((cut) => cut.fromMs < t && t < cut.toMs);

  const sorted = [...anchors].sort((a, b) => a - b);
  const compressedAt = new Map<number, number>();
  // The timeline opens at the lead's start, so the very first message
  // animates in after the (uncut portion of the) lead beat instead of
  // opening already sent.
  let compressed = 0;
  compressedAt.set(sorted[0] ?? 0, compressed);
  for (let i = 1; i < sorted.length; i++) {
    const gapInCut = cuts.some(
      (cut) => cut.fromMs <= sorted[i - 1] && sorted[i] <= cut.toMs,
    );
    if (!gapInCut) {
      // Inside the app session, time passes untouched at real speed. The
      // time-lapse is for the chat waiting on itself — an agent building,
      // a tool running — and never for the app.
      // Lead-in gaps never idle-compress either: the lead is a designed beat,
      // not dead air.
      const cap =
        insideAppSession(sorted[i - 1], sorted[i]) || sorted[i] <= contentStart
          ? Number.POSITIVE_INFINITY
          : MAX_IDLE_MS;
      compressed += Math.min(sorted[i] - sorted[i - 1], cap);
    }
    compressedAt.set(sorted[i], compressed);
  }
  const map = (t: number) => compressedAt.get(t) ?? t;

  // Piecewise-linear inverse of the compression, for translating the playhead
  // (playback time) into the raw recording time an edit is stored at.
  const toRawMs = (playbackMs: number): number => {
    if (sorted.length === 0) return 0;
    const at = Math.max(0, playbackMs);
    // Strictly-less matching skips zero-width (removed) spans, so an instant
    // sitting on a cut's collapse point resolves FORWARD to the start of the
    // next kept content — the moment that actually plays next — instead of to
    // the cut's own start (the end of the previous section).
    for (let i = 1; i < sorted.length; i++) {
      const c1 = compressedAt.get(sorted[i]) ?? 0;
      if (at < c1) {
        const c0 = compressedAt.get(sorted[i - 1]) ?? 0;
        const fraction = (at - c0) / (c1 - c0);
        return Math.round(
          sorted[i - 1] + fraction * (sorted[i] - sorted[i - 1]),
        );
      }
    }
    // At (or past) the end, land on the last kept moment — never the far
    // edge of a trailing trim.
    let last = sorted.length - 1;
    while (
      last > 0 &&
      (compressedAt.get(sorted[last]) ?? 0) ===
        (compressedAt.get(sorted[last - 1]) ?? 0)
    ) {
      last--;
    }
    return sorted[last];
  };

  const toPlaybackMs = (rawMs: number): number => {
    if (sorted.length === 0) return 0;
    if (rawMs <= sorted[0]) return compressedAt.get(sorted[0]) ?? 0;
    for (let i = 1; i < sorted.length; i++) {
      if (rawMs <= sorted[i]) {
        const r0 = sorted[i - 1];
        const r1 = sorted[i];
        const c0 = compressedAt.get(r0) ?? 0;
        const c1 = compressedAt.get(r1) ?? 0;
        const span = r1 - r0;
        if (span <= 0) return c1;
        return c0 + ((rawMs - r0) / span) * (c1 - c0);
      }
    }
    const lastRaw = sorted[sorted.length - 1];
    return (compressedAt.get(lastRaw) ?? 0) + (rawMs - lastRaw);
  };

  const events = source.events
    .filter((event) => withinEnd(event.t))
    .map((event) =>
      event.kind === "mcp"
        ? {
            ...event,
            t: map(event.t),
            durationMs:
              event.durationMs != null
                ? map(event.t) - map(Math.max(0, event.t - event.durationMs))
                : event.durationMs,
          }
        : { ...event, t: map(event.t) },
    );
  const keptSegments = source.segments
    .filter((segment) => withinEnd(segment.atMs))
    .map((segment) => ({ ...segment, atMs: map(segment.atMs) }));
  return {
    events,
    // An end trim reaching back past every version would otherwise leave the
    // stage with no app at all. Keep the earliest one, anchored at the head of
    // the timeline, so the app is always on screen.
    segments: keptSegments.length
      ? keptSegments
      : source.segments.slice(0, 1).map((segment) => ({ ...segment, atMs: 0 })),
    transcript: source.transcript
      .filter((message) => withinEnd(message.atMs) && !inCut(message.atMs))
      .map((message) => ({
        ...message,
        atMs: map(message.atMs),
      })),
    // The full compressed span — the last anchor, which may be a message that
    // lands just after the app interaction ends.
    duration: compressed,
    toRawMs,
    toPlaybackMs,
  };
}

/**
 * Reduce one applied range's frame paints to what actually needs decoding.
 *
 * Stills coalesce to the newest per canvas — every earlier frame would be
 * decoded only for the replay's paint-order guard to discard it. An encoded
 * video stream can't coalesce that way (a delta chunk is meaningless without
 * its predecessors), so it follows decoder semantics instead: a range that
 * crossed the stream's config event is a stream (re)build — post the config,
 * then only from the last keyframe in the range, since everything before it
 * decodes to pixels a later frame fully replaces. A range with no config is a
 * mid-stream continuation whose decoder holds state — every chunk passes
 * through in order.
 *
 * A rebuilt stream's feed ends with a synthetic `video-flush` marker. The
 * burst is fed to a FRESH decoder and then stops, and a decoder may hold
 * decoded frames until more input or a flush arrives — verified live: without
 * the flush a backward seek painted nothing, the canvas simply stayed black.
 * A continuation never flushes: flushing mid-stream would reimpose the
 * decoder's key-chunk requirement and stall playback until the next keyframe.
 *
 * @public — exported for testability
 */
export type PaintDispatch =
  | TimelineEvent
  | { kind: "video-flush"; sel: string };
export function planPaintFlush(paints: TimelineEvent[]): PaintDispatch[] {
  const stills = new Map<string, TimelineEvent>();
  const streams = new Map<
    string,
    { config: TimelineEvent | null; chunks: TimelineEvent[]; rebuilt: boolean }
  >();
  for (const event of paints) {
    if (event.kind === "canvas") {
      stills.set(event.sel, event);
      continue;
    }
    if (event.kind !== "video-config" && event.kind !== "video-chunk") continue;
    let stream = streams.get(event.sel);
    if (!stream) {
      stream = { config: null, chunks: [], rebuilt: false };
      streams.set(event.sel, stream);
    }
    if (event.kind === "video-config") {
      stream.config = event;
      stream.chunks = [];
      stream.rebuilt = true;
    } else if (stream.rebuilt && event.type === "key") {
      stream.chunks = [event];
    } else {
      stream.chunks.push(event);
    }
  }
  const flush: PaintDispatch[] = [...stills.values()];
  for (const [sel, stream] of streams) {
    if (stream.config) flush.push(stream.config);
    flush.push(...stream.chunks);
    if (stream.rebuilt && stream.chunks.length > 0) {
      flush.push({ kind: "video-flush", sel });
    }
  }
  return flush;
}

/**
 * The recording the uncut timeline strip measures: this session with its cuts
 * removed and nothing else touched.
 *
 * Only the cuts come off. Every other edit decides what the session IS rather
 * than which parts of it survive — the chat's enhancement toggle in particular
 * settles how many app versions replay, and so how long the whole thing runs.
 * Dropping the edits wholesale scaled the ruler to a different session than the
 * playhead was running on, which showed up as a ruler stuck at the enhanced
 * length while playback stretched to the full chat.
 *
 * @public — exported for testability
 */
export function uncutRecording(
  recording: PlaybackRecording,
): PlaybackRecording {
  return { ...recording, edits: { ...recording.edits, cuts: [] } };
}

/**
 * The recording as the ENHANCED replay has to see it: one app version — the
 * last one built — and only the events captured while it was on screen.
 *
 * The enhancement rewrites the chat into a single ask answered once, so the app
 * beside it has to look built once too. Left whole, the stage still swaps
 * through every intermediate version, which reads as the app rebuilding itself
 * halfway through a demo that claims it was built in one shot. The interaction
 * events are the sharper half of the problem: pointer, key, input and scroll
 * were recorded against the markup of the version that was live at the time,
 * and replaying them into the final version's DOM drives clicks and typing at
 * elements that moved or no longer exist.
 *
 * `viewport` survives the cut — it sizes the stage rather than driving the app,
 * and dropping it would replay the session at the wrong dimensions.
 *
 * Unenhanced replays are untouched: showing the real build, version by version,
 * is the whole point of them.
 */
function finalVersionOnly(recording: PlaybackRecording): PlaybackRecording {
  const enhancementOn =
    !!recording.enhancement?.prompt.trim() &&
    !recording.edits?.chat?.enhancementDisabled;
  const last = recording.segments[recording.segments.length - 1];
  if (!enhancementOn || !last || recording.segments.length < 2)
    return recording;
  return {
    ...recording,
    segments: [last],
    events: recording.events.filter(
      (event) => event.kind === "viewport" || event.t >= last.atMs,
    ),
  };
}

/**
 * Apply the AI enhancement's consolidated prompt to the replayed chat: the
 * first user message becomes the single consolidated prompt and later user
 * messages fold away (their content is already merged into it), while every
 * assistant message — the REAL captured sequence of skill and tool activity —
 * replays untouched after it. Pure presentation: the captured transcript in
 * the bundle is never modified.
 */
/** Closing reply the enhanced replay uses when the bundle has none stored. */
const FALLBACK_ENHANCED_RESPONSE =
  "Here is what I built for you — take a look.";

export function consolidatedTranscript(
  transcript: AppRecordingBundle["recording"]["transcript"],
  enhancement: AppRecordingBundle["enhancement"],
): AppRecordingBundle["recording"]["transcript"] {
  const prompt = enhancement?.prompt.trim();
  if (!prompt) return transcript;
  const result: AppRecordingBundle["recording"]["transcript"] = [];
  let inserted = false;
  let lastAtMs = Number.NEGATIVE_INFINITY;
  for (const message of transcript) {
    lastAtMs = Math.max(lastAtMs, message.atMs);
    if (message.role === "user") {
      if (!inserted) {
        inserted = true;
        result.push({
          ...message,
          id: `${message.id}:enhanced`,
          parts: [{ type: "text", text: prompt }],
        });
      }
      continue;
    }
    if (message.role === "assistant") {
      // The captured skill/tool activity replays exactly as it happened; the
      // assistant's prose folds into the single closing response below.
      const activity = message.parts.filter((part) => part.type !== "text");
      if (activity.length > 0) result.push({ ...message, parts: activity });
      continue;
    }
    result.push(message);
  }
  result.push({
    id: "closing:enhanced-response",
    role: "assistant",
    atMs: Number.isFinite(lastAtMs) ? lastAtMs + 1 : 0,
    parts: [
      {
        type: "text",
        text: enhancement?.response?.trim() || FALLBACK_ENHANCED_RESPONSE,
      },
    ],
  });
  return result;
}

/**
 * The transcript the replay presents: the enhancement's consolidation (unless
 * the viewer disabled it), minus removed messages, with manual user-text
 * overrides applied. Pure presentation layered over the immutable capture —
 * clearing the chat edits restores the original conversation.
 */
export function presentedTranscript(
  transcript: AppRecordingBundle["recording"]["transcript"],
  enhancement: AppRecordingBundle["enhancement"],
  chat: NonNullable<AppRecordingBundle["edits"]>["chat"],
): AppRecordingBundle["recording"]["transcript"] {
  const removed = new Set(chat?.removedMessageIds ?? []);
  const overrides = new Map(
    (chat?.editedMessages ?? []).map((edit) => [edit.id, edit.text]),
  );
  // Removals and overrides apply to the CAPTURE first, consolidation second:
  // part ids address the captured parts, and consolidating first would shift
  // them (it drops the agent's prose).
  const edited = transcript
    .filter((message) => !removed.has(message.id))
    .map((message) => {
      const text = overrides.get(message.id);
      if (message.role === "user" && text != null) {
        return { ...message, parts: [{ type: "text" as const, text }] };
      }
      const parts = message.parts.filter(
        (_, index) => !removed.has(partEditId(message.id, index)),
      );
      return parts.length === message.parts.length
        ? message
        : { ...message, parts };
    })
    .filter((message) => message.parts.length > 0);
  return consolidatedTranscript(
    edited,
    chat?.enhancementDisabled ? undefined : enhancement,
  );
}

/**
 * The edit id of one PART of a captured message. An agent turn replays as
 * several boxes (prose bubbles, tool rows) and each is removable on its own,
 * so removals address parts, not only whole messages.
 */
export function partEditId(messageId: string, partIndex: number): string {
  return `${messageId}#${partIndex}`;
}

/**
 * The render region's geometry: two FORMAT CARDS cut from one cloth — the
 * chat card at the canonical recording aspect, the app card at the
 * recording's own (clamped) aspect — with the region height anchored to the
 * screen. The dialog shell shrink-wraps this region plus its chrome, so the
 * player's shape follows the recording, never the viewer's screen width or
 * the width the user happens to have dragged their side panel to: a session
 * recorded at the locked aspect opens as two matching cards on any machine,
 * and the exported video keeps that shape too. When the natural width would
 * overflow a narrow screen, the whole region scales down uniformly, so the
 * cards keep their aspects.
 *
 * @public — exported for testability
 */
export function replayRegionLayout({
  screenWidth,
  screenHeight,
  viewport,
}: {
  screenWidth: number;
  screenHeight: number;
  viewport: { width: number; height: number };
}): { regionHeight: number; chatWidth: number; appWidth: number } {
  const naturalHeight = Math.max(
    REGION_MIN_HEIGHT,
    Math.min(
      Math.round(screenHeight * 0.82) - REGION_CHROME_PX,
      REGION_MAX_HEIGHT,
    ),
  );
  const recordedAspect =
    viewport.width > 0 && viewport.height > 0
      ? viewport.width / viewport.height
      : APP_RECORDING_VIEWPORT_ASPECT;
  const appAspect = Math.min(
    STAGE_ASPECT_MAX,
    Math.max(STAGE_ASPECT_MIN, recordedAspect),
  );
  const naturalWidth =
    naturalHeight * (APP_RECORDING_VIEWPORT_ASPECT + appAspect);
  const scale = Math.min(1, (screenWidth * 0.94) / naturalWidth);
  const regionHeight = Math.round(naturalHeight * scale);
  return {
    regionHeight,
    chatWidth: Math.round(regionHeight * APP_RECORDING_VIEWPORT_ASPECT),
    appWidth: Math.round(regionHeight * appAspect),
  };
}

/**
 * {@link replayRegionLayout} against the live window, recomputed on resize.
 * Null only during SSR — the dialog opens client-side, so every real render
 * has a layout from the first frame.
 */
function useReplayRegionLayout(viewport: { width: number; height: number }) {
  const [screen, setScreen] = useState(() =>
    typeof window === "undefined"
      ? null
      : { width: window.innerWidth, height: window.innerHeight },
  );
  useEffect(() => {
    const onResize = () =>
      setScreen({ width: window.innerWidth, height: window.innerHeight });
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const { width: recordedWidth, height: recordedHeight } = viewport;
  return useMemo(
    () =>
      screen
        ? replayRegionLayout({
            screenWidth: screen.width,
            screenHeight: screen.height,
            viewport: { width: recordedWidth, height: recordedHeight },
          })
        : null,
    [screen, recordedWidth, recordedHeight],
  );
}

/**
 * Renders replay text with redacted values (the sanitizer's ●-runs) blurred —
 * the value is already gone from the bundle; the blur marks where it stood.
 */
function RedactedText({ text }: { text: string }) {
  const segments = text.split(/(\u25CF{4,})/);
  if (segments.length === 1) return <>{text}</>;
  return (
    <>
      {segments.map((segment, index) =>
        /^\u25CF{4,}$/.test(segment) ? (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: static split of one string
            key={index}
            className="select-none rounded-sm bg-muted-foreground/20 px-0.5 blur-[2px]"
            title="Redacted"
          >
            {segment}
          </span>
        ) : (
          segment
        ),
      )}
    </>
  );
}

/** The joined text of a transcript message's text parts. */
function transcriptText(message: TranscriptMessage): string {
  return message.parts
    .filter(
      (part): part is Extract<typeof part, { type: "text" }> =>
        part.type === "text",
    )
    .map((part) => part.text)
    .join("\n")
    .trim();
}

/**
 * Answer a replayed app's tool call from the recorded exchanges: prefer the
 * next unconsumed call with the same tool and arguments, then the next with
 * the same tool, then (for apps that call past the recorded count, e.g.
 * pollers) the most recent recorded answer for that tool.
 */
function takeRecordedToolResult(
  log: (McpTimelineEvent & { used: boolean })[],
  params: { name: string; arguments?: unknown },
) {
  const argsKey = stableStringify(params.arguments ?? {});
  const match =
    log.find(
      (event) =>
        !event.used &&
        event.toolName === params.name &&
        stableStringify(
          (event.params as { arguments?: unknown } | undefined)?.arguments ??
            {},
        ) === argsKey,
    ) ??
    log.find((event) => !event.used && event.toolName === params.name) ??
    [...log].reverse().find((event) => event.toolName === params.name);
  if (!match) {
    return {
      content: [
        {
          type: "text",
          text: "This action was not part of the recorded demo.",
        },
      ],
      isError: true,
    };
  }
  match.used = true;
  if (match.isError) {
    const message = (match.result as { message?: unknown } | undefined)
      ?.message;
    throw new Error(
      typeof message === "string" ? message : "Recorded call failed",
    );
  }
  return match.result;
}

const DEFAULT_VIEWPORT = { width: 800, height: 600 };

/**
 * The recording's representative viewport: the recorded size the app was being
 * INTERACTED with at, not merely the size left on screen the longest.
 *
 * A recording routinely spans more than one size. The app card sits narrow and
 * inline through a long build conversation, then opens wide in the side panel
 * for the part being shown off; an app card that mounts collapsed emits a
 * transient first size before it settles to its content height. Sizing to
 * whichever size accrued the most wall-clock time picks the idle one — the
 * minutes an app spends parked at a narrow width while the user types outweigh
 * the seconds of actual use — so the replay would lay the app out narrower than
 * it was ever really used, and any width-driven layout breaks (a game's start
 * overlay that a small screen refuses to dismiss stays up over the whole replay,
 * hiding the recorded session behind it). The player can't run the app to work
 * around its own responsive quirks, so it must give the app back the viewport it
 * was recorded at.
 *
 * So each distinct size is weighted by the pointer/keyboard/scroll/input events
 * that landed while it was on screen — the moments the user was actually driving
 * the app — and the most-used size wins. Ties, and recordings with no user
 * interaction at all, fall back to longest-on-screen time and then to the larger
 * area (the transient collapsed-mount size carries neither the interaction nor
 * the dwell time, so it loses either way).
 *
 * @public — exported for testability
 */
export function dominantViewport(events: TimelineEvent[]) {
  const viewports = events.filter(
    (event): event is Extract<TimelineEvent, { kind: "viewport" }> =>
      event.kind === "viewport",
  );
  if (viewports.length === 0) return DEFAULT_VIEWPORT;
  const endT = events.reduce((max, event) => Math.max(max, event.t), 0);
  const sorted = [...viewports].sort((a, b) => a.t - b.t);
  const sizeKey = (size: { width: number; height: number }) =>
    `${size.width}x${size.height}`;

  // Per distinct size: the wall-clock time it was on screen, and how many
  // user-driven events landed during it.
  const bySize = new Map<
    string,
    { width: number; height: number; ms: number; hits: number }
  >();
  for (let i = 0; i < sorted.length; i++) {
    const current = sorted[i];
    const until = i + 1 < sorted.length ? sorted[i + 1].t : endT;
    const key = sizeKey(current);
    const entry = bySize.get(key) ?? {
      width: current.width,
      height: current.height,
      ms: 0,
      hits: 0,
    };
    entry.ms += Math.max(0, until - current.t);
    bySize.set(key, entry);
  }

  // Attribute each user-driven event to the size that was on screen at its time
  // (the last viewport at or before it; the first for anything earlier).
  for (const event of events) {
    if (
      event.kind !== "pointer" &&
      event.kind !== "key" &&
      event.kind !== "input" &&
      event.kind !== "scroll"
    )
      continue;
    let active = sorted[0];
    for (const viewport of sorted) {
      if (viewport.t <= event.t) active = viewport;
      else break;
    }
    const entry = bySize.get(sizeKey(active));
    if (entry) entry.hits++;
  }

  // Rank by interaction, then dwell time, then area. With no interaction
  // anywhere every `hits` is 0, so this reduces to the longest-on-screen
  // fallback.
  let best = [...bySize.values()][0];
  for (const entry of bySize.values()) {
    const beats =
      entry.hits !== best.hits
        ? entry.hits > best.hits
        : entry.ms !== best.ms
          ? entry.ms > best.ms
          : entry.width * entry.height > best.width * best.height;
    if (beats) best = entry;
  }
  return { width: best.width, height: best.height };
}

/**
 * Uniform contain-fit of the recorded viewport inside the stage: one scale
 * for both dimensions — the smaller of the two ratios, so nothing is cropped
 * and nothing is stretched — and the offsets that center the scaled frame,
 * splitting the leftover evenly on whichever axis the shapes disagree.
 * A stage shaped exactly like the recording (the canonical locked-aspect
 * case) fits with zero offsets and fills edge to edge. Null while either box
 * has no size yet (mid-mount, display:none), so the caller keeps its previous
 * fit instead of collapsing to nothing.
 *
 * @public — exported for testability
 */
export function replayStageFit({
  stageWidth,
  stageHeight,
  viewport,
}: {
  stageWidth: number;
  stageHeight: number;
  viewport: { width: number; height: number };
}): { scale: number; offsetX: number; offsetY: number } | null {
  if (stageWidth <= 0 || stageHeight <= 0) return null;
  if (viewport.width <= 0 || viewport.height <= 0) return null;
  const scale = Math.min(
    stageWidth / viewport.width,
    stageHeight / viewport.height,
  );
  return {
    scale,
    offsetX: (stageWidth - viewport.width * scale) / 2,
    offsetY: (stageHeight - viewport.height * scale) / 2,
  };
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries
    .map(
      ([key, entryValue]) =>
        `${JSON.stringify(key)}:${stableStringify(entryValue)}`,
    )
    .join(",")}}`;
}

function formatMs(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/** The export ceiling in whole seconds, for the copy that quotes it. */
const MAX_EXPORT_SECONDS = Math.round(APP_RECORDING_MAX_EXPORT_MS / 1000);

/**
 * Stop the app's own code from running in a replay.
 *
 * A recorded session is replayed from what the app produced, not by running it
 * again — so its scripts must not run, or the app would re-simulate itself on
 * top of its own recording and the two would fight for the same canvas. The
 * platform's own scripts are left alone: they install the SDK the replay talks
 * to. Re-typing a script rather than removing it keeps the document's shape,
 * so the selectors recorded against it still resolve.
 *
 * @public — exported for testability
 */
export function neutralizeAppScripts(html: string): string {
  return (
    REPLAY_CHROME_CSS +
    html.replace(/<script\b([^>]*)>/gi, (tag: string, attrs: string) => {
      if (/data-archestra-app-(sdk|bootstrap)/i.test(attrs)) return tag;
      // Any `type` the app set must be REMOVED, not merely followed by the
      // replay type: the HTML parser drops duplicate attributes and keeps the
      // FIRST, so `<script type="module" type="application/…">` still parses
      // as a module — and executes. That is how a module-based app re-ran
      // itself inside its own replay, rolling fresh Math.random state and
      // repainting its canvas over the recorded frames.
      const rest = attrs.replace(
        /\stype(\s*=\s*("[^"]*"|'[^']*'|[^\s]*))?(?=\s|$)/gi,
        "",
      );
      return `<script${rest} type="application/archestra-replayed-script">`;
    })
  );
}

/**
 * Hide the replayed app's scrollbars.
 *
 * The stage lays the app out at its exact recorded viewport, so scrollbars
 * appear only when the app's own content overflowed that viewport during the
 * session — and then in the browser's default light scheme, which against a
 * dark app reads as light strips down the right and along the bottom. They
 * also mean nothing here: a replay is a playback surface, scrolling is driven
 * by the recorded scroll events, and a pointer shield already stops the viewer
 * from scrolling anything by hand.
 *
 * This also settles a disagreement between the two ways a recording is watched:
 * the offline renderer's browser hides scrollbars of its own accord, so an
 * exported video never had them and the player is what was out of step.
 */
const REPLAY_CHROME_CSS = `<style data-archestra-replay-chrome>
  ::-webkit-scrollbar { width: 0; height: 0; }
  html { scrollbar-width: none; }
</style>`;

// =============================================================================
// Guided tour
// =============================================================================

/** Browser-persisted "the user has seen (or skipped) the player tour" flag. */
const PLAYER_TOUR_SEEN_KEY = "app-recording-player-tour-seen";
/**
 * Browser-persisted tour progress: closing the player mid-tour resumes at the
 * same stop next time. Cleared when the tour finishes or is skipped.
 */
const PLAYER_TOUR_STEP_KEY = "app-recording-player-tour-step";

/**
 * The tour's stops, left-to-right, top-to-bottom over the player's interactive
 * elements. Each key matches a `data-tour` attribute on the element it
 * explains; stops whose element isn't on screen are skipped.
 */
const playerTourSteps = (modKey: "Cmd" | "Ctrl") => [
  {
    key: "description",
    title: "App description",
    text: "AI-generated app description. Click to edit or re-generate.",
  },
  {
    key: "chat",
    title: "Replayed chat",
    text: "The captured conversation replays here. Click anywhere on it to open the chat editor.",
  },
  {
    key: "chat-toggle",
    title: "AI-enhanced chat",
    text: "Edit and replay original chat messages or let AI edit it for you.",
  },
  {
    key: "chat-message",
    title: "Edit chat",
    text: "Edit or delete any chat message.",
  },
  {
    key: "stage",
    title: "App session replay",
  },
  // Three stops over the same anchor (and the same stretch of strip), each
  // illustrating one timeline gesture in place.
  {
    key: "timeline-cut",
    anchor: "timeline-sample",
    padTop: 12,
    title: "Select to cut",
    text: "Select an interval on the timeline, then cut it.",
  },
  {
    key: "timeline-restore",
    anchor: "timeline-sample",
    padTop: 12,
    title: "Restore a cutout",
    text: "Click a cutout to bring it back.",
  },
  {
    key: "timeline-resize",
    anchor: "timeline-sample",
    padTop: 12,
    title: "Resize a section",
    text: "Drag the ends to resize.",
  },
  {
    key: "history",
    title: "Undo and redo",
    text: `Every change like cut, trim, or text edit is a single reversible step. ${modKey}+Z works too.`,
  },
  {
    key: "download",
    title: "Video download",
    text: "Final cut with all your edits applied.",
    note: `Keep your final cut under ${MAX_EXPORT_SECONDS} seconds.`,
  },
  // Absent (and skipped) on deployments that don't offer the gallery — the
  // share button renders nothing there.
  {
    key: "share",
    title: "Submit to Archestra for review!",
    text: "Authorize Archestra to Create a Pull Request to Apps Hackathon repository on GitHub for you.\nFinal cut with all your edits applied.",
    note: `Keep your final cut under ${MAX_EXPORT_SECONDS} seconds.`,
  },
  {
    key: "tour",
    title: "That's it",
    text: "You can revisit this tour any time.",
  },
];

/**
 * The guided tour overlay: spotlights one interactive element at a time (a
 * ring plus a page-dimming cutout) with an explainer bubble beside it and
 * back / next / skip controls. Rendered inside the player dialog so all
 * geometry is measured against it.
 */
function PlayerTour({
  containerRef,
  onClose,
  onStepKeyChange,
}: {
  containerRef: React.RefObject<HTMLDivElement | null>;
  onClose: () => void;
  /**
   * Reports the active stop's key (null when the tour ends/unmounts). Some
   * stops DEMONSTRATE UI — the player renders the chat editor, or forces the
   * AI toggle off, purely from this signal — so any exit reverts everything
   * by construction: no real editor or recording state is ever touched.
   */
  onStepKeyChange: (key: string | null) => void;
}) {
  // Shortcut copy names the platform's own modifier — Cmd exists only on Mac
  // keyboards; Windows/Linux read Ctrl.
  const { modKey } = usePlatform();
  const steps = useMemo(() => playerTourSteps(modKey), [modKey]);
  // Resume where a mid-tour player close left off (progress persists per
  // browser until the tour finishes or is skipped).
  const [index, setIndex] = useState(() => {
    if (typeof window === "undefined") return 0;
    const stored = Number.parseInt(
      window.localStorage.getItem(PLAYER_TOUR_STEP_KEY) ?? "",
      10,
    );
    return Number.isFinite(stored) && stored > 0
      ? Math.min(stored, playerTourSteps("Ctrl").length - 1)
      : 0;
  });
  useEffect(() => {
    localStorage.setItem(PLAYER_TOUR_STEP_KEY, String(index));
  }, [index]);
  // Passing through a stop whose target never materialized continues in the
  // direction the viewer was headed.
  const directionRef = useRef(1);
  const [spot, setSpot] = useState<{
    top: number;
    left: number;
    width: number;
    height: number;
  } | null>(null);

  const step = steps[index] ?? null;
  useEffect(() => {
    onStepKeyChange(step?.key ?? null);
    return () => onStepKeyChange(null);
  }, [step?.key, onStepKeyChange]);

  useEffect(() => {
    if (!step) return;
    let raf = 0;
    let attempts = 0;
    let cancelled = false;
    let scrollFrames = 0;
    const measure = () => {
      if (cancelled) return;
      const container = containerRef.current;
      if (!container) return;
      // Several stops may share one anchor (the timeline's three gestures),
      // so the card holds still while only the illustration changes.
      const target = container.querySelector(
        `[data-tour="${step.anchor ?? step.key}"]`,
      );
      // A stop inside a scroller (a chat message) may sit outside the visible
      // area. One scrollIntoView is not enough: the chat pane sticks to the
      // bottom and snaps the target straight back out of view, leaving the
      // spotlight measured against a position the pane never shows. Re-assert
      // the scroll for a stretch of frames — that outlasts the stick — then
      // measure where the target finally settled.
      if (target && scrollFrames < 12) {
        scrollFrames += 1;
        target.scrollIntoView({ block: "center" });
        raf = requestAnimationFrame(measure);
        return;
      }
      if (!target) {
        // Demonstrated UI (the chat editor) mounts a render behind the step
        // switch — retry a few frames before treating the stop as absent.
        if (attempts < 20) {
          attempts += 1;
          raf = requestAnimationFrame(measure);
          return;
        }
        setSpot(null);
        setIndex((current) =>
          Math.min(
            Math.max(current + directionRef.current, 0),
            steps.length - 1,
          ),
        );
        return;
      }
      const containerRect = container.getBoundingClientRect();
      const box = (element: Element) => {
        const rect = element.getBoundingClientRect();
        return {
          top: rect.top - containerRect.top,
          left: rect.left - containerRect.left,
          width: rect.width,
          height: rect.height,
        };
      };
      setSpot(box(target));
    };
    measure();
    window.addEventListener("resize", measure);
    // Any later scroll (the pane settling, a stray wheel) moves the target,
    // so the ring re-measures rather than drifting off it.
    document.addEventListener("scroll", measure, true);
    return () => {
      cancelled = true;
      document.removeEventListener("scroll", measure, true);
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", measure);
    };
  }, [step, containerRef, steps.length]);

  if (!step || !spot) return null;

  // The bubble hugs the target's bounding-box corner nearest the player's
  // center and grows inward from it — so a hint always sits right next to its
  // element on the element's inner side, whether the target is a tiny header
  // button or a whole pane. Clamped inside the dialog either way.
  const containerWidth = containerRef.current?.clientWidth ?? 0;
  const containerHeight = containerRef.current?.clientHeight ?? 0;
  const BUBBLE_WIDTH = 288;
  const BUBBLE_HEIGHT = 150;
  const GAP = 10;
  const PAD = 12;
  const targetOnLeft = spot.left + spot.width / 2 <= containerWidth / 2;
  const targetOnTop = spot.top + spot.height / 2 <= containerHeight / 2;
  const cornerX = targetOnLeft ? spot.left + spot.width : spot.left;
  const cornerY = targetOnTop ? spot.top + spot.height : spot.top;
  const bubbleLeft = Math.min(
    Math.max(targetOnLeft ? cornerX + GAP : cornerX - GAP - BUBBLE_WIDTH, PAD),
    Math.max(PAD, containerWidth - BUBBLE_WIDTH - PAD),
  );
  const bubbleTop = Math.min(
    Math.max(targetOnTop ? cornerY + GAP : cornerY - GAP - BUBBLE_HEIGHT, PAD),
    Math.max(PAD, containerHeight - BUBBLE_HEIGHT - PAD),
  );

  return (
    <div className="absolute inset-0 z-50">
      {/* Spotlight: the ring marks the element; its giant shadow dims all else.
          A stop may ask for extra headroom when its controls overhang the
          element's own box (the timeline's Cut/Dismiss and restore badges
          straddle the strip's top edge). */}
      <div
        className="absolute rounded-md ring-2 ring-primary transition-all duration-200"
        style={{
          top: spot.top - (step.padTop ?? 4),
          left: spot.left - 4,
          width: spot.width + 8,
          height: spot.height + (step.padTop ?? 4) + 4,
          // 0.85, not the usual 0.5-ish scrim: the player is itself a dark
          // surface over a dark app, so anything lighter barely reads and the
          // spotlight doesn't pop. Matches the player dialog's own backdrop
          // (`overlayClassName`), so during the tour the dialog interior and
          // the page behind it dim as one surface.
          boxShadow: "0 0 0 9999px rgb(0 0 0 / 0.85)",
        }}
      />
      {/* The way out lives on the dimmed page itself, not in the bubble. */}
      <Button
        type="button"
        variant="secondary"
        className="absolute left-1/2 top-1/2 h-16 -translate-x-1/2 -translate-y-1/2 rounded-xl bg-secondary/50 px-8 text-xl shadow-lg backdrop-blur-sm hover:bg-secondary/70"
        onClick={onClose}
      >
        Skip editor tour
      </Button>
      <div
        className="absolute w-72 rounded-lg border bg-popover p-3 text-popover-foreground shadow-lg"
        style={{ top: bubbleTop, left: bubbleLeft }}
      >
        <div className="text-sm font-medium">{step.title}</div>
        {/* A stop whose spotlight speaks for itself carries no body text.
            pre-line: a stop's text may hold blank-line paragraph breaks. */}
        {step.text && (
          <p className="mt-1 whitespace-pre-line text-xs leading-relaxed text-muted-foreground">
            {step.text}
          </p>
        )}
        {/* A constraint the author has to act on, rather than a description of
            the control — set apart so it is not read as more of the same. */}
        {step.note && (
          <p className="mt-1.5 text-xs font-semibold leading-relaxed text-foreground">
            {step.note}
          </p>
        )}
        <div className="mt-3 flex items-center gap-2">
          <span className="text-[11px] tabular-nums text-muted-foreground">
            {index + 1} / {steps.length}
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="ml-auto h-7 text-xs"
            disabled={index === 0}
            onClick={() => setIndex((current) => current - 1)}
          >
            Back
          </Button>
          <Button
            type="button"
            size="sm"
            className="h-7 text-xs"
            onClick={() =>
              index >= steps.length - 1
                ? onClose()
                : setIndex((current) => current + 1)
            }
          >
            {index >= steps.length - 1 ? "Done" : "Next"}
          </Button>
        </div>
      </div>
    </div>
  );
}
