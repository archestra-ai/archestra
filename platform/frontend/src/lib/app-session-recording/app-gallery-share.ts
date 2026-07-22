import { archestraApiSdk, slugify } from "@archestra/shared";
import type { AppRecordingBundle } from "@/lib/app-session-recording/app-recording-store";

/**
 * Shares a recorded app session to the public App Gallery as a pull request
 * filed by the participant's own GitHub account.
 *
 * The backend only relays the GitHub device flow (github.com's OAuth endpoints
 * refuse browser CORS); everything else here talks straight to api.github.com,
 * which allows it. The recording bundle therefore never transits our server on
 * its way to the gallery, and the token GitHub hands back stays in the
 * browser (localStorage, expiring after 24 hours — one sign-in covers a
 * hackathon working day, without leaving a live token behind forever); our
 * server never sees it.
 *
 * The submission is the standard fork workflow, so it needs nothing but the
 * `public_repo` scope the device flow asked for: fork the gallery repository,
 * branch the fork, commit the bundle (and a thumbnail — a canvas app's last
 * still, or a frame decoded from its video-stream capture), then open the pull
 * request on the gallery.
 *
 * One app, one submission: the branch name is stable per participant+app,
 * and a duplicate is blocked while an open pull request from it exists or
 * the submission's files sit in the gallery — checked up front and
 * re-checked at each step that could mint one, so even racing runs end up
 * pointed at the one existing submission instead of filing another.
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

/**
 * The participant's GitHub token — persisted in browser storage so ONE
 * sign-in covers a hackathon working day, not just one page load (re-auth on
 * every visit read as "why am I signing in again?"). Not forever, though:
 * the stored entry carries an expiry, and a token past it is dropped on
 * read, so a finished participant isn't left with a live public_repo token
 * sitting in localStorage indefinitely. Scope is public_repo only; GitHub
 * can also revoke any time, and a 401 drops it so the dialog re-runs the
 * sign-in.
 */
const GITHUB_TOKEN_STORAGE_KEY = "archestra.appGalleryGithubToken";
const GITHUB_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

let cachedEntry: { token: string; expiresAt: number } | null = null;

export function takeCachedGithubToken(): string | null {
  const entry = cachedEntry ?? readStoredTokenEntry();
  if (!entry) return null;
  // Checked on every read, not just page load — a tab left open past the
  // expiry must not keep using the token from memory.
  if (Date.now() >= entry.expiresAt) {
    dropCachedGithubToken();
    return null;
  }
  cachedEntry = entry;
  return entry.token;
}

export function dropCachedGithubToken(): void {
  cachedEntry = null;
  try {
    localStorage.removeItem(GITHUB_TOKEN_STORAGE_KEY);
  } catch {
    // Storage blocked — nothing was persisted.
  }
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
      storeGithubToken(poll.data.accessToken);
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
  // pre-flight below finds an open PR from it or the app already in the
  // gallery, and GitHub itself refuses a second branch or second PR under
  // the same name if two runs race past the check.
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
  // GitHub's /user payload also carries an email — never read past login/name.
  const viewer = await gh<{ login: string; name: string | null }>(
    "GET",
    "/user",
  );
  const existing = await findBlockingSubmission({
    gh,
    repo,
    login: viewer.login,
    branch,
    slug: appSlug,
  });
  if (existing) throw new DuplicateSubmissionError(existing);

  // The submitter's public GitHub identity, stamped onto the bundle that
  // actually gets committed — never the automatic path's local `bundle`,
  // which stays untouched. Picks only `login`/`name`; the same GitHub
  // response also carries an email, which is never read here.
  const bundleWithGithub: AppRecordingBundle = {
    ...bundle,
    meta: {
      ...bundle.meta,
      // GitHub always sends `name` (null when the account has none set) —
      // coerced defensively in case a response ever omits the key outright,
      // since the schema requires the field present, never `undefined`.
      github: { login: viewer.login, name: viewer.name ?? null },
    },
  };

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
    const raced = await findBlockingSubmission({
      gh,
      repo,
      login: viewer.login,
      branch,
      slug: appSlug,
    });
    if (raced) throw new DuplicateSubmissionError(raced);
  }

  // The same builder backs the manual-submission download, so what a
  // participant hand-uploads is byte-identical to what this commits.
  const dir = gallerySubmissionFolder(viewer.login, appSlug);
  for (const file of await buildGallerySubmissionFiles(bundleWithGithub)) {
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
        ...buildGallerySubmissionPr(bundleWithGithub),
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
    const raced = await findBlockingSubmission({
      gh,
      repo,
      login: viewer.login,
      branch,
      slug: appSlug,
    });
    if (!raced) throw error;
    throw new DuplicateSubmissionError(raced);
  }
  return { prUrl: pr.html_url };
}

