"use client";

import { Circle, MessageSquarePlus, Settings, Square, X } from "lucide-react";
import { useParams, usePathname } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import {
  type DevFeedbackComment,
  useDevFeedbackComments,
  useDevFeedbackSetup,
} from "@/lib/dev-feedback/dev-feedback.query";
import {
  buildSelector,
  describeElement,
  findAnchorElement,
  toRoutePattern,
} from "@/lib/dev-feedback/element-anchor";
import { screenRecorder } from "@/lib/dev-feedback/screen-recorder";
import { cn } from "@/lib/utils/tailwind";
import {
  CommentPopover,
  type DraftComment,
  DraftPopover,
  formatDuration,
  type RecordedClip,
} from "./dev-feedback-popovers";
import { DevFeedbackSetupPanel } from "./dev-feedback-setup";

/**
 * Internal UI feedback: a comment mode that pins comments on page elements
 * and posts them, with a screenshot and a clip of the tab, to Slack. Only
 * mounted where the deployment configures the feedback channel.
 */
export function DevFeedbackOverlay() {
  const pathname = usePathname();
  const routeParams = useParams();
  const route = useMemo(
    () => toRoutePattern({ pathname, routeParams: routeParams ?? {} }),
    [pathname, routeParams],
  );
  const { data: session } = useSession();
  const [active, setActive] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [recordingSince, setRecordingSince] = useState<number | null>(null);
  const [clip, setClip] = useState<RecordedClip | null>(null);
  const recording = recordingSince !== null;
  const [hoverRect, setHoverRect] = useState<DOMRect | null>(null);
  const [draft, setDraft] = useState<DraftComment | null>(null);
  const [openCommentId, setOpenCommentId] = useState<string | null>(null);
  const [setupOpen, setSetupOpen] = useState(false);
  const layoutTick = useLayoutTick(active);
  const { data: setup } = useDevFeedbackSetup();
  const configured = setup?.configured ?? false;
  const { data: canConfigure } = useHasPermissions({
    organizationSettings: ["update"],
  });
  const { data: comments = [], isSuccess: commentsLoaded } =
    useDevFeedbackComments({ route, enabled: configured });
  const [linkedCommentId, setLinkedCommentId] = useState(readLinkedCommentId);

  const stopClip = useCallback(async () => {
    if (recordingSince === null) return;
    setRecordingSince(null);
    const blob = await screenRecorder.stopRecording();
    if (blob) setClip({ blob, durationMs: Date.now() - recordingSince });
  }, [recordingSince]);

  const close = useCallback(() => {
    void stopClip();
    setActive(false);
    setDraft(null);
    setOpenCommentId(null);
    setHoverRect(null);
  }, [stopClip]);

  // A clip is capped so its upload stays well inside the request limit.
  useEffect(() => {
    if (recordingSince === null) return;
    const timer = setTimeout(
      () => void stopClip(),
      recordingSince + MAX_CLIP_MS - Date.now(),
    );
    return () => clearTimeout(timer);
  }, [recordingSince, stopClip]);

  // Navigating away drops whatever was being written for the old page.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on route change only
  useEffect(() => {
    setDraft(null);
    setOpenCommentId(null);
  }, [route]);

  // The Slack message links back here with the comment's id in the hash.
  useEffect(() => {
    const onHashChange = () => setLinkedCommentId(readLinkedCommentId());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);
  useEffect(() => {
    if (!linkedCommentId || !commentsLoaded) return;
    const comment = comments.find(({ id }) => id === linkedCommentId);
    setLinkedCommentId(null);
    window.history.replaceState(
      window.history.state,
      "",
      window.location.pathname + window.location.search,
    );
    if (!comment) {
      toast.info("That comment is resolved");
      return;
    }
    setActive(true);
    setDraft(null);
    setOpenCommentId(comment.id);
    findAnchorElement(comment.selector)?.scrollIntoView({ block: "center" });
  }, [linkedCommentId, commentsLoaded, comments]);

  const toggle = async () => {
    if (active) {
      close();
      return;
    }
    if (setupOpen) {
      setSetupOpen(false);
      return;
    }
    // Until a bot and channel are picked, the button opens the setup.
    if (!configured) {
      setSetupOpen(true);
      return;
    }
    setActive(true);
    await ensureSharing();
  };

  // Asked from a click: the share prompt needs a user gesture.
  const ensureSharing = async (): Promise<boolean> => {
    if (screenRecorder.isActive) return true;
    const started = await screenRecorder.start(() => {
      setSharing(false);
      setRecordingSince(null);
    });
    setSharing(started);
    if (!started) {
      toast.info("Screen share declined: comments post without media");
    }
    return started;
  };

  const startClip = async () => {
    if (!(await ensureSharing())) return;
    if (!screenRecorder.startRecording()) {
      toast.error("This browser cannot record the tab");
      return;
    }
    setDraft(null);
    setOpenCommentId(null);
    setClip(null);
    setRecordingSince(Date.now());
  };

  // While recording, the page is used as normal: no picking, no pins.
  usePickElement({
    enabled: active && !recording && !setupOpen,
    onHover: setHoverRect,
    onPick: (element, point) => {
      const rect = element.getBoundingClientRect();
      setOpenCommentId(null);
      setDraft({
        selector: buildSelector(element),
        label: describeElement(element),
        rect,
        x: point.x,
        y: point.y,
        elementX: clamp01((point.x - rect.left) / (rect.width || 1)),
        elementY: clamp01((point.y - rect.top) / (rect.height || 1)),
        viewportX: clamp01(point.x / window.innerWidth),
        viewportY: clamp01(point.y / window.innerHeight),
        frame: screenRecorder.captureFrame(),
      });
    },
    onEscape: () => {
      if (draft || openCommentId) {
        setDraft(null);
        setOpenCommentId(null);
      } else {
        close();
      }
    },
  });

  const positioned =
    active && !recording
      ? comments.flatMap((comment) => {
          const position = pinPosition(comment);
          return position ? [{ comment, ...position }] : [];
        })
      : [];
  const openComment = positioned.find(
    ({ comment }) => comment.id === openCommentId,
  );

  return createPortal(
    <div data-dev-feedback-root="" data-layout-tick={layoutTick}>
      {active && hoverRect && !draft && (
        <div
          className="pointer-events-none fixed z-[2147483000] rounded-sm border-2 border-blue-600 bg-blue-600/5"
          style={{
            left: hoverRect.left,
            top: hoverRect.top,
            width: hoverRect.width,
            height: hoverRect.height,
          }}
        />
      )}

      {positioned.map(({ comment, x, y, detached }) => (
        <Pin
          key={comment.id}
          x={x}
          y={y}
          label={initials(comment.authorName)}
          detached={detached}
          title={detached ? "Element not found on this page" : comment.text}
          onClick={() => {
            setDraft(null);
            setOpenCommentId(comment.id === openCommentId ? null : comment.id);
          }}
        />
      ))}

      {draft && (
        <>
          <Pin
            x={draft.x}
            y={draft.y}
            label={initials(session?.user.name ?? "")}
          />
          <DraftPopover
            draft={draft}
            route={route}
            clip={clip}
            onDone={({ clipAttached }) => {
              setDraft(null);
              if (clipAttached) setClip(null);
            }}
          />
        </>
      )}

      {openComment && (
        <CommentPopover
          comment={openComment.comment}
          x={openComment.x}
          y={openComment.y}
          onClose={() => setOpenCommentId(null)}
        />
      )}

      {setupOpen && (
        <DevFeedbackSetupPanel
          currentChannelName={setup?.channelName ?? null}
          currentAgentId={setup?.agentId ?? null}
          onClose={() => setSetupOpen(false)}
          onSaved={() => setSetupOpen(false)}
        />
      )}

      <div className="fixed right-4 bottom-4 z-[2147483001] flex items-center gap-2">
        {active && recordingSince !== null && (
          <RecordingBar since={recordingSince} onStop={() => void stopClip()} />
        )}
        {active && recordingSince === null && (
          <div className="flex items-center gap-2 rounded-md bg-foreground px-2 py-1 text-background text-xs shadow">
            {sharing && <span className="text-red-500">●</span>}
            <span>Click an element to comment · Esc to exit</span>
            {canConfigure && (
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label="Change Slack channel"
                title={`Posting to #${setup?.channelName ?? ""}`}
                className="text-background hover:bg-background/20 hover:text-background"
                onClick={() => setSetupOpen((open) => !open)}
              >
                <Settings />
              </Button>
            )}
            {clip ? (
              <span className="flex items-center gap-1 rounded bg-background/15 pl-2">
                <span>{`Clip ${formatDuration(clip.durationMs)} ready`}</span>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label="Discard clip"
                  className="text-background hover:bg-background/20 hover:text-background"
                  onClick={() => setClip(null)}
                >
                  <X />
                </Button>
              </span>
            ) : (
              <Button
                size="xs"
                variant="secondary"
                onClick={() => void startClip()}
              >
                <Circle className="fill-red-500 text-red-500" />
                <span>Record</span>
              </Button>
            )}
          </div>
        )}
        <Button
          size="icon-sm"
          variant={active ? "default" : "outline"}
          className="relative rounded-full shadow-md"
          aria-label={active ? "Exit comment mode" : "Comment on this page"}
          onClick={toggle}
        >
          {active ? <X /> : <MessageSquarePlus />}
          {!active && comments.length > 0 && (
            <span className="absolute -top-1 -right-1 flex size-4 items-center justify-center rounded-full bg-blue-600 text-[10px] text-white">
              {comments.length}
            </span>
          )}
        </Button>
      </div>
    </div>,
    document.body,
  );
}

// ===

/** A clip stops on its own after this long. */
const MAX_CLIP_MS = 60_000;

function RecordingBar(props: { since: number; onStop: () => void }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, []);
  return (
    <div className="flex items-center gap-2 rounded-md bg-foreground px-2 py-1 text-background text-xs shadow">
      <span className="animate-pulse text-red-500">●</span>
      <span>{`Recording ${formatDuration(now - props.since)} · use the page, then stop`}</span>
      <Button size="xs" variant="secondary" onClick={props.onStop}>
        <Square className="fill-current" />
        <span>Stop</span>
      </Button>
    </div>
  );
}

