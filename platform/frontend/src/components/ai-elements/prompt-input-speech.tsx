"use client";

import {
  AlertCircleIcon,
  ArrowUpIcon,
  Loader2Icon,
  MicIcon,
  SquareIcon,
  XIcon,
} from "lucide-react";
import {
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import { Button } from "@/components/ui/button";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import {
  type DictationRecognition,
  DictationSession,
  type DictationState,
} from "@/lib/chat/dictation-session";
import { cn } from "@/lib/utils/tailwind";

type RecognitionWindow = Window & {
  SpeechRecognition?: new () => DictationRecognition;
  webkitSpeechRecognition?: new () => DictationRecognition;
};

type Props = {
  textareaRef?: RefObject<HTMLTextAreaElement | null>;
  onTranscriptionChange?: (text: string) => void;
  onActiveChange?: (active: boolean) => void;
  disabled?: boolean;
  sendDisabled?: boolean;
  className?: string;
};

export function PromptInputSpeechButton({
  textareaRef,
  onTranscriptionChange,
  onActiveChange,
  disabled,
  sendDisabled,
  className,
}: Props) {
  const [supported, setSupported] = useState(false);
  const [secure, setSecure] = useState(true);
  const [state, setState] = useState<DictationState>({
    phase: "idle",
    transcript: "",
  });
  const [levels, setLevels] = useState<number[]>(Array(28).fill(2));
  const session = useRef<DictationSession | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const media = useRef<MediaStream | null>(null);
  const audio = useRef<AudioContext | null>(null);
  const frame = useRef<number>(0);
  const generation = useRef(0);
  const latest = useRef({
    onTranscriptionChange,
    onActiveChange,
    disabled,
    sendDisabled,
  });
  latest.current = {
    onTranscriptionChange,
    onActiveChange,
    disabled,
    sendDisabled,
  };
  const phase = useRef(state.phase);
  phase.current = state.phase;

  const releaseAudio = useCallback(() => {
    generation.current++;
    cancelAnimationFrame(frame.current);
    media.current?.getTracks().forEach((track) => {
      track.stop();
    });
    media.current = null;
    void audio.current?.close().catch(() => {});
    audio.current = null;
  }, []);

  useEffect(() => {
    setSecure(window.isSecureContext);
    const ctor =
      (window as RecognitionWindow).SpeechRecognition ??
      (window as RecognitionWindow).webkitSpeechRecognition;
    setSupported(Boolean(ctor));
    if (!window.isSecureContext || !ctor) return;
    let disposed = false;
    const instance = new DictationSession(
      () => new ctor(),
      (next) => {
        if (disposed) return;
        phase.current = next.phase;
        setState(next);
        latest.current.onActiveChange?.(next.phase !== "idle");
        if (["idle", "error", "transcribing"].includes(next.phase))
          releaseAudio();
      },
      (transcript, send) => {
        if (disposed) return;
        const textarea = textareaRef?.current;
        if (!textarea) return;
        const value = [textarea.value, transcript].filter(Boolean).join(" ");
        // Commit controlled state before the form captures its outgoing message.
        flushSync(() => {
          const setter = Object.getOwnPropertyDescriptor(
            HTMLTextAreaElement.prototype,
            "value",
          )?.set;
          setter?.call(textarea, value);
          textarea.dispatchEvent(new Event("input", { bubbles: true }));
          latest.current.onTranscriptionChange?.(value);
        });
        textarea.focus();
        if (
          send &&
          !latest.current.disabled &&
          !latest.current.sendDisabled &&
          value.trim()
        )
          textarea.form?.requestSubmit();
      },
    );
    session.current = instance;
    const form = root.current?.closest("form");
    const intercept = (event: Event) => {
      if (phase.current === "idle") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!latest.current.disabled && !latest.current.sendDisabled)
        instance.finish(true);
    };
    // Capture all submission routes, including Enter, while final results drain.
    form?.addEventListener("submit", intercept, true);
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && phase.current !== "idle") {
        event.preventDefault();
        event.stopImmediatePropagation();
        instance.cancel();
        textareaRef?.current?.focus();
      }
    };
    form?.addEventListener("keydown", keydown, true);
    const leave = () => instance.cancel();
    window.addEventListener("pagehide", leave);
    return () => {
      disposed = true;
      form?.removeEventListener("submit", intercept, true);
      form?.removeEventListener("keydown", keydown, true);
      window.removeEventListener("pagehide", leave);
      latest.current.onActiveChange?.(false);
      // Detach React notifications before aborting on navigation/unmount.
      session.current = null;
      instance.cancel();
      releaseAudio();
    };
  }, [textareaRef, releaseAudio]);

  useEffect(() => {
    if (disabled) session.current?.cancel();
  }, [disabled]);

  const start = () => {
    session.current?.start();
    if (!["starting", "recording"].includes(phase.current)) return;
    const token = ++generation.current;
    setLevels(Array(28).fill(2));
    // This local-only analyser is for the waveform. Recognition keeps its
    // existing browser provider; no recording/blob/upload is created.
    if (!navigator.mediaDevices?.getUserMedia) return;
    void navigator.mediaDevices
      .getUserMedia({ audio: true })
      .then((stream) => {
        if (token !== generation.current) {
          stream.getTracks().forEach((track) => {
            track.stop();
          });
          return;
        }
        media.current = stream;
        const context = new AudioContext();
        audio.current = context;
        const analyser = context.createAnalyser();
        analyser.fftSize = 256;
        context.createMediaStreamSource(stream).connect(analyser);
        const data = new Uint8Array(analyser.fftSize);
        let last = 0;
        const draw = (time: number) => {
          if (token !== generation.current) return;
          if (time - last > 75) {
            analyser.getByteTimeDomainData(data);
            const rms = Math.sqrt(
              data.reduce((sum, value) => sum + ((value - 128) / 128) ** 2, 0) /
                data.length,
            );
            setLevels((values) => [
              ...values.slice(1),
              Math.max(2, Math.min(24, rms * 90)),
            ]);
            last = time;
          }
          frame.current = requestAnimationFrame(draw);
        };
        frame.current = requestAnimationFrame(draw);
      })
      .catch(() => {
        // Recognition owns permission/error reporting. A failed optional
        // analyser must not discard a successfully recognized transcript.
        releaseAudio();
      });
  };

  const active = state.phase !== "idle";
  const busy = state.phase === "transcribing";
  const error = state.phase === "error";
  return (
    <div ref={root} className={cn("relative min-w-0", className)}>
      {secure && !active ? (
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          disabled={disabled || !supported}
          aria-label="Start voice input"
          title={
            supported
              ? "Start voice input"
              : "Voice input is unavailable in this browser"
          }
          onClick={start}
        >
          <MicIcon className="size-4" />
        </Button>
      ) : secure ? (
        <fieldset
          className="flex min-w-0 items-center gap-1 rounded-xl bg-muted p-1 motion-safe:animate-in motion-safe:slide-in-from-right-2 motion-reduce:transition-none"
          aria-label="Voice input controls"
          aria-busy={busy}
          title={busy ? "Transcribing voice input" : "Recording voice input"}
        >
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            aria-label="Cancel voice input"
            title="Cancel voice input (Esc)"
            onClick={() => {
              session.current?.cancel();
              textareaRef?.current?.focus();
            }}
          >
            <XIcon className="size-3.5" />
          </Button>
          <div
            className="flex h-7 w-16 items-center justify-end gap-[2px] overflow-hidden sm:w-28"
            aria-hidden="true"
          >
            {levels.map((height, index) => (
              // These are fixed time slots, with new amplitude samples scrolling left.
              <span
                // biome-ignore lint/suspicious/noArrayIndexKey: stable waveform time slots
                key={index}
                className="w-[2px] shrink-0 rounded-full bg-muted-foreground motion-safe:transition-[height] motion-reduce:!h-1"
                style={{ height }}
              />
            ))}
          </div>
          <output className="sr-only">
            {busy
              ? "Transcribing voice input"
              : error
                ? "Voice input interrupted"
                : state.phase === "starting"
                  ? "Starting voice input"
                  : "Recording voice input"}
          </output>
          {busy ? (
            <Loader2Icon
              aria-hidden="true"
              className="size-4 motion-safe:animate-spin"
            />
          ) : (
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              aria-label={error ? "Keep voice transcript" : "Stop voice input"}
              title="Stop and edit transcript"
              onClick={() => session.current?.finish(false)}
            >
              <SquareIcon className="size-3" />
            </Button>
          )}
          <Button
            type="button"
            size="icon-xs"
            disabled={busy || error || disabled || sendDisabled}
            aria-label="Send voice input"
            title="Finish transcription and send"
            onClick={() => session.current?.finish(true)}
          >
            <ArrowUpIcon className="size-4" />
          </Button>
        </fieldset>
      ) : null}
      {error && (
        <div className="absolute bottom-full right-0 z-20 mb-2 w-[min(22rem,calc(100vw-2rem))]">
          <InlineNotice variant="error">
            <AlertCircleIcon />
            <InlineNoticeText>{state.error}</InlineNoticeText>
            <Button type="button" size="xs" variant="ghost" onClick={start}>
              <span>Retry</span>
            </Button>
          </InlineNotice>
        </div>
      )}
    </div>
  );
}