/**
 * The signed-in participant's public GitHub identity, or null when it can't
 * be had (no token, revoked token, network). Best-effort — the
 * manual-submission screen uses `login` to spell the exact target folder
 * instead of a placeholder, and stamps both fields onto the downloaded
 * bundle. GitHub's /user payload also carries an email — never read past
 * login/name.
 */
export async function fetchGithubIdentity(
  token: string,
  signal: AbortSignal,
): Promise<{ login: string; name: string | null } | null> {
  try {
    const viewer = await makeGithubClient(token, signal)<{
      login: string;
      name: string | null;
    }>("GET", "/user");
    return { login: viewer.login, name: viewer.name };
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

/** The app-name slug a submission's folder and branch are named with. */
export function gallerySubmissionSlug(bundle: AppRecordingBundle): string {
  return slugify(bundle.app.name) || "app-session";
}

/** The stable branch a participant's submission of this app lives on. */
export function gallerySubmissionBranch(slug: string): string {
  return `submission/${slug}`;
}

/**
 * The gallery folder a submission's files live under:
 * `apps/<login>_<slug>`. One predictable segment per app — the gallery site
 * walks `apps/` to build its grid, and since GitHub logins cannot contain
 * underscores, the first `_` splits author from app name unambiguously.
 */
export function gallerySubmissionFolder(login: string, slug: string): string {
  return `apps/${login}_${slug}`;
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
 * The complete submission package: the recording itself, plus a thumbnail when
 * one can be produced — a canvas app's last still frame, or (for a canvas
 * captured as an encoded video stream) its final frame decoded from the last
 * keyframe. The single source of the bytes for BOTH paths — the automatic PR
 * commits these, and the manual-submission fallback downloads these — so the
 * two are identical by construction. Async because decoding a video frame is.
 */
export async function buildGallerySubmissionFiles(
  bundle: AppRecordingBundle,
): Promise<GallerySubmissionFile[]> {
  const files = staticSubmissionFiles(bundle);
  // A canvas app captured as video carries no still frame — decode its final
  // frame so the submission still ships a real screenshot. Best-effort: an
  // undecodable stream (or a browser without WebCodecs) ships no thumbnail,
  // exactly as a DOM app does, and the gallery derives one from replay.
  if (!files.some((file) => file.name.startsWith("thumbnail."))) {
    const decoded = await extractVideoThumbnail(bundle);
    if (decoded) files.push(thumbnailFile(decoded));
  }
  return files;
}

/**
 * The files that can be built synchronously — the recording JSON and, when the
 * recording has one, a legacy still-frame thumbnail. The oversize pre-flight
 * sizes these: a decoded video-stream thumbnail is a single small keyframe that
 * can never be the size culprit and isn't worth decoding before sign-in.
 */
function staticSubmissionFiles(
  bundle: AppRecordingBundle,
): GallerySubmissionFile[] {
  const files: GallerySubmissionFile[] = [
    {
      name: "recording.json",
      bytes: new TextEncoder().encode(JSON.stringify(bundle)),
      mimeType: "application/json",
    },
  ];
  const still = extractStillThumbnail(bundle);
  if (still) files.push(thumbnailFile(still));
  return files;
}

/** A thumbnail (ext + base64) as the submission file the PR commits. */
function thumbnailFile(thumbnail: {
  ext: string;
  base64: string;
}): GallerySubmissionFile {
  return {
    name: `thumbnail.${thumbnail.ext}`,
    bytes: base64ToBytes(thumbnail.base64),
    mimeType: `image/${thumbnail.ext === "jpg" ? "jpeg" : thumbnail.ext}`,
  };
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
  for (const file of staticSubmissionFiles(bundle)) {
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
 * submission expire: "closed" (rejected — or merged but no longer in the
 * gallery) clears the way for a resubmission, while "unknown" (network
 * trouble, rate limit, a private gallery without a token) leaves the button
 * alone and defers to the submission's own pre-flight check.
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
        // GitHub's API answers are cacheable for a minute — a PR closed
        // seconds ago must not come back as still open.
        cache: "no-store",
        headers: githubPublicHeaders(),
      },
    );
    if (!response.ok) return "unknown";
    const pr = (await response.json()) as {
      state?: string;
      merged_at?: string | null;
    };
    if (pr.merged_at) {
      // Merged is only the truth while the files are still in the gallery —
      // GitHub keeps merged_at forever, even after a revert or a history
      // rewrite removed the submission. Gone files behave like "closed".
      return await mergedSubmissionStillPresent(
        { owner: match[1], name: match[2], number: match[3] },
        signal,
      );
    }
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

/**
 * Success bodies are cast to the caller's type without runtime validation —
 * GitHub's documented response shapes are trusted as-is. Deliberate: the
 * handful of fields read here (login, sha, html_url…) have been stable for a
 * decade, and a drift would surface as the dialog's error card on the next
 * step rather than corrupt anything.
 */
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
 * The submission that blocks a new one, if any: an OPEN pull request from
 * `login:branch` (waiting for review), or the submission's files sitting on
 * the gallery's default branch right now (in the gallery). Presence of the
 * FILES is the truthful "merged" signal — GitHub keeps a PR's `merged_at`
 * forever, so a merged submission that was since reverted, removed, or
 * erased by a history rewrite must not keep blocking on the PR's say-so.
 */
async function findBlockingSubmission(params: {
  gh: GithubCall;
  repo: AppGalleryRepo;
  login: string;
  branch: string;
  slug: string;
}): Promise<{ prUrl: string; merged: boolean } | null> {
  const { gh, repo, login, branch, slug } = params;
  const pulls = await gh<
    { state: string; merged_at: string | null; html_url: string }[]
  >(
    "GET",
    `/repos/${repo.owner}/${repo.name}/pulls?head=${encodeURIComponent(`${login}:${branch}`)}&state=all&per_page=100`,
  );
  const open = pulls.find((pr) => pr.state === "open");
  if (open) return { prUrl: open.html_url, merged: false };

  const folder = gallerySubmissionFolder(login, slug);
  const inGallery = await fetchExistingFileSha({
    gh,
    path: `/repos/${repo.owner}/${repo.name}/contents/${folder}/recording.json`,
  });
  if (inGallery) {
    // Link the PR that carried it in when one exists; a hand-made submission
    // (no PR from this head) links the folder itself.
    const merged = pulls.find((pr) => pr.merged_at);
    return {
      prUrl:
        merged?.html_url ??
        `https://github.com/${repo.owner}/${repo.name}/tree/HEAD/${folder}`,
      merged: true,
    };
  }
  return null;
}

/**
 * The blob sha at `path` on `branch` (the repository's default branch when
 * omitted), or null when the file isn't there.
 */
async function fetchExistingFileSha(params: {
  gh: GithubCall;
  path: string;
  branch?: string;
}): Promise<string | null> {
  try {
    const ref = params.branch
      ? `?ref=${encodeURIComponent(params.branch)}`
      : "";
    const file = await params.gh<{ sha: string }>(
      "GET",
      `${params.path}${ref}`,
    );
    return file.sha;
  } catch (error) {
    if (error instanceof GithubRequestError && error.status === 404) {
      return null;
    }
    throw error;
  }
}

/**
 * Whether a merged submission's files still sit in the target repository:
 * the PR's first changed file, looked up on the default branch. "merged"
 * when present, "closed" when definitively gone, "unknown" when it can't
 * be told.
 */
async function mergedSubmissionStillPresent(
  pr: { owner: string; name: string; number: string },
  signal?: AbortSignal,
): Promise<"merged" | "closed" | "unknown"> {
  try {
    const filesResponse = await fetch(
      `https://api.github.com/repos/${pr.owner}/${pr.name}/pulls/${pr.number}/files?per_page=1`,
      { signal, cache: "no-store", headers: githubPublicHeaders() },
    );
    if (!filesResponse.ok) return "unknown";
    const [first] = (await filesResponse.json()) as { filename?: string }[];
    if (!first?.filename) return "unknown";
    const contentsResponse = await fetch(
      `https://api.github.com/repos/${pr.owner}/${pr.name}/contents/${first.filename}`,
      { signal, cache: "no-store", headers: githubPublicHeaders() },
    );
    if (contentsResponse.ok) return "merged";
    return contentsResponse.status === 404 ? "closed" : "unknown";
  } catch {
    return "unknown";
  }
}

/** Headers for direct api.github.com lookups (token attached when present). */
function githubPublicHeaders(): Record<string, string> {
  const token = takeCachedGithubToken();
  return {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

function storeGithubToken(token: string): void {
  const entry = { token, expiresAt: Date.now() + GITHUB_TOKEN_TTL_MS };
  cachedEntry = entry;
  try {
    localStorage.setItem(GITHUB_TOKEN_STORAGE_KEY, JSON.stringify(entry));
  } catch {
    // Storage blocked — the tab keeps it in memory.
  }
}

/**
 * The stored `{ token, expiresAt }` entry, or null. Anything unreadable — a
 * plain-string token from before entries carried an expiry, or corruption —
 * is cleared on sight: with no expiry to honor, the only safe treatment is
 * a fresh sign-in.
 */
function readStoredTokenEntry(): { token: string; expiresAt: number } | null {
  try {
    const raw = localStorage.getItem(GITHUB_TOKEN_STORAGE_KEY);
    if (!raw) return null;
    let parsed: { token?: unknown; expiresAt?: unknown } | null = null;
    try {
      parsed = JSON.parse(raw) as { token?: unknown; expiresAt?: unknown };
    } catch {
      // fall through to the cleanup below
    }
    if (
      parsed &&
      typeof parsed.token === "string" &&
      typeof parsed.expiresAt === "number"
    ) {
      return { token: parsed.token, expiresAt: parsed.expiresAt };
    }
    localStorage.removeItem(GITHUB_TOKEN_STORAGE_KEY);
  } catch {
    // Storage blocked — in-memory only, sign-in returns each page load.
  }
  return null;
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
 * Best effort: a canvas-drawing app's last recorded still is a genuine
 * screenshot of its final state. Null when the recording carries no
 * `kind:"canvas"` stills — a DOM app (no frames at all), or a canvas captured
 * as a video stream (see {@link extractVideoThumbnail}).
 */
function extractStillThumbnail(
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

type StoredVideoConfig = Extract<
  AppRecordingBundle["recording"]["events"][number],
  { kind: "video-config" }
>;
type StoredVideoChunk = Extract<
  AppRecordingBundle["recording"]["events"][number],
  { kind: "video-chunk" }
>;

/**
 * A screenshot for a canvas captured as an encoded video stream: its FINAL
 * frame, decoded from the stream's last keyframe forward. Best-effort and
 * async — null when WebCodecs is unavailable, the codec can't be decoded here,
 * or the stream has no keyframe. Recording is Chromium/WebCodecs-only, so this
 * runs on exactly the browsers that produce these streams.
 */
async function extractVideoThumbnail(
  bundle: AppRecordingBundle,
): Promise<{ ext: string; base64: string } | null> {
  if (
    typeof VideoDecoder === "undefined" ||
    typeof EncodedVideoChunk === "undefined"
  ) {
    return null;
  }
  const events = bundle.recording.events;

  // The canvas most recently painted — whose last video chunk lands latest — so
  // the thumbnail is the app's final visible state, matching the still path.
  let targetSel: string | null = null;
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.kind === "video-chunk") {
      targetSel = event.sel;
      break;
    }
  }
  if (targetSel === null) return null;

  // That stream's decoder config (codec, coded size, extradata) — emitted at
  // stream start and on resize, so the most recent one governs the final frame.
  let config: StoredVideoConfig | null = null;
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.kind === "video-config" && event.sel === targetSel) {
      config = event;
      break;
    }
  }
  if (!config) return null;

  // Decode from the last keyframe forward: a keyframe stands alone and the
  // deltas after it carry the stream to its end — the minimum for the final
  // frame.
  const chunks = events.filter(
    (event): event is StoredVideoChunk =>
      event.kind === "video-chunk" && event.sel === targetSel,
  );
  let start = -1;
  for (let i = chunks.length - 1; i >= 0; i--) {
    if (chunks[i].type === "key") {
      start = i;
      break;
    }
  }
  if (start < 0) return null;

  const decoderConfig: VideoDecoderConfig = {
    codec: config.codec,
    codedWidth: config.codedWidth,
    codedHeight: config.codedHeight,
    ...(config.description
      ? { description: base64ToBytes(config.description) }
      : {}),
  };
  const support = await VideoDecoder.isConfigSupported(decoderConfig).catch(
    () => null,
  );
  if (!support?.supported) return null;

  const frame = await decodeFinalVideoFrame(decoderConfig, chunks.slice(start));
  if (!frame) return null;
  try {
    return await frameToWebp(frame);
  } finally {
    frame.close();
  }
}

/**
 * Feed a keyframe and the deltas after it to a one-shot decoder and resolve the
 * LAST frame it emits — the stream's final state. Resolves null on any decoder
 * error; every superseded frame is closed so only the winner outlives the call.
 */
function decodeFinalVideoFrame(
  config: VideoDecoderConfig,
  chunks: StoredVideoChunk[],
): Promise<VideoFrame | null> {
  return new Promise((resolve) => {
    let latest: VideoFrame | null = null;
    let settled = false;
    const finish = (frame: VideoFrame | null) => {
      if (settled) return;
      settled = true;
      try {
        decoder.close();
      } catch {
        // already closed / never configured
      }
      resolve(frame);
    };
    const decoder = new VideoDecoder({
      output: (frame) => {
        latest?.close();
        latest = frame;
      },
      error: () => finish(null),
    });
    try {
      decoder.configure(config);
      for (const chunk of chunks) {
        decoder.decode(
          new EncodedVideoChunk({
            type: chunk.type,
            timestamp: chunk.tsUs,
            data: base64ToBytes(chunk.data),
          }),
        );
      }
      decoder
        .flush()
        .then(() => finish(latest))
        .catch(() => finish(latest));
    } catch {
      finish(latest);
    }
  });
}

/** A decoded frame → a WebP still (ext + base64, the submission's shape). */
async function frameToWebp(
  frame: VideoFrame,
): Promise<{ ext: string; base64: string } | null> {
  const width = frame.displayWidth;
  const height = frame.displayHeight;
  if (!width || !height) return null;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(frame, 0, 0, width, height);
  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob((result) => resolve(result), "image/webp", 0.85);
  });
  if (!blob) return null;
  return {
    ext: "webp",
    base64: toBase64(new Uint8Array(await blob.arrayBuffer())),
  };
}

function prBody(bundle: AppRecordingBundle): string {
  // The editor's final cut (cuts applied, idle compressed) when the bundle
  // carries one — otherwise the raw capture length, for older bundles.
  const durationMs =
    bundle.meta.finalCutDurationMs ?? bundle.recording.durationMs;
  const lines = [
    `Submits a recorded session of **${bundle.app.name}**.`,
    "",
    `- Duration: ${Math.round(durationMs / 1000)}s`,
  ];
  if (bundle.enhancement?.category) {
    lines.push(`- Category: ${bundle.enhancement.category}`);
  }
  if (bundle.meta.github) {
    lines.push(
      `- Submitted by: @${bundle.meta.github.login}${bundle.meta.github.name ? ` (${bundle.meta.github.name})` : ""}`,
    );
  }
  if (bundle.meta.authorName) {
    lines.push(`- Author: ${bundle.meta.authorName}`);
  }
  if (bundle.meta.model) {
    lines.push(`- Model: ${bundle.meta.model}`);
  }
  // `!= null` so a genuine zero (a fully automated build) still reports "0"
  // rather than dropping the line — only an absent count is omitted.
  if (bundle.meta.userPromptCount != null) {
    lines.push(`- Prompts: ${bundle.meta.userPromptCount}`);
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
