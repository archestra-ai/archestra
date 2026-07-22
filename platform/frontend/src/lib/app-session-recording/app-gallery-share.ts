import { archestraApiSdk, slugify } from "@archestra/shared";
import type { AppRecordingBundle } from "@/lib/app-session-recording/app-recording-store";

/**
 * Shares a recorded app session to the public App Gallery as a pull request
 * filed by the participant's own GitHub account.
 *
 * The backend only relays the GitHub device flow (github.com's OAuth endpoints
 * refuse browser CORS); everything else here talks straight to api.github.com,
 * which allows it. The recording bundle therefore never transits our server on
 * its way to the gallery, and the token GitHub hands back lives in this
 * module's memory for the tab's lifetime — it is never persisted anywhere.
 *
 * The submission is the standard fork workflow, so it needs nothing but the
 * `public_repo` scope the device flow asked for: fork the gallery repository,
 * branch the fork, commit the bundle (and a thumbnail when the recording
 * carries canvas frames), then open the pull request on the gallery.
 *
 * One app, one submission: the branch name is stable per participant+app, and
 * an open or merged pull request from it blocks a duplicate — checked up
 * front and re-checked at each step that could mint one, so even racing runs
 * end up pointed at the one existing PR instead of filing another.
 */

interface AppGalleryRepo {
  owner: string;
  name: string;
}

/** GitHub said the token no longer works — the caller should sign in again. */
export class GithubAuthError extends Error {}

/**
 * This app already has a live submission — an open or merged pull request
 * from this participant. Carries that PR so the caller links it instead of
 * filing a duplicate. (A closed-unmerged PR — a rejection — never raises
 * this; rejected apps may genuinely be resubmitted.)
 */
export class DuplicateSubmissionError extends Error {
  readonly prUrl: string;
  readonly merged: boolean;

  constructor(existing: { prUrl: string; merged: boolean }) {
    super(
      existing.merged
        ? "This app is already in the gallery."
        : "This app was already submitted.",
    );
    this.prUrl = existing.prUrl;
    this.merged = existing.merged;
  }
}

/** The participant's GitHub token, kept for the tab's lifetime only. */
let cachedToken: string | null = null;

export function takeCachedGithubToken(): string | null {
  return cachedToken;
}

export function dropCachedGithubToken(): void {
  cachedToken = null;
}

/**
 * Runs the device flow to a token: starts it, hands the user code to the UI,
 * then polls at GitHub's requested interval until the participant authorizes.
 * Resolves with the token (also cached for later shares this tab).
 */
export async function acquireGithubToken(params: {
  onUserCode: (info: { userCode: string; verificationUri: string }) => void;
  signal: AbortSignal;
}): Promise<string> {
  const { data, error } = await archestraApiSdk.appGalleryDeviceAuthStart();
  if (error || !data) {
    throw new Error(
      apiErrorMessage(error) ?? "Could not start the GitHub sign-in.",
    );
  }
  params.onUserCode({
    userCode: data.userCode,
    verificationUri: data.verificationUri,
  });

  const deadline = Date.now() + data.expiresIn * 1000;
  let waitSeconds = data.interval;
  // A poll that fails for reasons other than GitHub's verdict — a network
  // blip, a relay hiccup — must not kill a sign-in the participant is halfway
  // through on github.com. Ride out a short streak; only a deliberate refusal
  // (the backend's 400s: expired, declined) ends the flow early.
  let failureStreak = 0;
  while (Date.now() < deadline) {
    await sleep(waitSeconds * 1000, params.signal);
    let poll: Awaited<
      ReturnType<typeof archestraApiSdk.appGalleryDeviceAuthPoll>
    > | null = null;
    try {
      poll = await archestraApiSdk.appGalleryDeviceAuthPoll({
        body: { deviceCode: data.deviceCode },
      });
    } catch {
      // network-level failure — transient; handled below
    }
    if (!poll || poll.error || !poll.data) {
      if (apiErrorType(poll?.error) === "api_validation_error") {
        throw new Error(
          apiErrorMessage(poll?.error) ?? "GitHub sign-in failed.",
        );
      }
      if (++failureStreak >= 5) {
        throw new Error("GitHub sign-in keeps failing — try again.");
      }
      continue;
    }
    failureStreak = 0;
    if (poll.data.status === "complete") {
      cachedToken = poll.data.accessToken;
      return poll.data.accessToken;
    }
    if (poll.data.status === "slow_down") {
      waitSeconds += 5;
    }
  }
  throw new Error(
    "The GitHub sign-in expired before it was authorized — start again.",
  );
}