function Pin(props: {
  x: number;
  y: number;
  label: string;
  detached?: boolean;
  title?: string;
  onClick?: () => void;
}) {
  return (
    <UnstyledButton
      title={props.title}
      onClick={props.onClick}
      className={cn(
        "fixed z-[2147483000] flex size-7 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full rounded-bl-none border-2 border-white bg-blue-600 font-medium text-[11px] text-white shadow-md",
        props.detached && "border-dashed opacity-60",
      )}
      style={{ left: props.x, top: props.y }}
    >
      {props.label}
    </UnstyledButton>
  );
}

/**
 * While enabled, the page's own pointer handlers never see a click: the
 * capture-phase listeners swallow it and report the element under the
 * pointer instead. Scrolling still works because wheel events pass through.
 */
function usePickElement(params: {
  enabled: boolean;
  onHover: (rect: DOMRect | null) => void;
  onPick: (element: Element, point: { x: number; y: number }) => void;
  onEscape: () => void;
}) {
  const { enabled } = params;
  // Handlers change every render; listeners read the latest through a ref so
  // they are attached once per comment-mode session.
  const handlers = useRef(params);
  handlers.current = params;
  useEffect(() => {
    if (!enabled) return;
    const onHover = (rect: DOMRect | null) => handlers.current.onHover(rect);
    const onPick = (element: Element, point: { x: number; y: number }) =>
      handlers.current.onPick(element, point);
    const onEscape = () => handlers.current.onEscape();
    // Toasts count as overlay: the "Posted" toast's Open link must stay
    // clickable while comment mode is on.
    const isOverlay = (target: EventTarget | null) =>
      target instanceof Element &&
      target.closest("[data-dev-feedback-root], [data-sonner-toaster]") !==
        null;
    const pageElementAt = (x: number, y: number) =>
      document.elementsFromPoint(x, y).find((element) => !isOverlay(element)) ??
      null;

    const onMove = (event: PointerEvent) => {
      if (isOverlay(event.target)) return;
      onHover(
        pageElementAt(event.clientX, event.clientY)?.getBoundingClientRect() ??
          null,
      );
    };
    const swallow = (event: Event) => {
      if (isOverlay(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
    };
    const onClick = (event: MouseEvent) => {
      if (isOverlay(event.target)) return;
      swallow(event);
      const element = pageElementAt(event.clientX, event.clientY);
      if (element) onPick(element, { x: event.clientX, y: event.clientY });
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onEscape();
    };

    const swallowed = ["pointerdown", "mousedown", "pointerup", "mouseup"];
    document.addEventListener("pointermove", onMove, true);
    document.addEventListener("click", onClick, true);
    for (const type of swallowed)
      document.addEventListener(type, swallow, true);
    document.addEventListener("keydown", onKey);
    document.documentElement.style.cursor = "crosshair";
    return () => {
      document.removeEventListener("pointermove", onMove, true);
      document.removeEventListener("click", onClick, true);
      for (const type of swallowed) {
        document.removeEventListener(type, swallow, true);
      }
      document.removeEventListener("keydown", onKey);
      document.documentElement.style.cursor = "";
      onHover(null);
    };
  }, [enabled]);
}

/**
 * Re-renders pins as the page scrolls, resizes or re-lays out. Pins are
 * placed from live element rects rather than tracked, so a cheap periodic
 * tick plus scroll and resize is enough.
 */
function useLayoutTick(enabled: boolean): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let frame = 0;
    const bump = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setTick((value) => value + 1));
    };
    const interval = setInterval(bump, 500);
    window.addEventListener("scroll", bump, true);
    window.addEventListener("resize", bump);
    return () => {
      clearInterval(interval);
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", bump, true);
      window.removeEventListener("resize", bump);
    };
  }, [enabled]);
  return tick;
}

function pinPosition(
  comment: DevFeedbackComment,
): { x: number; y: number; detached: boolean } | null {
  const element = findAnchorElement(comment.selector);
  const rect = element?.getBoundingClientRect();
  if (rect && rect.width > 0 && rect.height > 0) {
    const x = rect.left + comment.elementX * rect.width;
    const y = rect.top + comment.elementY * rect.height;
    const visible =
      x >= 0 && y >= 0 && x <= window.innerWidth && y <= window.innerHeight;
    return visible ? { x, y, detached: false } : null;
  }
  return {
    x: comment.viewportX * window.innerWidth,
    y: comment.viewportY * window.innerHeight,
    detached: true,
  };
}

/** Matches the link the backend puts in the comment's Slack message. */
function readLinkedCommentId(): string | null {
  const match = window.location.hash.match(
    /^#dev-feedback-comment=(\d+\.\d+)$/,
  );
  return match?.[1] ?? null;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return (
    parts
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join("") || "?"
  );
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}
