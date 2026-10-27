"use client";

import { ArrowUp, Check, ExternalLink, Loader2, X } from "lucide-react";
import {
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { annotateFrame, toBase64 } from "@/lib/dev-feedback/capture";
import {
  type CreateDevFeedbackCommentBody,
  type DevFeedbackComment,
  useCreateDevFeedbackComment,
  useCreateDevFeedbackReply,
  useDevFeedbackReplies,
  useResolveDevFeedbackComment,
} from "@/lib/dev-feedback/dev-feedback.query";
import { formatCompactRelativeTime } from "@/lib/utils/date-time";

export type DraftComment = {
  selector: string;
  label: string;
  rect: DOMRect;
  x: number;
  y: number;
  elementX: number;
  elementY: number;
  viewportX: number;
  viewportY: number;
  /** The tab as it looked at the click, before the popover opened. */
  frame: HTMLCanvasElement | null;
};

export type RecordedClip = { blob: Blob; durationMs: number };

/** `m:ss`, as the recording timer and the clip checkbox show it. */
export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function DraftPopover(props: {
  draft: DraftComment;
  route: string;
  /** The clip recorded before this comment, if any. */
  clip: RecordedClip | null;
  onDone: (params: { clipAttached: boolean }) => void;
}) {
  const { draft, route, onDone } = props;
  const [text, setText] = useState("");
  const [attachClip, setAttachClip] = useState(true);
  const [sending, setSending] = useState(false);
  const createComment = useCreateDevFeedbackComment();
  const willAttachClip = attachClip && props.clip !== null;
  const framePreview = useMemo(
    () => draft.frame?.toDataURL("image/jpeg") ?? null,
    [draft.frame],
  );

  const submit = async () => {
    if (!text.trim() || sending) return;
    setSending(true);
    try {
      const screenshot = draft.frame
        ? await annotateFrame({
            frame: draft.frame,
            elementRect: draft.rect,
            pin: { x: draft.x, y: draft.y },
            comment: text.trim(),
          })
        : null;
      let clip: CreateDevFeedbackCommentBody["clip"];
      if (willAttachClip && props.clip) {
        clip = {
          mimeType: props.clip.blob.type.startsWith("video/mp4")
            ? "video/mp4"
            : "video/webm",
          base64: await toBase64(props.clip.blob),
        };
      }
      const body: CreateDevFeedbackCommentBody = {
        route,
        url: window.location.href,
        selector: draft.selector,
        label: draft.label,
        elementX: draft.elementX,
        elementY: draft.elementY,
        viewportX: draft.viewportX,
        viewportY: draft.viewportY,
        viewport: `${window.innerWidth}x${window.innerHeight}`,
        text: text.trim(),
        screenshot: screenshot ?? undefined,
        clip,
      };
      await createComment.mutateAsync(body);
      onDone({ clipAttached: clip !== undefined });
    } catch {
      // The mutation already toasted; keep the draft so nothing is lost.
      setSending(false);
    }
  };

  return (
    <PopoverFrame x={draft.x} y={draft.y}>
      <p className="truncate text-muted-foreground text-xs">
        {route} › {draft.label}
      </p>
      {framePreview && (
        <img
          src={framePreview}
          alt="Screenshot to attach"
          className="mt-2 max-h-32 w-full rounded-md object-contain"
        />
      )}
      <Textarea
        autoFocus
        rows={2}
        value={text}
        disabled={sending}
        placeholder="Add a comment"
        className="mt-2 min-h-0 resize-none border-0 px-0 shadow-none focus-visible:ring-0"
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            void submit();
          }
        }}
      />
      {props.clip && attachClip && <ClipPreview blob={props.clip.blob} />}
      <div className="mt-2 flex items-center justify-between gap-2">
        {props.clip ? (
          <label
            htmlFor="dev-feedback-attach-clip"
            className="flex items-center gap-2 text-sm"
          >
            <Checkbox
              id="dev-feedback-attach-clip"
              checked={attachClip}
              disabled={sending}
              onCheckedChange={(checked) => setAttachClip(checked === true)}
            />
            <span>{`Attach clip (${formatDuration(props.clip.durationMs)})`}</span>
          </label>
        ) : (
          <span className="text-muted-foreground text-xs">
            Record a clip first to attach one
          </span>
        )}
        <Button
          size="icon-xs"
          aria-label="Post to Slack"
          disabled={!text.trim() || sending}
          onClick={() => void submit()}
        >
          {sending ? <Loader2 className="animate-spin" /> : <ArrowUp />}
        </Button>
      </div>
    </PopoverFrame>
  );
}

