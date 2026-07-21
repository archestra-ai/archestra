"use client";

import {
  pruneTrailingTrimEvents,
  validateRecordingBundle,
} from "@archestra/shared";
import {
  Check,
  Copy,
  Download,
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
  buildGallerySubmissionFiles,
  fetchGithubLogin,
  type GallerySubmissionFile,
  GithubAuthError,
  gallerySubmissionSlug,
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

  // The fallback when the automatic flow fails: hand the participant the
  // exact files the PR would have carried, plus the browser-only steps to
  // file it themselves. Uses the cached token (when sign-in got that far) to
  // spell their real GitHub login in the target path.
  const openManual = useCallback(async () => {
    abortRef.current?.abort();
    const cancellation = new AbortController();
    abortRef.current = cancellation;

    const bundle = await recordingStore.get(props.conversationId);
    const validation = bundle ? validateRecordingBundle(bundle) : null;
    if (!validation?.ok) {
      setState({
        step: "error",
        message: "No shareable recording found for this session.",
      });
      return;
    }
    const trimmed = pruneTrailingTrimEvents(validation.bundle);
    const token = takeCachedGithubToken();
    const login = token
      ? await fetchGithubLogin(token, cancellation.signal)
      : null;
    if (cancellation.signal.aborted) return;
    setState({
      step: "manual",
      files: buildGallerySubmissionFiles(trimmed),
      slug: gallerySubmissionSlug(trimmed),
      login,
    });
  }, [props.conversationId]);

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
        <ShareDialogBody
          state={state}
          repo={galleryRepo}
          onRetry={run}
          onManual={openManual}
        />
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
  | { step: "error"; message: string }
  | {
      step: "manual";
      files: GallerySubmissionFile[];
      slug: string;
      login: string | null;
    };

const STAGE_LABELS: Record<ShareProgressStage | "signing-in", string> = {
  "signing-in": "Connecting to GitHub…",
  forking: "Forking the gallery repository…",
  branching: "Creating the submission branch…",
  uploading: "Uploading the recording…",
  "opening-pr": "Opening the pull request…",
};

function ShareDialogBody(props: {
  state: ShareState;
  repo: { owner: string; name: string };
  onRetry: () => void;
  onManual: () => void;
}) {
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
        <div className="flex flex-col gap-1">
          <Button variant="outline" onClick={props.onManual}>
            Submit the pull request yourself
          </Button>
          <p className="text-xs text-muted-foreground">
            Get the exact files we would have uploaded, with step-by-step
            instructions — all in the browser.
          </p>
        </div>
      </div>
    );
  }
  if (state.step === "manual") {
    return <ManualStep {...state} repo={props.repo} />;
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

/**
 * The do-it-yourself fallback: the exact submission files (same builder the
 * automatic path commits from, so byte-identical) plus the browser-only GitHub
 * steps to file the pull request by hand. `login` personalizes the target
 * folder when sign-in got far enough to know it; otherwise a placeholder.
 */
function ManualStep(props: {
  files: GallerySubmissionFile[];
  slug: string;
  login: string | null;
  repo: { owner: string; name: string };
}) {
  const [pathCopied, setPathCopied] = useState(false);
  const copyResetTimeout = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(copyResetTimeout.current), []);

  const repoUrl = `https://github.com/${props.repo.owner}/${props.repo.name}`;
  // The exact string to paste into GitHub's new-file name box in step 3:
  // typing `/` there creates each folder, and the .gitkeep gives the commit a
  // file so the folder exists to upload into.
  const keepPath = `submissions/${props.login ?? "YOUR-GITHUB-USERNAME"}/${props.slug}/.gitkeep`;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <p className="text-sm text-muted-foreground">
          1. Download your submission — the same files we would have uploaded.
        </p>
        {props.files.map((file) => (
          <Button
            key={file.name}
            type="button"
            variant="outline"
            onClick={() => downloadSubmissionFile(file)}
          >
            <Download className="mr-2 h-4 w-4" />
            Download {file.name}
          </Button>
        ))}
      </div>

      <div className="flex flex-col gap-1 text-sm text-muted-foreground">
        <p>
          2.{" "}
          <a
            className="text-foreground underline underline-offset-2"
            href={`${repoUrl}/fork`}
            target="_blank"
            rel="noopener noreferrer"
          >
            Fork the gallery repository
            <ExternalLink className="ml-1 inline h-3 w-3" aria-hidden="true" />
          </a>{" "}
          — skip this if you already have a fork.
        </p>
        <p>
          3. In your fork, choose <b>Add file → Create new file</b> and paste
          this as the file name (typing <code>/</code> creates the folders),
          then <b>Commit changes</b> and pick <b>Create a new branch</b>:
        </p>
        <button
          type="button"
          className="flex w-fit max-w-full items-center gap-1 rounded bg-muted px-2 py-1 text-left font-mono text-xs break-all hover:bg-muted/70"
          aria-label="Copy file path"
          onClick={async () => {
            try {
              await copyToClipboard(keepPath);
              setPathCopied(true);
              clearTimeout(copyResetTimeout.current);
              copyResetTimeout.current = setTimeout(
                () => setPathCopied(false),
                2000,
              );
            } catch {
              // clipboard blocked — the path stays visible to copy manually
            }
          }}
        >
          {keepPath}
          {pathCopied ? (
            <Check className="h-3.5 w-3.5 shrink-0 text-green-500" />
          ) : (
            <Copy className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          )}
        </button>
        <p>
          4. Open the new folder and choose <b>Add file → Upload files</b>, drop
          the downloaded file{props.files.length > 1 ? "s" : ""}, and commit to
          the same branch.
        </p>
        <p>
          5. GitHub then offers <b>Compare &amp; pull request</b> — open it
          against{" "}
          <a
            className="text-foreground underline underline-offset-2"
            href={repoUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            {props.repo.owner}/{props.repo.name}
            <ExternalLink className="ml-1 inline h-3 w-3" aria-hidden="true" />
          </a>
          . Done!
        </p>
      </div>
    </div>
  );
}

/**
 * Hands one submission file to the browser as a download. The object URL is
 * revoked on a delay, exactly as the player's bundle download does: the
 * browser reads the blob asynchronously after the click, and revoking in a
 * `finally` races that read on a file big enough to matter.
 */
function downloadSubmissionFile(file: GallerySubmissionFile) {
  const blob = new Blob([file.bytes as BlobPart], { type: file.mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = file.name;
  anchor.style.display = "none";
  document.body.append(anchor);
  anchor.click();
  setTimeout(() => {
    anchor.remove();
    URL.revokeObjectURL(url);
  }, 60_000);
}
