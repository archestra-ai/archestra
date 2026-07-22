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
  GitPullRequestCreateArrow,
  Loader2,
} from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
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
  DuplicateSubmissionError,
  fetchGithubLogin,
  fetchSubmittedPrState,
  forgetGallerySubmission,
  type GallerySubmissionFile,
  GithubAuthError,
  gallerySubmissionSlug,
  recallGallerySubmission,
  rememberGallerySubmission,
  submitRecordingToAppGallery,
  takeCachedGithubToken,
} from "@/lib/app-session-recording/app-gallery-share";
import { recordingStore } from "@/lib/app-session-recording/app-recording-store";
import { copyToClipboard } from "@/lib/clipboard";
import { useFeature } from "@/lib/config/config.query";

/**
 * The player's "Submit to Archestra for review" action: one click runs GitHub
 * sign-in (device flow, first share only), files the pull request from the
 * participant's own account, and lands the finished PR in a browser tab
 * claimed while a click was still in hand (see "The pull-request tab" below —
 * popup blockers eat anything later). One app gets ONE submission: a
 * remembered or discovered open/merged PR disables the button and every rerun
 * stops at the existing PR instead of filing a duplicate. Renders nothing on
 * deployments that don't offer the gallery.
 */
export function AppGalleryShareButton(props: {
  conversationId: string;
  disabled: boolean;
  /** Why the button is disabled — shown as the tooltip instead of the pitch. */
  disabledReason?: string;
}) {
  const galleryRepo = useFeature("hackathonGalleryRepo");
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<ShareState>({ step: "idle" });
  // The pull request this app already has (submitted now or remembered from
  // before) — what disables the button against duplicate submissions.
  const [existingPr, setExistingPr] = useState<{
    prUrl: string;
    merged: boolean;
  } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const githubTabRef = useRef<Window | null>(null);

  // The button-level duplicate guard: a submission remembered in this browser
  // is verified against GitHub — still open or merged disables the button; a
  // rejected (closed-unmerged) PR clears the memory so the participant can
  // resubmit; unverifiable leaves the button alone and defers to the
  // submission's own pre-flight check.
  useEffect(() => {
    if (!galleryRepo) return;
    const verification = new AbortController();
    void (async () => {
      const bundle = await recordingStore.get(props.conversationId);
      if (!bundle || verification.signal.aborted) return;
      const slug = gallerySubmissionSlug(bundle);
      const remembered = recallGallerySubmission({ repo: galleryRepo, slug });
      if (!remembered) return;
      const prState = await fetchSubmittedPrState(
        remembered.prUrl,
        verification.signal,
      );
      if (verification.signal.aborted) return;
      if (prState === "closed") {
        forgetGallerySubmission({ repo: galleryRepo, slug });
        setExistingPr(null);
      } else if (prState === "open" || prState === "merged") {
        setExistingPr({
          prUrl: remembered.prUrl,
          merged: prState === "merged",
        });
      }
    })();
    return () => verification.abort();
  }, [galleryRepo, props.conversationId]);

  const run = useCallback(async () => {
    if (!galleryRepo) return;
    abortRef.current?.abort();
    const cancellation = new AbortController();
    abortRef.current = cancellation;
    const fail = (message: string) => {
      releaseGithubTab(githubTabRef);
      setState({ step: "error", message });
    };
    let slug: string | null = null;

    try {
      const bundle = await recordingStore.get(props.conversationId);
      if (!bundle) {
        fail("No recording to share for this session.");
        return;
      }
      const validation = validateRecordingBundle(bundle);
      if (!validation.ok) {
        fail(`This recording can't be shared. ${validation.reason}`);
        return;
      }
      // Same size trim the video export ships (renders identically).
      const trimmed = pruneTrailingTrimEvents(validation.bundle);
      slug = gallerySubmissionSlug(trimmed);

      let token = takeCachedGithubToken();
      if (!token) {
        setState({ step: "working", label: CONNECTING_LABEL });
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

      const { prUrl } = await submitRecordingToAppGallery({
        token,
        repo: galleryRepo,
        bundle: trimmed,
        signal: cancellation.signal,
        // The engine narrates each wire step with the repository, branch, or
        // file it is touching.
        onProgress: (label) => setState({ step: "working", label }),
      });
      // Remembered so the button stays disabled on the next visit — with the
      // engine's pre-flight check backing this up server-side regardless.
      rememberGallerySubmission({ repo: galleryRepo, slug, prUrl });
      setExistingPr({ prUrl, merged: false });
      setState({ step: "done", prUrl });
      showPrInGithubTab(githubTabRef, prUrl);
    } catch (error) {
      if (cancellation.signal.aborted) return;
      if (error instanceof DuplicateSubmissionError) {
        // Not a failure — point every affordance (dialog, button tooltip,
        // and the claimed tab) at the submission that already exists.
        if (slug) {
          rememberGallerySubmission({
            repo: galleryRepo,
            slug,
            prUrl: error.prUrl,
          });
        }
        setExistingPr({ prUrl: error.prUrl, merged: error.merged });
        setState({ step: "already", prUrl: error.prUrl, merged: error.merged });
        showPrInGithubTab(githubTabRef, error.prUrl);
        return;
      }
      fail(
        error instanceof GithubAuthError
          ? `${error.message} Retry to sign in again.`
          : error instanceof Error
            ? error.message
            : "Sharing failed.",
      );
    }
  }, [galleryRepo, props.conversationId]);

  // Popup blockers only honor window.open during a click. With a token
  // already cached this click goes straight to submission, so the tab that
  // will hold the pull request is claimed NOW, as a placeholder. (First-time
  // runs claim the GitHub sign-in tab from its own click in ConnectStep.)
  const startRun = useCallback(() => {
    if (takeCachedGithubToken()) claimPlaceholderTab(githubTabRef);
    void run();
  }, [run]);

  // The fallback when the automatic flow fails: hand the participant the
  // exact files the PR would have carried, plus the browser-only steps to
  // file it themselves. Uses the cached token (when sign-in got that far) to
  // spell their real GitHub login in the target path.
  const openManual = useCallback(async () => {
    abortRef.current?.abort();
    releaseGithubTab(githubTabRef);
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

  // The flow runs while the dialog is up; closing it is the cancel. A first
  // open with no cached token lands on the sign-in gate and TOUCHES NOTHING —
  // no device-code request leaves until the participant clicks Sign in. With
  // a token already in hand the submission starts straight away.
  const setDialogOpen = (next: boolean) => {
    setOpen(next);
    if (next) {
      if (takeCachedGithubToken()) {
        startRun();
      } else {
        setState({ step: "signin" });
      }
    } else {
      abortRef.current?.abort();
      releaseGithubTab(githubTabRef);
      setState({ step: "idle" });
    }
  };

  useEffect(
    () => () => {
      abortRef.current?.abort();
      releaseGithubTab(githubTabRef);
    },
    [],
  );

  if (!galleryRepo) return null;

  const chrome = dialogChrome(state, galleryRepo);

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex" data-tour="share">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-7 text-muted-foreground hover:text-foreground"
              aria-label="Submit this session to Archestra for review"
              disabled={props.disabled || existingPr !== null}
              onClick={() => setDialogOpen(true)}
            >
              {/* The create-a-pull-request glyph, not a generic share icon —
                  what the button does IS filing a PR, and participants know
                  the shape from GitHub itself. */}
              <GitPullRequestCreateArrow className="size-4" />
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent sideOffset={8} className="max-w-[260px] text-xs">
          {existingPr
            ? existingPr.merged
              ? "Already in the Apps Gallery — this app's pull request was merged."
              : "Already submitted — this app's pull request is waiting for review."
            : props.disabled && props.disabledReason
              ? props.disabledReason
              : "Submit to Archestra for review!"}
        </TooltipContent>
      </Tooltip>

      <StandardDialog
        open={open}
        onOpenChange={setDialogOpen}
        size="small"
        title={chrome.title}
        // No rule under the header — these are short single-purpose screens,
        // and the line just chops them in half.
        headerClassName="border-b-0"
        description={chrome.description}
        // "done" has no body at all — collapse its padding so the dialog ends
        // cleanly under the description.
        bodyClassName={state.step === "done" ? "py-0" : undefined}
      >
        <ShareDialogBody
          state={state}
          repo={galleryRepo}
          onRetry={startRun}
          onManual={openManual}
          onOpenGithub={(verificationUri) =>
            claimGithubTab(githubTabRef, verificationUri)
          }
          // Backing out of a slow sign-in returns to the inert gate; stopping
          // a slow submission lands on the error card (Retry starts a fresh
          // branch, so a half-made submission is never resumed).
          onCancelAuth={() => {
            abortRef.current?.abort();
            releaseGithubTab(githubTabRef);
            setState({ step: "signin" });
          }}
          onCancelWork={() => {
            abortRef.current?.abort();
            releaseGithubTab(githubTabRef);
            setState({
              step: "error",
              message: "Stopped — no pull request was opened.",
            });
          }}
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
  | { step: "signin" }
  | { step: "connect"; userCode: string; verificationUri: string }
  | { step: "working"; label: string }
  | { step: "done"; prUrl: string }
  | { step: "already"; prUrl: string; merged: boolean }
  | { step: "error"; message: string }
  | {
      step: "manual";
      files: GallerySubmissionFile[];
      slug: string;
      login: string | null;
    };

/** The one working label of the auth stretch (before the engine narrates). */
const CONNECTING_LABEL = "Connecting to GitHub…";

/** The inline-link look every textual link in this flow shares. */
const LINK_CLASS = "text-foreground underline underline-offset-2";

/** Sign-in gate through GitHub authorization — the "connect your account" stretch. */
function authPhase(state: ShareState): boolean {
  return (
    state.step === "signin" ||
    state.step === "connect" ||
    (state.step === "working" && state.label === CONNECTING_LABEL)
  );
}

/**
 * Each screen's header speaks for itself: the auth stretch talks about
 * authorizing, the submission stretch is a bare "Submitting…" over the
 * narrated progress line (the pitch would be redundant there), done carries
 * the checkmark and links the results, and everything else pitches the
 * gallery.
 */
function dialogChrome(
  state: ShareState,
  repo: { owner: string; name: string },
): { title: ReactNode; description?: ReactNode } {
  if (authPhase(state)) {
    return {
      title: "Authorize Archestra to GitHub",
      description:
        "Once authorized, Archestra will create a pull request to the Apps Hackathon repository on GitHub for you.",
    };
  }
  if (state.step === "working") {
    return { title: "Submitting your demo…" };
  }
  if (state.step === "done") {
    return {
      title: (
        <span className="flex items-center gap-2">
          <Check className="h-5 w-5 text-green-500" aria-hidden="true" />
          Done.
        </span>
      ),
      description: (
        <>
          Your App demo will be showcased in the <GalleryLink repo={repo} />{" "}
          once Archestra team approves your{" "}
          <a
            className={LINK_CLASS}
            href={state.prUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            Pull Request
          </a>
          .
        </>
      ),
    };
  }
  return {
    title: "Submit to Archestra for review!",
    description: (
      <>
        Your App demo will be showcased in the <GalleryLink repo={repo} /> once
        Archestra team approves the Pull Request.
      </>
    ),
  };
}

function GalleryLink(props: { repo: { owner: string; name: string } }) {
  return (
    <a
      className={LINK_CLASS}
      href={`https://github.com/${props.repo.owner}/${props.repo.name}`}
      target="_blank"
      rel="noopener noreferrer"
    >
      Apps Gallery
    </a>
  );
}

function ShareDialogBody(props: {
  state: ShareState;
  repo: { owner: string; name: string };
  onRetry: () => void;
  onManual: () => void;
  onOpenGithub: (verificationUri: string) => void;
  onCancelAuth: () => void;
  onCancelWork: () => void;
}) {
  const { state } = props;

  if (state.step === "signin") {
    // Deliberately inert until clicked — mirrors the Copilot provider form's
    // resting state; the click is what fires the device-code request.
    return (
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="w-fit"
        onClick={props.onRetry}
      >
        <Github className="mr-2 h-4 w-4" />
        Sign in with GitHub
      </Button>
    );
  }
  if (state.step === "connect") {
    return (
      <ConnectStep
        {...state}
        onOpenGithub={props.onOpenGithub}
        onCancel={props.onCancelAuth}
      />
    );
  }
  if (state.step === "working") {
    return <WorkingStep label={state.label} onCancel={props.onCancelWork} />;
  }
  if (state.step === "already") {
    // The duplicate guard tripped: explain and link the PR this app already
    // has instead of pretending anything failed.
    return (
      <p className="text-sm">
        {state.merged ? (
          <>This app is already in the Apps Gallery — its </>
        ) : (
          <>This app was already submitted — its </>
        )}
        <a
          className={LINK_CLASS}
          href={state.prUrl}
          target="_blank"
          rel="noopener noreferrer"
        >
          pull request
          <ExternalLink className="ml-1 inline h-3 w-3" aria-hidden="true" />
        </a>
        {state.merged ? <> was merged.</> : <> is waiting for review.</>}
      </p>
    );
  }
  if (state.step === "error") {
    return (
      <div className="flex flex-col gap-2">
        <p className="text-sm text-destructive">{state.message}</p>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={props.onRetry}>
            Retry
          </Button>
          <Button variant="outline" size="sm" onClick={props.onManual}>
            Submit the pull request yourself
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          "Submit yourself" gives you the exact files we would have uploaded,
          with step-by-step instructions — all in the browser.
        </p>
      </div>
    );
  }
  if (state.step === "manual") {
    return <ManualStep {...state} repo={props.repo} />;
  }
  // "done" needs no body: the title carries the checkmark and the
  // description links both the gallery and the pull request itself.
  return null;
}

/**
 * The one manual step GitHub's device flow requires: enter the one-time code
 * on github.com. Same interaction as the GitHub Copilot provider sign-in
 * (`github-copilot-sign-in.tsx`): one small outline button copies the code and
 * opens GitHub — copy must happen first, while the document still has focus,
 * or the Clipboard API refuses the write; GitHub can't pre-fill the field (it
 * omits RFC 8628's verification_uri_complete). The visible code doubles as a
 * click-to-copy fallback. The flow continues on its own the moment GitHub
 * reports the authorization. The GitHub tab opens through the parent, which
 * keeps its handle — after approval that same tab is pointed at the finished
 * pull request.
 */
function ConnectStep(props: {
  userCode: string;
  verificationUri: string;
  onOpenGithub: (verificationUri: string) => void;
  onCancel: () => void;
}) {
  const [codeCopied, setCodeCopied] = useState(false);
  const copyResetTimeout = useRef<ReturnType<typeof setTimeout>>(undefined);
  // The device code lives ~15 minutes, so the flow itself is patient; this
  // only surfaces the way back out once the wait stops feeling deliberate.
  const slow = useSlowHint(60_000);

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

  // The Copilot sign-in card verbatim: bordered card, xs helper line, then
  // ONE ROW — small outline action, code chip, waiting spinner — so nothing
  // renders as a full-width slab.
  return (
    <div className="space-y-2 rounded-md border p-3">
      <p className="text-xs text-muted-foreground">
        Click below to copy the code and open GitHub, then paste it and approve.
        GitHub can&apos;t pre-fill the code, so you&apos;ll paste it there.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={async () => {
            await copyCode();
            props.onOpenGithub(props.verificationUri);
          }}
        >
          <Github className="mr-2 h-4 w-4" />
          Copy code &amp; open GitHub
        </Button>
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
      {slow && (
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-xs text-muted-foreground">
            Taking longer than expected — approve on GitHub, or cancel.
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={props.onCancel}
          >
            Cancel
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * One submission wire step, named in full — plus, once the wait stops
 * feeling instant, the way out. Forty seconds of fork preparation is normal
 * GitHub weather; the hint keeps that from reading as a hang.
 */
function WorkingStep(props: { label: string; onCancel: () => void }) {
  const slow = useSlowHint(20_000);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
        <span className="break-all">{props.label}</span>
      </div>
      {slow && (
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-xs text-muted-foreground">
            Still working — GitHub can be slow to prepare a fork.
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={props.onCancel}
          >
            Cancel
          </Button>
        </div>
      )}
    </div>
  );
}

/** True once the current step has been on screen for `ms`. */
function useSlowHint(ms: number): boolean {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), ms);
    return () => clearTimeout(timer);
  }, [ms]);
  return slow;
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

  // Same compact language as the connect card: xs muted copy, small outline
  // actions that hug their label instead of stretching into slabs.
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2">
        <p className="text-xs text-muted-foreground">
          1. Download your submission — the same files we would have uploaded.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {props.files.map((file) => (
            <Button
              key={file.name}
              type="button"
              variant="outline"
              size="sm"
              onClick={() => downloadSubmissionFile(file)}
            >
              <Download className="mr-2 h-4 w-4" />
              Download {file.name}
            </Button>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-1.5 text-xs text-muted-foreground">
        <p>
          2.{" "}
          <a
            className={LINK_CLASS}
            href={`${repoUrl}/fork`}
            target="_blank"
            rel="noopener noreferrer"
          >
            Fork the Apps Hackathon repository
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
            className={LINK_CLASS}
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

// =============================================================================
// The pull-request tab
// =============================================================================
//
// Popup blockers only honor window.open during a user gesture, and the PR URL
// exists long after the last click — a plain open at completion is silently
// eaten. So the flow claims a tab while it still HAS a gesture and navigates
// it later (navigating a window this page opened needs no popup permission):
// sign-in runs claim the GitHub device-code tab the participant approves in;
// cached-token runs claim a placeholder at the Share/Retry click itself. One
// shared window name keeps repeat clicks reusing a single tab.

const GITHUB_TAB_NAME = "archestra-app-gallery-github";

type GithubTabRef = { current: Window | null };

/**
 * Open (or re-point) the named helper tab and keep its handle. Deliberately
 * NO "noopener" — that would return null, and the handle is the whole point;
 * the tab only ever holds github.com or this page's own placeholder.
 */
function claimGithubTab(ref: GithubTabRef, url: string): Window | null {
  const tab = window.open(url, GITHUB_TAB_NAME);
  if (tab) ref.current = tab;
  return tab;
}

/** Claim a blank tab now (during the click) for a PR that doesn't exist yet. */
function claimPlaceholderTab(ref: GithubTabRef): void {
  const tab = claimGithubTab(ref, "about:blank");
  if (!tab) return;
  try {
    tab.document.title = "Opening pull request…";
    tab.document.body.textContent = "Preparing your pull request on GitHub…";
    tab.document.body.style.cssText =
      "font-family:system-ui,sans-serif;padding:2rem;color:#555";
  } catch {
    // A reused tab can still be on github.com from an earlier run — cosmetic
    // only, it gets the real PR URL either way.
  }
}

/** Land the finished (or already-existing) pull request in the claimed tab. */
function showPrInGithubTab(ref: GithubTabRef, prUrl: string): void {
  const tab = ref.current;
  ref.current = null;
  if (tab && !tab.closed) {
    try {
      tab.location.href = prUrl;
      tab.focus();
      return;
    } catch {
      // fall through to a fresh open
    }
  }
  // No claimed tab (or the participant closed it). This far from a click a
  // popup blocker usually eats the open — the dialog links the PR regardless.
  window.open(prUrl, "_blank", "noopener");
}

/** Forget the claimed tab, closing it only while it is still our placeholder. */
function releaseGithubTab(ref: GithubTabRef): void {
  const tab = ref.current;
  ref.current = null;
  if (!tab || tab.closed) return;
  try {
    if (tab.location.href === "about:blank") tab.close();
  } catch {
    // Cross-origin means the participant's GitHub page — leave it to them.
  }
}