/** The wire step a submission is on — what an error screen names as failed. */
export type GallerySubmissionStage =
  | "check"
  | "fork"
  | "branch"
  | "upload"
  | "pr";

/**
 * The whole submission, token to pull-request URL. Throws
 * `DuplicateSubmissionError` when this app already has an open or merged PR
 * (the dialog links it), `GithubAuthError` when GitHub rejects the token (the
 * dialog restarts the sign-in), a plain `Error` with GitHub's own message
 * otherwise.
 */
export async function submitRecordingToAppGallery(params: {
  token: string;
  repo: AppGalleryRepo;
  bundle: AppRecordingBundle;
  signal: AbortSignal;
  /**
   * Called as each wire step starts: `stage` identifies the step (the error
   * screen titles a failure after it), `label` is a short human sentence
   * naming the actual repository, branch, or file being touched, so the
   * dialog narrates what is really happening rather than a generic stage
   * word.
   */
  onProgress: (progress: {
    stage: GallerySubmissionStage;
    label: string;
  }) => void;
}): Promise<{ prUrl: string }> {
  const { token, repo, bundle, signal, onProgress } = params;
  const gh = makeGithubClient(token, signal);
  const galleryName = `github.com/${repo.owner}/${repo.name}`;

  // The branch name is deliberately STABLE per participant+app — no
  // timestamp. That is what makes a duplicate recognizable at all: the
  // pre-flight below finds any open/merged PR from it, and GitHub itself
  // refuses a second branch or second PR under the same name if two runs
  // race past the check.
  const appSlug = gallerySubmissionSlug(bundle);
  const branch = gallerySubmissionBranch(appSlug);

  // Backstop only — the dialog runs this same check at the Share click,
  // before the participant is asked to sign in to anything. GitHub would
  // refuse an oversized file as opaque 5xx weather mid-flow.
  const oversize = oversizedGallerySubmissionFile(bundle);
  if (oversize) throw new Error(oversize);

  onProgress({
    stage: "check",
    label: `Checking ${galleryName} for an existing submission…`,
  });
  const viewer = await gh<{ login: string }>("GET", "/user");
  const existing = await findBlockingPullRequest({
    gh,
    repo,
    login: viewer.login,
    branch,
  });
  if (existing) throw new DuplicateSubmissionError(existing);

  onProgress({
    stage: "fork",
    label: `Forking ${galleryName} to your GitHub account…`,
  });
  // 202: fork creation is asynchronous. The response still carries the fork's
  // name (GitHub renames on collision with an unrelated same-named repo) and
  // its default branch; an existing fork returns the same shape immediately.
  const fork = await gh<{
    name: string;
    default_branch: string;
    owner: { login: string };
  }>("POST", `/repos/${repo.owner}/${repo.name}/forks`, {
    default_branch_only: true,
  });
  const forkName = `github.com/${fork.owner.login}/${fork.name}`;
  const forkPath = `/repos/${fork.owner.login}/${fork.name}`;
  onProgress({
    stage: "fork",
    label: `Waiting for your fork ${forkName} to be ready…`,
  });
  const baseRef = await waitForForkRef({
    gh,
    forkPath,
    branch: fork.default_branch,
    signal,
  });

  onProgress({
    stage: "branch",
    label: `Creating branch ${branch} in ${forkName}…`,
  });
  try {
    await gh("POST", `${forkPath}/git/refs`, {
      ref: `refs/heads/${branch}`,
      sha: baseRef,
    });
  } catch (error) {
    if (!isAlreadyExistsRefusal(error)) throw error;
    // The stable name makes "already exists" meaningful: either a PR slipped
    // in since the pre-flight (stop and point at it), or a rejected
    // submission left the branch behind (reuse it — the uploads below put
    // the fresh files on top).
    const raced = await findBlockingPullRequest({
      gh,
      repo,
      login: viewer.login,
      branch,
    });
    if (raced) throw new DuplicateSubmissionError(raced);
  }

  // The same builder backs the manual-submission download, so what a
  // participant hand-uploads is byte-identical to what this commits.
  const dir = gallerySubmissionFolder(viewer.login, appSlug);
  for (const file of buildGallerySubmissionFiles(bundle)) {
    onProgress({
      stage: "upload",
      label: `Uploading ${file.name} to ${forkName}…`,
    });
    // Updating a file left by an earlier (rejected) submission needs its
    // blob sha; on a fresh branch the lookup 404s and the PUT creates it.
    const path = `${forkPath}/contents/${dir}/${file.name}`;
    const priorSha = await fetchExistingFileSha({ gh, path, branch });
    await gh("PUT", path, {
      message: `Add ${file.name} for: ${bundle.app.name}`,
      content: toBase64(file.bytes),
      branch,
      ...(priorSha ? { sha: priorSha } : {}),
    });
  }

  onProgress({
    stage: "pr",
    label: `Opening the pull request on ${galleryName}…`,
  });
  let pr: { html_url: string };
  try {
    pr = await gh<{ html_url: string }>(
      "POST",
      `/repos/${repo.owner}/${repo.name}/pulls`,
      {
        ...buildGallerySubmissionPr(bundle),
        head: `${viewer.login}:${branch}`,
        base: fork.default_branch,
        maintainer_can_modify: true,
      },
    );
  } catch (error) {
    if (!isAlreadyExistsRefusal(error)) throw error;
    // Even the last-instant race loses cleanly: GitHub refuses a second PR
    // for the same head, and the winner — whose diff now shows the files
    // this run just committed — is what the participant gets pointed at.
    const raced = await findBlockingPullRequest({
      gh,
      repo,
      login: viewer.login,
      branch,
    });
    if (!raced) throw error;
    throw new DuplicateSubmissionError(raced);
  }
  return { prUrl: pr.html_url };
}