export function CommentPopover(props: {
  comment: DevFeedbackComment;
  x: number;
  y: number;
  onClose: () => void;
}) {
  const { comment, x, y, onClose } = props;
  const [reply, setReply] = useState("");
  const { data: replies, isLoading } = useDevFeedbackReplies(comment.id);
  const createReply = useCreateDevFeedbackReply(comment.id);
  const resolve = useResolveDevFeedbackComment();

  const sendReply = async () => {
    const text = reply.trim();
    if (!text || createReply.isPending) return;
    await createReply.mutateAsync(text).then(
      () => setReply(""),
      () => undefined,
    );
  };

  return (
    <PopoverFrame x={x} y={y}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-medium text-sm">{comment.authorName}</p>
          <p className="truncate text-muted-foreground text-xs">
            {formatCompactRelativeTime(comment.createdAt)} · {comment.label}
          </p>
        </div>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Close"
          onClick={onClose}
        >
          <X />
        </Button>
      </div>
      <p className="mt-2 whitespace-pre-wrap text-sm">{comment.text}</p>
      <div className="mt-3 max-h-48 space-y-2 overflow-y-auto border-t pt-2">
        {isLoading && (
          <p className="text-muted-foreground text-xs">Loading replies…</p>
        )}
        {replies?.map((item) => (
          <div key={item.id} className="text-sm">
            <span className="font-medium">{item.authorName}</span>
            <span className="ml-1 whitespace-pre-wrap">{item.text}</span>
          </div>
        ))}
        <Textarea
          rows={1}
          value={reply}
          placeholder="Reply"
          disabled={createReply.isPending}
          className="min-h-0 resize-none"
          onChange={(event) => setReply(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void sendReply();
            }
          }}
        />
      </div>

      <div className="mt-2 flex items-center justify-end gap-2">
        {comment.permalink && (
          <Button size="xs" variant="ghost" asChild>
            <a href={comment.permalink} target="_blank" rel="noreferrer">
              <ExternalLink />
              <span>Slack</span>
            </a>
          </Button>
        )}
        <Button
          size="xs"
          variant="outline"
          disabled={resolve.isPending}
          onClick={() => resolve.mutate(comment.id, { onSuccess: onClose })}
        >
          <Check />
          <span>Resolve</span>
        </Button>
      </div>
    </PopoverFrame>
  );
}

// ===

const POPOVER_WIDTH = 320;

/** The recorded clip, playable in place so it can be checked before posting. */
function ClipPreview(props: { blob: Blob }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const objectUrl = URL.createObjectURL(props.blob);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [props.blob]);
  if (!url) return null;
  return (
    <video
      src={url}
      controls
      muted
      playsInline
      className="mt-2 max-h-48 w-full rounded-md bg-black"
    />
  );
}

/**
 * Places the popover beside the pin, kept inside the viewport by its real
 * height, which grows with a clip preview or a long thread.
 */
function PopoverFrame(props: { x: number; y: number; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(280);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setHeight(element.offsetHeight));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const left = Math.max(
    8,
    Math.min(props.x + 20, window.innerWidth - POPOVER_WIDTH - 8),
  );
  const top = Math.max(
    8,
    Math.min(props.y - 16, window.innerHeight - height - 8),
  );
  return (
    <div
      ref={ref}
      className="fixed z-[2147483001] rounded-xl border bg-popover p-3 text-popover-foreground shadow-lg"
      style={{ left, top, width: POPOVER_WIDTH }}
    >
      {props.children}
    </div>
  );
}
