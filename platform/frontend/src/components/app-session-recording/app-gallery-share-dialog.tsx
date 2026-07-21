"use client";

import {
  pruneTrailingTrimEvents,
  validateRecordingBundle,
} from "@archestra/shared";
import { Check, Copy, ExternalLink, Share2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Loader } from "@/components/ai-elements/loader";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  acquireGithubToken,
  GithubAuthError,
  type ShareProgressStage,
  submitRecordingToAppGallery,
  takeCachedGithubToken,
} from "@/lib/app-session-recording/app-gallery-share";
import { recordingStore } from "@/lib/app-session-recording/app-recording-store";
import { copyToClipboard } from "@/lib/clipboard";
import { useFeature } from "@/lib/config/config.query";

/**
 * The player's "Share to the App Gallery" action: one click runs GitHub
 * sign-in (device flow, first share only), files the pull request from the
 * participant's own account, and opens it in a new tab. Renders nothing on
 * deployments that don't offer the gallery.
 */
export function AppGalleryShareButton(props: {
  conversationId: string;
  disabled: boolean;
}) {
  const galleryRepo = useFeature("hackathonGalleryRepo");
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<ShareState>({ step: "idle" });
  const abortRef = useRef<AbortController | null>(null);

  const run = useCallback(async () => {
    if (!galleryRepo) return;
    abortRef.current?.abort();
    const cancellation = new AbortController();
    abortRef.current = cancellation;

    try {
      const bundle = await recordingStore.get(props.conversationId);
      if (!bundle) {
        setState({
          step: "error",
          message: "No recording to share for this session.",
        });
        return;
      }
      const validation = validateRecordingBundle(bundle);
      if (!validation.ok) {
        setState({
          step: "error",
          message: `This recording can't be shared. ${validation.reason}`,
        });
        return;
      }

      let token = takeCachedGithubToken();
      if (!token) {
        setState({ step: "working", stage: "signing-in" });
        token = await acquireGithubToken({
          signal: cancellation.signal,
          onUserCode: (info) =>
            setState({
              step: "connect",
              userCode: info.userCode,
              verificationUri: info.verificationUri,
            }),
        });
      }

      setState({ step: "working", stage: "forking" });
      const { prUrl } = await submitRecordingToAppGallery({
        token,
        repo: galleryRepo,
        // Same size trim the video export ships (renders identically).
        bundle: pruneTrailingTrimEvents(validation.bundle),
        signal: cancellation.signal,
        onProgress: (stage) => setState({ step: "working", stage }),
      });
      setState({ step: "done", prUrl });
      // Best effort — this open comes long after the click, so a popup
      // blocker may eat it; the dialog keeps the explicit link either way.
      window.open(prUrl, "_blank", "noopener");
    } catch (error) {
      if (cancellation.signal.aborted) return;
      setState({
        step: "error",
        message:
          error instanceof GithubAuthError
            ? `${error.message} Retry to sign in again.`
            : error instanceof Error
              ? error.message
              : "Sharing failed.",
      });
    }
  }, [galleryRepo, props.conversationId]);

  // The flow runs while the dialog is up; closing it is the cancel.
  const setDialogOpen = (next: boolean) => {
    setOpen(next);
    if (next) {
      void run();
    } else {
      abortRef.current?.abort();
      setState({ step: "idle" });
    }
  };

  useEffect(() => () => abortRef.current?.abort(), []);

  if (!galleryRepo) return null;

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-7 text-muted-foreground hover:text-foreground"
              aria-label="Share this session to the App Gallery"
              disabled={props.disabled}
              onClick={() => setDialogOpen(true)}
            >
              <Share2 className="size-4" />
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent sideOffset={8}>
          Share to the App Gallery — opens a pull request from your GitHub
          account.
        </TooltipContent>
      </Tooltip>

      <Dialog open={open} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Share to the App Gallery</DialogTitle>
            <DialogDescription>
              Your recording is submitted as a pull request from your own GitHub
              account. Nothing is published before it is reviewed.
            </DialogDescription>
          </DialogHeader>
          <ShareDialogBody state={state} onRetry={run} />
        </DialogContent>
      </Dialog>
    </>
  );
}

// =============================================================================
// Internal pieces
// =============================================================================

type ShareState =
  | { step: "idle" }
  | { step: "connect"; userCode: string; verificationUri: string }
  | { step: "working"; stage: ShareProgressStage | "signing-in" }
  | { step: "done"; prUrl: string }
  | { step: "error"; message: string };

const STAGE_LABELS: Record<ShareProgressStage | "signing-in", string> = {
  "signing-in": "Connecting to GitHub…",
  forking: "Forking the gallery repository…",
  branching: "Creating the submission branch…",
  uploading: "Uploading the recording…",
  "opening-pr": "Opening the pull request…",
};

function ShareDialogBody(props: { state: ShareState; onRetry: () => void }) {
  const { state } = props;

  if (state.step === "connect") {
    return <ConnectStep {...state} />;
  }
  if (state.step === "working") {
    return (
      <div className="flex items-center gap-3 py-2 text-sm text-muted-foreground">
        <Loader size={16} />
        {STAGE_LABELS[state.stage]}
      </div>
    );
  }
  if (state.step === "done") {
    return (
      <div className="flex flex-col gap-3 py-2">
        <p className="flex items-center gap-2 text-sm">
          <Check className="size-4 text-green-600" aria-hidden="true" />
          Your pull request is open — it opened in a new tab.
        </p>
        <Button asChild>
          <a href={state.prUrl} target="_blank" rel="noopener noreferrer">
            Open the pull request
            <ExternalLink className="ml-2 size-4" aria-hidden="true" />
          </a>
        </Button>
      </div>
    );
  }
  if (state.step === "error") {
    return (
      <div className="flex flex-col gap-3 py-2">
        <p className="text-sm text-destructive">{state.message}</p>
        <Button variant="outline" onClick={props.onRetry}>
          Retry
        </Button>
      </div>
    );
  }
  return null;
}

/**
 * The one manual step GitHub's device flow requires: enter this code on
 * github.com. The flow continues on its own the moment GitHub reports the
 * authorization — no button here to confirm it.
 */
function ConnectStep(props: { userCode: string; verificationUri: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <div className="flex flex-col gap-4 py-2">
      <p className="text-sm text-muted-foreground">
        Enter this code on GitHub to sign in — sharing continues automatically
        once you approve.
      </p>
      <div className="flex items-center justify-center gap-2">
        <span className="select-all font-mono text-2xl font-semibold tracking-widest">
          {props.userCode}
        </span>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-7"
              aria-label="Copy code"
              onClick={() => {
                void copyToClipboard(props.userCode).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                });
              }}
            >
              {copied ? (
                <Check className="size-4 text-green-600" />
              ) : (
                <Copy className="size-4" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent>Copy code</TooltipContent>
        </Tooltip>
      </div>
      <Button asChild variant="outline">
        <a
          href={props.verificationUri}
          target="_blank"
          rel="noopener noreferrer"
        >
          Open github.com and enter the code
          <ExternalLink className="ml-2 size-4" aria-hidden="true" />
        </a>
      </Button>
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader size={12} />
        Waiting for you to authorize on GitHub…
      </p>
    </div>
  );
}