/**
 * The signed-in participant's GitHub login, or null when it can't be had
 * (no token, revoked token, network). Best-effort — the manual-submission
 * screen uses it to spell the exact target folder instead of a placeholder.
 */
export async function fetchGithubLogin(
  token: string,
  signal: AbortSignal,
): Promise<string | null> {
  try {
    const viewer = await makeGithubClient(token, signal)<{ login: string }>(
      "GET",
      "/user",
    );
    return viewer.login;
  } catch {
    return null;
  }
}

/** One file of a gallery submission, as the exact bytes the PR commits. */
export interface GallerySubmissionFile {
  name: string;
  bytes: Uint8Array;
  mimeType: string;
}

/** The folder-name slug a submission files under (`submissions/<login>/<slug>`). */
export function gallerySubmissionSlug(bundle: AppRecordingBundle): string {
  return slugify(bundle.app.name) || "app-session";
}

/** The stable branch a participant's submission of this app lives on. */
export function gallerySubmissionBranch(slug: string): string {
  return `submission/${slug}`;
}

/** The gallery folder a submission's files live under. */
export function gallerySubmissionFolder(login: string, slug: string): string {
  return `submissions/${login}/${slug}`;
}

/**
 * The pull request title and body the automatic path files — also handed to
 * the manual fallback as click-to-copy content, so a hand-made PR reads
 * identically to an automatic one.
 */
export function buildGallerySubmissionPr(bundle: AppRecordingBundle): {
  title: string;
  body: string;
} {
  return {
    // The app's name, NOT the recording title — the recorder's default
    // session titles carry a timestamp, which means nothing in a PR title.
    title: `App session: ${bundle.app.name}`,
    body: prBody(bundle),
  };
}

/**
 * The complete submission package: the recording itself, plus a thumbnail
 * when the recording carries canvas frames. The single source of the bytes
 * for BOTH paths — the automatic PR commits these, and the manual-submission
 * fallback downloads these — so the two are identical by construction.
 */
