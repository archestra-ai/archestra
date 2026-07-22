"use client";

import { Play } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Loader } from "@/components/ai-elements/loader";
import { AppSessionPlayer } from "@/components/app-session-recording/app-session-player";
import { useAppSessionRecorder } from "@/components/app-session-recording/use-app-session-recorder";
import { Button } from "@/components/ui/button";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  useAppRecording,
  useLatestAppRecordingKeyForApp,
} from "@/lib/app-session-recording/app-recording.query";
import {
  APPS_HACKATHON_DATE_RANGE_LABEL,
  APPS_HACKATHON_REGISTER_URL,
  APPS_HACKATHON_SETTINGS_HREF,
} from "@/lib/app-session-recording/apps-hackathon";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { cn } from "@/lib/utils";

/**
 * The Apps Hackathon session recorder — a self-contained control cluster for the
 * chat composer: Record/Stop with a live timer, and a Play button that opens the
 * built-in replay. It records the whole chat — the app it builds across the
 * inline card and the side panel, the tool responses, and the transcript — and
 * can start before the first message is even sent (a from-scratch build),
 * binding to the conversation the moment it exists. Sharing lives inside the
 * player. Everything — the recorder, the conversation, the feature gate —
 * comes from the chat page's recorder provider, so the cluster renders nothing
 * when the feature is disabled or no chat surface provides a recorder.
 * Rendered in the composer, not on any single app frame, so one recording
 * spans the session no matter where the app is shown.
 */
