"use client";

import {
  pruneTrailingTrimEvents,
  validateRecordingBundle,
} from "@archestra/shared";
import {
  AlertTriangle,
  Check,
  Copy,
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
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  acquireGithubToken,
  buildGallerySubmissionFiles,
  buildGallerySubmissionPr,
  DuplicateSubmissionError,
  fetchGithubLogin,
  fetchSubmittedPrState,
  forgetGallerySubmission,
  type GallerySubmissionFile,
  type GallerySubmissionStage,
  gallerySubmissionBranch,
  gallerySubmissionFolder,
  gallerySubmissionSlug,
  oversizedGallerySubmissionFile,
  recallGallerySubmission,
  rememberGallerySubmission,
  submitRecordingToAppGallery,
  takeCachedGithubToken,
} from "@/lib/app-session-recording/app-gallery-share";
import { recordingStore } from "@/lib/app-session-recording/app-recording-store";
import { copyToClipboard } from "@/lib/clipboard";
import { useFeature } from "@/lib/config/config.query";
import { cn } from "@/lib/utils";

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
  /** Why the button is disabled — shown as the tooltip instead of the pitch.
   * A node, not just text: the over-length reason carries its own fix (the
   * trim-to-limit pill). */
  disabledReason?: React.ReactNode;
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
  // rejected (closed-unmerged) PR clears the memory AND re-enables the
  // button; unverifiable changes nothing and defers to the submission's own
  // pre-flight check.
  const verifyRememberedSubmission = useCallback(
    async (signal: AbortSignal) => {
      if (!galleryRepo) return;
      const bundle = await recordingStore.get(props.conversationId);
      if (!bundle || signal.aborted) return;
      const slug = gallerySubmissionSlug(bundle);
      const remembered = recallGallerySubmission({ repo: galleryRepo, slug });
      if (!remembered) return;
      const prState = await fetchSubmittedPrState(remembered.prUrl, signal);
      if (signal.aborted) return;
      if (prState === "closed") {
        forgetGallerySubmission({ repo: galleryRepo, slug });
        setExistingPr(null);
      } else if (prState === "open" || prState === "merged") {
        setExistingPr({
          prUrl: remembered.prUrl,
          merged: prState === "merged",
        });
      }
    },
    [galleryRepo, props.conversationId],
  );

  // Verify on mount AND whenever the window regains focus: closing or
  // merging the pull request happens over on GitHub in another tab, and the
  // button must notice the moment the participant comes back — a one-shot
  // mount check left it insisting on a PR that was already closed.
  useEffect(() => {
    const verification = new AbortController();
    void verifyRememberedSubmission(verification.signal);
    const onFocus = () => void verifyRememberedSubmission(verification.signal);
    window.addEventListener("focus", onFocus);
    return () => {
      verification.abort();
      window.removeEventListener("focus", onFocus);
    };
  }, [verifyRememberedSubmission]);

  const run = useCallback(async () => {
    if (!galleryRepo) return;
    abortRef.current?.abort();
    const cancellation = new AbortController();
    abortRef.current = cancellation;
    // The error screen is titled after the step that was underway ("Upload
    // failed"), so the run tracks which one that is as it goes.
    let failedTitle = "Submission failed";
    const fail = (message: string) => {
      releaseGithubTab(githubTabRef);
      setState({ step: "error", title: failedTitle, message });
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

      // GitHub's file-size ceiling is checked right here, at the click —
      // nobody should authorize GitHub only to then learn the recording
      // can't be uploaded.
      const oversize = oversizedGallerySubmissionFile(trimmed);
      if (oversize) {
        failedTitle = "Recording too large";
        fail(oversize);
        return;
      }

      const token = takeCachedGithubToken();
      if (!token) {
        failedTitle = "Sign-in failed";
        setState({ step: "working", label: CONNECTING_LABEL });
        await acquireGithubToken({
          signal: cancellation.signal,
          onUserCode: (info) =>
            setState({
              step: "connect",
              userCode: info.userCode,
              verificationUri: info.verificationUri,
            }),
        });
        // Authorized — stop and wait for an explicit "Create Pull Request"
        // click (the token is cached, so the next run submits directly).
        // Auto-chaining into the submission right as the participant returns
        // from the GitHub tab made submission errors read as sign-in
        // failures.
        setState({ step: "ready" });
        return;
      }

      const { prUrl } = await submitRecordingToAppGallery({
        token,
        repo: galleryRepo,
        bundle: trimmed,
        signal: cancellation.signal,
        // The engine narrates each wire step with the repository, branch, or
        // file it is touching — and names the step for failure titling.
        onProgress: ({ stage, label }) => {
          failedTitle = FAILED_STEP_TITLES[stage];
          setState({ step: "working", label });
        },
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
        error instanceof Error && error.message
          ? error.message
          : "Something went wrong — try again.",
      );
    }
  }, [galleryRepo, props.conversationId]);

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
        title: "Submission failed",
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
      pr: buildGallerySubmissionPr(trimmed),
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
        void run();
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

  // Actions live in the standard sticky footer (right-aligned, full-size
  // buttons), like every other dialog in the app — the body carries content
  // only.
  // A lone footer action stretches the full width, exactly like the app's
  // sign-in page button; only the error screen's Cancel/Try-again pair keeps
  // the standard right-aligned footer row.
  const footer =
    state.step === "signin" ? (
      <Button type="button" className="w-full" onClick={() => void run()}>
        <Github />
        Sign in with GitHub
      </Button>
    ) : state.step === "ready" ? (
      <Button type="button" className="w-full" onClick={() => void run()}>
        <GitPullRequestCreateArrow />
        Create Pull Request
      </Button>
    ) : state.step === "error" ? (
      <>
        <Button
          type="button"
          variant="outline"
          onClick={() => setDialogOpen(false)}
        >
          Cancel
        </Button>
        <Button type="button" onClick={() => void run()}>
          Try again
        </Button>
      </>
    ) : state.step === "done" || state.step === "already" ? (
      // The click-backed opener that always works: an automatic open at
      // completion is popup-blocked whenever the submission ran longer than
      // the browser's ~5s user-activation window and no session GitHub tab
      // was left to navigate.
      <Button
        type="button"
        className="w-full"
        onClick={() => window.open(state.prUrl, GITHUB_TAB_NAME)}
      >
        {/* "Go to", not "Open" — opening has its own meaning for a PR. */}
        Go to Pull Request
      </Button>
    ) : null;

  const shareButton = (
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
  );

  return (
    <>
      {existingPr ? (
        // A HoverCard, not a Tooltip, because the explanation links the PR —
        // a tooltip closes before a link inside it can be clicked (same
        // reasoning as the recorder pill's hover card).
        <HoverCard openDelay={200}>
          <HoverCardTrigger asChild>{shareButton}</HoverCardTrigger>
          <HoverCardContent side="top" sideOffset={8} className="w-64 text-xs">
            {existingPr.merged ? (
              <>Already in the Apps Gallery — this app&apos;s </>
            ) : (
              <>Already submitted — this app&apos;s </>
            )}
            <a
              className={LINK_CLASS}
              href={existingPr.prUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              pull request
            </a>
            {existingPr.merged ? (
              <> was merged.</>
            ) : (
              <> is waiting for review.</>
            )}
          </HoverCardContent>
        </HoverCard>
      ) : (
        <Tooltip>
          <TooltipTrigger asChild>{shareButton}</TooltipTrigger>
          <TooltipContent sideOffset={8} className="max-w-[260px] text-xs">
            {props.disabled && props.disabledReason
              ? props.disabledReason
              : "Submit to Archestra for review!"}
          </TooltipContent>
        </Tooltip>
      )}

      <StandardDialog
        open={open}
        onOpenChange={setDialogOpen}
        // The manual screen shows the full PR description without an inner
        // scroll area, so it gets the roomier dialog.
        size={state.step === "manual" ? "medium" : "small"}
        // A mid-flight submission must not be lost to a stray outside click
        // or Esc — the X button is the one deliberate way out.
        preventCloseOnInteractOutside
        preventCloseOnEscape
        title={chrome.title}
        // No rule under the header — these are short single-purpose screens,
        // and the line just chops them in half. Centered like the app's
        // sign-in page, which this flow visually descends from.
        headerClassName="border-b-0 sm:text-center"
        description={chrome.description}
        // Screens whose whole content is the header and footer (done, the
        // sign-in gate, ready) have no body — collapse its padding.
        bodyClassName={
          state.step === "done" ||
          state.step === "signin" ||
          state.step === "ready"
            ? "py-0"
            : undefined
        }
        footer={footer}
      >
        <ShareDialogBody
          state={state}
          repo={galleryRepo}
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
              title: "Submission stopped",
              message: "No pull request was opened.",
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
  | { step: "ready" }
  | { step: "working"; label: string }
  | { step: "done"; prUrl: string }
  | { step: "already"; prUrl: string; merged: boolean }
  | { step: "error"; title: string; message: string }
  | {
      step: "manual";
      files: GallerySubmissionFile[];
      slug: string;
      pr: { title: string; body: string };
      login: string | null;
    };

/** The one working label of the auth stretch (before the engine narrates). */
const CONNECTING_LABEL = "Connecting to GitHub…";

/** The inline-link look every textual link in this flow shares. */
const LINK_CLASS = "text-foreground underline underline-offset-2";

/** Error-screen titles, named after the step that was underway. */
const FAILED_STEP_TITLES: Record<GallerySubmissionStage, string> = {
  check: "Submission check failed",
  fork: "Fork failed",
  branch: "Branch creation failed",
  upload: "Upload failed",
  pr: "Pull request failed",
};

/** Sign-in gate through GitHub authorization — the "connect your account" stretch. */
function authPhase(state: ShareState): boolean {
  return (
    state.step === "signin" ||
    state.step === "connect" ||
    (state.step === "working" && state.label === CONNECTING_LABEL)
  );
}

/**
 * Every screen's title states its goal or outcome — authorizing, submitting,
 * "<step> failed", done — and only screens whose body doesn't already say it
 * all get a description. The gallery pitch lives in the button tooltip and
 * the done screen, not repeated over every state.
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
  if (state.step === "ready") {
    return { title: "Ready to submit" };
  }
  if (state.step === "working") {
    return { title: "Submitting your demo…" };
  }
  if (state.step === "error") {
    return { title: state.title };
  }
  if (state.step === "already") {
    return {
      title: state.merged ? "Already in the Apps Gallery" : "Already submitted",
    };
  }
  if (state.step === "manual") {
    return { title: "Submit your demo manually" };
  }
  if (state.step === "done") {
    return {
      title: (
        <span className="flex items-center justify-center gap-2">
          <Check className="h-5 w-5 text-green-500" aria-hidden="true" />
          Done.
        </span>
      ),
      // No link on "Pull Request" here — the full-width button right below
      // is the way to it, and a second link would just duplicate it.
      description: (
        <>
          Your App demo will be showcased in the <GalleryLink repo={repo} />{" "}
          once Archestra team approves your Pull Request.
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
  onManual: () => void;
  onOpenGithub: (verificationUri: string) => void;
  onCancelAuth: () => void;
  onCancelWork: () => void;
}) {
  const { state } = props;

  // "signin" and "ready" are header+footer screens: the description (or the
  // title) says it all, and their single action lives in the footer. The
  // sign-in gate stays deliberately inert — no device-code request leaves
  // until the footer button is clicked.
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
    // The duplicate guard tripped: explain instead of pretending anything
    // failed. Plain text — the footer's Go to Pull Request button is the
    // way to the PR.
    return (
      <p className="text-center text-sm">
        {state.merged
          ? "This app is already in the Apps Gallery — its pull request was merged."
          : "This app was already submitted — its pull request is waiting for review."}
      </p>
    );
  }
  if (state.step === "error") {
    // The title already blames the step; the body is the app's standard
    // destructive Alert plus the quieter manual workaround. Cancel and Try
    // again live in the footer like every other dialog's actions.
    return (
      <div className="flex flex-col gap-3">
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>{state.message}</AlertDescription>
        </Alert>
        <button
          type="button"
          className="w-fit text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
          onClick={props.onManual}
        >
          Learn how to submit your demo manually.
        </button>
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
 * The do-it-yourself fallback, kept to the facts: the exact files (same
 * builder the automatic path commits from, so byte-identical), the branch
 * and folder the submission lives on, and the PR title/body the automatic
 * path would have filed — each click-to-copy. `login` personalizes the
 * folder when sign-in got far enough to know it; otherwise a placeholder.
 */
function ManualStep(props: {
  files: GallerySubmissionFile[];
  slug: string;
  pr: { title: string; body: string };
  login: string | null;
  repo: { owner: string; name: string };
}) {
  const repoUrl = `https://github.com/${props.repo.owner}/${props.repo.name}`;
  const plural = props.files.length > 1 ? "s" : "";

  // Regular chat-sized text — these are instructions, not fine print.
  return (
    <div className="flex flex-col gap-2 text-sm text-muted-foreground">
      <p>
        1. Download{" "}
        {props.files.map((file, index) => (
          <span key={file.name}>
            {index > 0 && " and "}
            <button
              type="button"
              className={LINK_CLASS}
              onClick={() => downloadSubmissionFile(file)}
            >
              {file.name}
            </button>
          </span>
        ))}{" "}
        bundle file{plural}.
      </p>
      <p>
        2.{" "}
        <a
          className={LINK_CLASS}
          href={`${repoUrl}/fork`}
          target="_blank"
          rel="noopener noreferrer"
        >
          Fork the Apps Hackathon repository
        </a>
        .
      </p>
      <div className="flex flex-wrap items-center gap-1.5">
        <span>3. Create new branch</span>
        <CopyChip text={gallerySubmissionBranch(props.slug)} />
      </div>
      {/* The folder is the gallery's one predictable pattern —
          apps/<login>_<slug>/ — that the site walks to build its grid, so
          the manual path must spell it exactly. */}
      <div className="flex flex-wrap items-center gap-1.5">
        <span>4. Put bundle file{plural} into folder</span>
        <CopyChip
          text={gallerySubmissionFolder(
            props.login ?? "YOUR-GITHUB-USERNAME",
            props.slug,
          )}
        />
      </div>
      <p>
        5. <b>Compare &amp; pull request</b> to{" "}
        <a
          className={LINK_CLASS}
          href={repoUrl}
          target="_blank"
          rel="noopener noreferrer"
        >
          {props.repo.owner}/{props.repo.name}
        </a>
        :main.
      </p>
      <div className="flex flex-col gap-1.5">
        <span>6. Copy PR title</span>
        <CopyChip text={props.pr.title} />
      </div>
      <div className="flex flex-col gap-1.5">
        <span>7. Copy PR description</span>
        <CopyChip text={props.pr.body} multiline />
      </div>
    </div>
  );
}

/**
 * A click-to-copy chip: the exact string to use, mono, with a copied check.
 * `multiline` renders a scrollable block for content like the PR body.
 */
function CopyChip(props: { text: string; multiline?: boolean }) {
  const [copied, setCopied] = useState(false);
  const resetTimeout = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(resetTimeout.current), []);

  return (
    <button
      type="button"
      className={cn(
        "flex w-fit max-w-full items-start gap-1 rounded bg-muted px-2 py-1 text-left font-mono text-sm hover:bg-muted/70",
        // No inner scroll on multiline content — the chip shows all of it,
        // and the dialog body scrolls only if a screen truly overflows.
        props.multiline
          ? "whitespace-pre-wrap break-words"
          : "items-center break-all",
      )}
      aria-label="Copy"
      onClick={async () => {
        try {
          await copyToClipboard(props.text);
          setCopied(true);
          clearTimeout(resetTimeout.current);
          resetTimeout.current = setTimeout(() => setCopied(false), 2000);
        } catch {
          // clipboard blocked — the text stays visible to copy manually
        }
      }}
    >
      <span className="min-w-0 flex-1">{props.text}</span>
      {copied ? (
        <Check className="h-4 w-4 shrink-0 text-green-500" />
      ) : (
        <Copy className="h-4 w-4 shrink-0 text-muted-foreground" />
      )}
    </button>
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
// exists long after the last click — a plain open at completion is usually
// eaten. So the sign-in run claims the GitHub device-code tab (opened by its
// own click in ConnectStep) and NAVIGATES it to the finished PR — navigating
// a window this page opened needs no popup permission, and the participant
// just approved there anyway. The window name keeps repeat clicks reusing
// one tab. Cached-token runs deliberately claim NOTHING: a tab opened at the
// Share/Retry click steals focus from the dialog mid-submission (it read as
// flickering), so they rely on the best-effort open at completion plus the
// dialog's own links.

const GITHUB_TAB_NAME = "archestra-app-gallery-github";

type GithubTabRef = { current: Window | null };

/**
 * Open (or re-point) the named GitHub tab and keep its handle. Deliberately
 * NO "noopener" — that would return null, and the handle is the whole point.
 */
function claimGithubTab(ref: GithubTabRef, url: string): Window | null {
  const tab = window.open(url, GITHUB_TAB_NAME);
  if (tab) ref.current = tab;
  return tab;
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
  // No live handle. Opening by NAME: if this session's GitHub tab is still
  // around (sign-in leaves one), browsers treat this as navigating that
  // existing tab — allowed even without a fresh click. Only when the name
  // resolves to nothing does this become a new-popup request, which this
  // far from a click a blocker refuses — the Go to Pull Request button on
  // the done screen covers that case with a real click.
  window.open(prUrl, GITHUB_TAB_NAME);
}

/** Forget the claimed tab — the participant's GitHub page is left to them. */
function releaseGithubTab(ref: GithubTabRef): void {
  ref.current = null;
}