export function buildGallerySubmissionFiles(
  bundle: AppRecordingBundle,
): GallerySubmissionFile[] {
  const files: GallerySubmissionFile[] = [
    {
      name: "recording.json",
      bytes: new TextEncoder().encode(JSON.stringify(bundle)),
      mimeType: "application/json",
    },
  ];
  const thumbnail = extractThumbnail(bundle);
  if (thumbnail) {
    files.push({
      name: `thumbnail.${thumbnail.ext}`,
      bytes: base64ToBytes(thumbnail.base64),
      mimeType: `image/${thumbnail.ext === "jpg" ? "jpeg" : thumbnail.ext}`,
    });
  }
  return files;
}

/**
 * The one size rule a submission must meet — GitHub's own per-file limit on
 * its contents API, NOT a product quota. Returns the refusal message when a
 * file is over it, null when everything fits. The dialog calls this at the
 * Share click so nobody signs in to GitHub only to learn the recording
 * can't be uploaded.
 */
export function oversizedGallerySubmissionFile(
  bundle: AppRecordingBundle,
): string | null {
  for (const file of buildGallerySubmissionFiles(bundle)) {
    if (file.bytes.byteLength > GITHUB_MAX_FILE_BYTES) {
      return `This recording is ${mb(file.bytes.byteLength)}MB — GitHub refuses files over ${mb(GITHUB_MAX_FILE_BYTES)}MB. Re-record a shorter session.`;
    }
  }
  return null;
}

/**
 * Remember / recall / forget the pull request an app's submission produced,
 * per gallery repository, so the share button can disable itself without a
 * GitHub call. Browser-local and best-effort by design — the submission's own
 * pre-flight check against GitHub stays the authoritative guard.
 */
export function rememberGallerySubmission(params: {
  repo: AppGalleryRepo;
  slug: string;
  prUrl: string;
}): void {
  try {
    localStorage.setItem(
      submissionStorageKey(params.repo, params.slug),
      JSON.stringify({ prUrl: params.prUrl }),
    );
  } catch {
    // Storage full or blocked — the pre-flight check still guards.
  }
}

export function recallGallerySubmission(params: {
  repo: AppGalleryRepo;
  slug: string;
}): { prUrl: string } | null {
  try {
    const raw = localStorage.getItem(
      submissionStorageKey(params.repo, params.slug),
    );
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { prUrl?: unknown };
    return typeof parsed.prUrl === "string" ? { prUrl: parsed.prUrl } : null;
  } catch {
    return null;
  }
}

export function forgetGallerySubmission(params: {
  repo: AppGalleryRepo;
  slug: string;
}): void {
  try {
    localStorage.removeItem(submissionStorageKey(params.repo, params.slug));
  } catch {
    // Storage blocked — nothing to forget then.
  }
}

/**
 * Where a previously-submitted pull request stands now. Lets a remembered
 * submission expire: "closed" (rejected, unmerged) clears the way for a
 * resubmission, while "unknown" (network trouble, rate limit, a private
 * gallery without a token) leaves the button alone and defers to the
 * submission's own pre-flight check.
 */
export async function fetchSubmittedPrState(
  prUrl: string,
  signal?: AbortSignal,
): Promise<"open" | "merged" | "closed" | "unknown"> {
  const match = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(prUrl);
  if (!match) return "unknown";
  try {
    const response = await fetch(
      `https://api.github.com/repos/${match[1]}/${match[2]}/pulls/${match[3]}`,
      {
        signal,
        headers: {
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          ...(cachedToken ? { authorization: `Bearer ${cachedToken}` } : {}),
        },
      },
    );
    if (!response.ok) return "unknown";
    const pr = (await response.json()) as {
      state?: string;
      merged_at?: string | null;
    };
    if (pr.merged_at) return "merged";
    return pr.state === "open" ? "open" : "closed";
  } catch {
    return "unknown";
  }
}

// =============================================================================
// Internal helpers
// =============================================================================

type GithubCall = <T = unknown>(
  method: string,
  path: string,
  body?: unknown,
) => Promise<T>;

