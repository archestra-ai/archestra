"use client";

import {
  pruneTrailingTrimEvents,
  validateRecordingBundle,
} from "@archestra/shared";
import {
  Check,
  Copy,
  ExternalLink,
  Github,
  Loader2,
  Share2,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { StandardDialog } from "@/components/standard-dialog";
import { Button } from "@/components/ui/button";
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

      <StandardDialog
        open={open}
        onOpenChange={setDialogOpen}
        size="small"
        title="Share to the App Gallery"
        description="Your recording is submitted as a pull request from your own GitHub account. Nothing is published before it is reviewed."
      >
        <ShareDialogBody state={state} onRetry={run} />
      </StandardDialog>
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
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        {STAGE_LABELS[state.stage]}
      </div>
    );
  }
  if (state.step === "done") {
    return (
      <div className="flex flex-col gap-3">
        <p className="flex items-center gap-2 text-sm">
          <Check className="h-4 w-4 text-green-500" aria-hidden="true" />
          Your pull request is open — it opened in a new tab.
        </p>
        <Button asChild>
          <a href={state.prUrl} target="_blank" rel="noopener noreferrer">
            Open the pull request
            <ExternalLink className="ml-2 h-4 w-4" aria-hidden="true" />
          </a>
        </Button>
      </div>
    );
  }
  if (state.step === "error") {
    return (
      <div className="flex flex-col gap-3">
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
 * The one manual step GitHub's device flow requires: enter the one-time code
 * on github.com. Same interaction as the GitHub Copilot provider sign-in
 * (`github-copilot-sign-in.tsx`): ONE primary button copies the code and then
 * opens GitHub — copy must happen first, while the document still has focus,
 * or the Clipboard API refuses the write; GitHub can't pre-fill the field (it
 * omits RFC 8628's verification_uri_complete). The visible code doubles as a
 * click-to-copy fallback. The flow continues on its own the moment GitHub
 * reports the authorization.
 */
function ConnectStep(props: { userCode: string; verificationUri: string }) {
  const [codeCopied, setCodeCopied] = useState(false);
  const copyResetTimeout = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => () => clearTimeout(copyResetTimeout.current), []);

  const markCopied = () => {
    setCodeCopied(true);
    clearTimeout(copyResetTimeout.current);
    copyResetTimeout.current = setTimeout(() => setCodeCopied(false), 2000);
  };

  const copyCode = async () => {
    try {
      await copyToClipboard(props.userCode);
      markCopied();
    } catch {
      // clipboard blocked (permissions/focus) — the visible code stays as the
      // manual fallback
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        Click below to copy the code and open GitHub, then paste it and approve.
        Sharing continues automatically once you authorize.
      </p>
      <Button
        type="button"
        onClick={async () => {
          await copyCode();
          window.open(props.verificationUri, "_blank", "noopener,noreferrer");
        }}
      >
        <Github className="mr-2 h-4 w-4" />
        Copy code &amp; open GitHub
      </Button>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="flex items-center gap-1 rounded bg-muted px-2 py-1 font-mono text-sm tracking-widest hover:bg-muted/70"
          aria-label="Copy code"
          onClick={copyCode}
        >
          {props.userCode}
          {codeCopied ? (
            <Check className="h-4 w-4 text-green-500" />
          ) : (
            <Copy className="h-4 w-4 text-muted-foreground" />
          )}
        </button>
        <span className="flex items-center gap-1 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          Waiting for authorization…
        </span>
      </div>
    </div>
  );
}
