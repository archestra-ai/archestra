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
 */

interface AppGalleryRepo {
  owner: string;
  name: string;
}

export type ShareProgressStage =
  | "forking"
  | "branching"
  | "uploading"
  | "opening-pr";

/** GitHub said the token no longer works — the caller should sign in again. */
export class GithubAuthError extends Error {}

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
  while (Date.now() < deadline) {
    await sleep(waitSeconds * 1000, params.signal);
    const poll = await archestraApiSdk.appGalleryDeviceAuthPoll({
      body: { deviceCode: data.deviceCode },
    });
    if (poll.error || !poll.data) {
      throw new Error(apiErrorMessage(poll.error) ?? "GitHub sign-in failed.");
    }
    if (poll.data.status === "complete") {
      cachedToken = poll.data.accessToken;
      return poll.data.accessToken;
    }
    if (poll.data.status === "slow_down") {
      waitSeconds += 5;
    }
  }
  throw new Error("The GitHub sign-in expired before it was authorized.");
}

/**
 * The whole submission, token to pull-request URL. Throws `GithubAuthError`
 * when GitHub rejects the token (the dialog restarts the sign-in), a plain
 * `Error` with GitHub's own message otherwise.
 */
export async function submitRecordingToAppGallery(params: {
  token: string;
  repo: AppGalleryRepo;
  bundle: AppRecordingBundle;
  signal: AbortSignal;
  onProgress: (stage: ShareProgressStage) => void;
}): Promise<{ prUrl: string }> {
  const { token, repo, bundle, signal, onProgress } = params;
  const gh = makeGithubClient(token, signal);

  onProgress("forking");
  const viewer = await gh<{ login: string }>("GET", "/user");
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
  const forkPath = `/repos/${fork.owner.login}/${fork.name}`;
  const baseRef = await waitForForkRef({
    gh,
    forkPath,
    branch: fork.default_branch,
    signal,
  });

  onProgress("branching");
  // One branch per share, so resubmissions of the same app become their own
  // pull requests instead of piling commits onto an open one.
  const appSlug = gallerySubmissionSlug(bundle);
  const branch = `submission/${appSlug}-${Date.now().toString(36)}`;
  await gh("POST", `${forkPath}/git/refs`, {
    ref: `refs/heads/${branch}`,
    sha: baseRef,
  });

  onProgress("uploading");
  // The same builder backs the manual-submission download, so what a
  // participant hand-uploads is byte-identical to what this commits.
  const dir = `submissions/${viewer.login}/${appSlug}`;
  for (const file of buildGallerySubmissionFiles(bundle)) {
    await gh("PUT", `${forkPath}/contents/${dir}/${file.name}`, {
      message: `Add ${file.name} for: ${bundle.recording.title}`,
      content: toBase64(file.bytes),
      branch,
    });
  }

  onProgress("opening-pr");
  const pr = await gh<{ html_url: string }>(
    "POST",
    `/repos/${repo.owner}/${repo.name}/pulls`,
    {
      title: `App session: ${bundle.recording.title}`,
      head: `${viewer.login}:${branch}`,
      base: fork.default_branch,
      body: prBody(bundle),
      maintainer_can_modify: true,
    },
  );
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
    const response = await fetch(`https://api.github.com${path}`, {
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
    if (response.status === 401) {
      dropCachedGithubToken();
      throw new GithubAuthError("GitHub no longer accepts the sign-in.");
    }
    if (!response.ok) {
      const message = await githubErrorMessage(response);
      throw new Error(message);
    }
    return (await response.json()) as T;
  };
}

/**
 * A fresh fork answers 404/409 on its git refs for a few seconds while GitHub
 * copies the repository; the ref appearing is what "fork is ready" means.
 * Resolves with the branch head's sha.
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
      if (error instanceof GithubAuthError || attempt >= attempts) throw error;
      await sleep(2000, params.signal);
    }
  }
}

async function githubErrorMessage(response: Response): Promise<string> {
  let detail = "";
  try {
    const payload = (await response.json()) as { message?: string };
    if (payload.message) detail = ` ${payload.message}`;
  } catch {
    // Non-JSON error body — the status alone will have to explain it.
  }
  return `GitHub refused the request (${response.status}).${detail}`;
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

/** The `{ error: { message } }` envelope every backend error carries. */
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