function makeGithubClient(token: string, signal: AbortSignal): GithubCall {
  return async <T>(method: string, path: string, body?: unknown) => {
    let response: Response;
    try {
      response = await fetch(`https://api.github.com${path}`, {
        method,
        signal,
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          "x-github-api-version": "2022-11-28",
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (error) {
      // Cancellation must stay a cancellation, not become an error card.
      if (signal.aborted) throw error;
      throw new Error(
        "Couldn't reach GitHub — check your connection and try again.",
      );
    }
    if (response.status === 401) {
      dropCachedGithubToken();
      throw new GithubAuthError(
        "GitHub no longer accepts the sign-in — sign in again.",
      );
    }
    if (!response.ok) {
      throw await toGithubRequestError(response);
    }
    return (await response.json()) as T;
  };
}

/**
 * One HTTP refusal, phrased for the error card: retriable conditions (rate
 * limits, GitHub 5xx weather) get a short plain-language line, and only a
 * genuine verdict (403/404/422 …) quotes GitHub's own message — that one is
 * the useful, specific explanation. NO status codes in the text — they mean
 * nothing to a participant; the status rides on the error object for retry
 * logic instead.
 */
async function toGithubRequestError(
  response: Response,
): Promise<GithubRequestError> {
  let detail = "";
  try {
    // 422s bury the actual reason in `errors[]` ("A pull request already
    // exists…") under a generic top-level "Validation Failed" — fold both in.
    const payload = (await response.json()) as {
      message?: string;
      errors?: ({ message?: string } | string)[];
    };
    detail = [
      payload.message,
      ...(payload.errors ?? []).map((entry) =>
        typeof entry === "string" ? entry : entry?.message,
      ),
    ]
      .filter(Boolean)
      .join(" — ");
  } catch {
    // Non-JSON error body — the status alone will have to explain it.
  }
  const { status } = response;
  if (status === 429 || (status === 403 && /rate limit/i.test(detail))) {
    return new GithubRequestError(
      "GitHub is rate-limiting requests — wait a moment and try again.",
      status,
    );
  }
  if (status >= 500) {
    return new GithubRequestError(
      "GitHub is having trouble right now — wait a moment and try again.",
      status,
    );
  }
  return new GithubRequestError(
    `GitHub refused the request.${detail ? ` ${detail}` : ""}`,
    status,
  );
}

/** An api.github.com refusal, keeping the status for retry decisions. */
class GithubRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/**
 * The 422 GitHub answers when the branch or pull request this run is about
 * to create already exists — the collision signal the duplicate guards key
 * on. Any other 422 is a real validation verdict and propagates.
 */
function isAlreadyExistsRefusal(error: unknown): boolean {
  return (
    error instanceof GithubRequestError &&
    error.status === 422 &&
    /already exists/i.test(error.message)
  );
}

/**
 * The open-or-merged pull request already submitted from `login:branch`, if
 * any. Merged blocks like open does; a closed-unmerged (rejected) PR frees
 * the app for resubmission. The `head` filter makes this one exact lookup.
 */
async function findBlockingPullRequest(params: {
  gh: GithubCall;
  repo: AppGalleryRepo;
  login: string;
  branch: string;
}): Promise<{ prUrl: string; merged: boolean } | null> {
  const { gh, repo, login, branch } = params;
  const pulls = await gh<
    { state: string; merged_at: string | null; html_url: string }[]
  >(
    "GET",
    `/repos/${repo.owner}/${repo.name}/pulls?head=${encodeURIComponent(`${login}:${branch}`)}&state=all&per_page=100`,
  );
  const blocking = pulls.find((pr) => pr.state === "open" || pr.merged_at);
  return blocking
    ? { prUrl: blocking.html_url, merged: Boolean(blocking.merged_at) }
    : null;
}

/** The blob sha at `path` on `branch`, or null when the file isn't there. */
async function fetchExistingFileSha(params: {
  gh: GithubCall;
  path: string;
  branch: string;
}): Promise<string | null> {
  try {
    const file = await params.gh<{ sha: string }>(
      "GET",
      `${params.path}?ref=${encodeURIComponent(params.branch)}`,
    );
    return file.sha;
  } catch (error) {
    if (error instanceof GithubRequestError && error.status === 404) {
      return null;
    }
    throw error;
  }
}

function submissionStorageKey(repo: AppGalleryRepo, slug: string): string {
  return `archestra.appGallerySubmission.${repo.owner}/${repo.name}/${slug}`;
}

/**
 * A fresh fork answers 404/409 on its git refs for a few seconds while GitHub
 * copies the repository; the ref appearing is what "fork is ready" means.
 * ONLY those two statuses are worth waiting on — any other refusal (empty
 * upstream, revoked token…) is a verdict, and retrying it for forty seconds
 * would just delay the message. Resolves with the branch head's sha.
 */
async function waitForForkRef(params: {
  gh: GithubCall;
  forkPath: string;
  branch: string;
  signal: AbortSignal;
}): Promise<string> {
  const attempts = 20;
  for (let attempt = 0; ; attempt++) {
    try {
      const ref = await params.gh<{ object: { sha: string } }>(
        "GET",
        `${params.forkPath}/git/ref/heads/${params.branch}`,
      );
      return ref.object.sha;
    } catch (error) {
      const stillMaterializing =
        error instanceof GithubRequestError &&
        (error.status === 404 || error.status === 409);
      if (!stillMaterializing) throw error;
      if (attempt >= attempts) {
        throw new Error(
          "GitHub is taking too long to prepare your fork — try again in a moment.",
        );
      }
      await sleep(2000, params.signal);
    }
  }
}

/**
 * Best effort: a canvas-drawing app's last recorded frame is a genuine
 * screenshot; a DOM app records no frames, and the gallery pipeline derives
 * its imagery from the bundle's replay instead.
 */
function extractThumbnail(
  bundle: AppRecordingBundle,
): { ext: string; base64: string } | null {
  for (let i = bundle.recording.events.length - 1; i >= 0; i--) {
    const event = bundle.recording.events[i];
    if (event.kind !== "canvas") continue;
    // No `s` flag (frontend tsc target): a canvas data URL is single-line.
    const match = /^data:image\/(png|jpeg|webp);base64,(.+)$/.exec(event.data);
    if (!match) return null;
    return { ext: match[1] === "jpeg" ? "jpg" : match[1], base64: match[2] };
  }
  return null;
}

function prBody(bundle: AppRecordingBundle): string {
  const lines = [
    `Submits a recorded session of **${bundle.app.name}**.`,
    "",
    `- Duration: ${Math.round(bundle.recording.durationMs / 1000)}s`,
  ];
  if (bundle.enhancement?.category) {
    lines.push(`- Category: ${bundle.enhancement.category}`);
  }
  if (bundle.meta.authorName) {
    lines.push(`- Author: ${bundle.meta.authorName}`);
  }
  if (bundle.meta.mcpServers?.length) {
    lines.push(`- MCP servers: ${bundle.meta.mcpServers.join(", ")}`);
  }
  if (bundle.enhancement?.description) {
    lines.push("", bundle.enhancement.description);
  }
  return lines.join("\n");
}

/**
 * The error `type` from the backend envelope — how the poll loop tells a
 * deliberate 400 verdict (expired, declined) from relay weather worth
 * riding out.
 */
function apiErrorType(error: unknown): string | null {
  if (error && typeof error === "object" && "error" in error) {
    const inner = (error as { error?: { type?: string } }).error;
    if (inner?.type) return inner.type;
  }
  return null;
}

function apiErrorMessage(error: unknown): string | null {
  if (error && typeof error === "object" && "error" in error) {
    const inner = (error as { error?: { message?: string } }).error;
    if (inner?.message) return inner.message;
  }
  return null;
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** GitHub's ceiling for a file created through its contents API. */
const GITHUB_MAX_FILE_BYTES = 100 * 1024 * 1024;

function mb(bytes: number): number {
  return Math.round(bytes / (1024 * 1024));
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  // Chunked: String.fromCharCode(...allBytes) overflows the argument limit on
  // a bundle-sized array.
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