export function AppRecordingControls() {
  const recorder = useAppSessionRecorder();
  const { data: recording } = useAppRecording(recorder.conversationId);
  // Recordings are keyed by conversation, but they BIND to the app the moment
  // it exists — so a fresh chat opened on an existing app (no recording of its
  // own yet) still replays the app's newest recording from any conversation.
  const { data: appBoundKey } = useLatestAppRecordingKeyForApp(
    recording ? null : recorder.appId,
  );
  const replayConversationId = recording
    ? recorder.conversationId
    : (appBoundKey ?? null);
  const [playerOpen, setPlayerOpen] = useState(false);
  // The toggle is admin-only, so a member offered a link to it would land on a
  // control they cannot move. Same permission the setting itself is gated on.
  const { data: canDisableRecorder } = useHasPermissions({
    agentSettings: ["update"],
  });

  const isRecording = recorder.status === "recording";
  // Live elapsed timer while recording. The recorder exposes the true start
  // epoch, so a control mounted mid-recording still shows the right elapsed
  // time. These hooks must run before the no-recorder early return below.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!isRecording) return;
    setNowMs(Date.now());
    const id = setInterval(() => setNowMs(Date.now()), 500);
    return () => clearInterval(id);
  }, [isRecording]);

  if (!recorder.canRecord) return null;

  const isSaving = recorder.status === "saving";
  const hasRecording = !!replayConversationId;
  const canPlay = hasRecording && !isRecording && !isSaving;
  const elapsedMs = isRecording ? Math.max(0, nowMs - recorder.startedAtMs) : 0;

  return (
    <TooltipProvider delayDuration={200}>
      {/* One uniform gap between every element (and separators with no margins
          of their own) keeps the cluster symmetric and tight by construction. */}
      <div
        className={cn(
          // ml-1.5: breathing room from the context-usage ring the cluster
          // sits next to — the composer's own item gap is too tight for two
          // bordered neighbors.
          // shrink-0: the cluster has a fixed intrinsic width (nowrap label +
          // fixed-width timer + icon buttons); never let a tight flex parent
          // compress it, which would clip the label and squeeze the controls.
          "ml-1.5 inline-flex h-8 shrink-0 items-center gap-1 rounded-full border pl-2.5 pr-1 shadow-sm transition-colors",
          isRecording
            ? "border-destructive/50 bg-destructive/10"
            : // A periodic glitter sweep and a shimmer travelling around the
              // edge draw the eye to the hackathon recorder while it's idle;
              // during recording the panel stays calm behind the red pulse.
              "border-primary/30 bg-primary/5 hackathon-glitter hackathon-edge-shimmer",
        )}
      >
        {/* Names the cluster and sets it apart from the neutral composer
            chrome, and carries the only explanation of why the cluster is
            there at all — including the way out for someone who does not want
            it. A HoverCard rather than a Tooltip because that way out is a
            link, and a tooltip closes before it can be clicked. */}
        <HoverCard openDelay={200}>
          <HoverCardTrigger asChild>
            <span
              className={cn(
                "-mx-0.5 cursor-help select-none whitespace-nowrap rounded px-0.5 py-1 text-[11px] font-semibold leading-none",
                isRecording ? "text-destructive" : "text-primary/80",
              )}
            >
              Apps Hackathon
            </span>
          </HoverCardTrigger>
          <HoverCardContent
            side="top"
            align="start"
            className="w-80 space-y-2 text-xs"
          >
            <p className="font-semibold">
              The Apps Hackathon runs {APPS_HACKATHON_DATE_RANGE_LABEL}!
            </p>
            <p className="text-muted-foreground">
              Record how you build your app, demo it, and win prizes.{" "}
              <a
                href={APPS_HACKATHON_REGISTER_URL}
                target="_blank"
                rel="noreferrer noopener"
                className="font-medium text-primary underline underline-offset-2"
              >
                Register now.
              </a>
            </p>
            <p className="text-muted-foreground">
              Don&apos;t want to see this?{" "}
              {/* Only an admin can actually switch it off, so only an admin is
                  sent to the setting — anyone else is told who can. */}
              {canDisableRecorder ? (
                <Link
                  href={APPS_HACKATHON_SETTINGS_HREF}
                  className="font-medium text-primary underline underline-offset-2"
                >
                  Disable in settings.
                </Link>
              ) : (
                "Ask your admin to disable this."
              )}
            </p>
          </HoverCardContent>
        </HoverCard>
        <span className="h-4 w-px bg-border" aria-hidden="true" />
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-7 rounded-full hover:bg-destructive/20 focus-visible:bg-destructive/20"
                aria-label={
                  isSaving
                    ? "Saving recording"
                    : isRecording
                      ? "Stop recording"
                      : "Record session"
                }
                disabled={isSaving}
                onClick={() => {
                  if (isRecording) {
                    void recorder.stop();
                  } else {
                    recorder.start();
                  }
                }}
              >
                {/* Solid shapes, not icons: a lucide glyph carries its own
                    `fill="none"` attribute and renders as a hollow ring the
                    moment a `fill-*` utility doesn't land. A record dot must
                    always read as filled. */}
                {isSaving ? (
                  <Loader size={13} />
                ) : isRecording ? (
                  <span className="size-2.5 animate-pulse rounded-[2px] bg-destructive" />
                ) : (
                  <span className="size-2.5 rounded-full bg-destructive" />
                )}
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-[260px] text-xs">
            {isRecording
              ? "Stop and save the recording"
              : "Record session. Recording captures the whole chat, the app, and every input — keep sensitive data out of view."}
          </TooltipContent>
        </Tooltip>

        {/* The elapsed clock is always present — zeroed while idle — so the
            cluster never resizes when a recording starts or stops. */}
        <span
          className={cn(
            "min-w-8 text-center text-xs font-medium tabular-nums",
            isRecording ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {formatElapsed(elapsedMs)}
        </span>

        <span className="h-4 w-px bg-border" aria-hidden="true" />

        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-7 rounded-full text-muted-foreground hover:bg-foreground/15 hover:text-foreground focus-visible:bg-foreground/15 focus-visible:text-foreground"
                aria-label="Replay session"
                disabled={!canPlay}
                onClick={() => setPlayerOpen(true)}
              >
                <Play className="size-3.5" />
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent side="top" className="text-xs">
            {hasRecording ? "Replay session" : "Record a session first"}
          </TooltipContent>
        </Tooltip>
      </div>

      {playerOpen && replayConversationId && (
        <AppSessionPlayer
          conversationId={replayConversationId}
          open={playerOpen}
          onOpenChange={setPlayerOpen}
        />
      )}
    </TooltipProvider>
  );
}

/** Elapsed recording time as m:ss. */
function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}
