import { spawn } from "node:child_process";
import type { Dirent } from "node:fs";
import { lstat, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface PublicGithubRepository {
  owner: string;
  repo: string;
  slug: string;
}

interface PublicGithubTreeItem {
  type: string;
  path: string;
  mode: string;
  /** Missing for blobless Git fallback; callers may hydrate with raw HEAD. */
  size?: number;
}

/**
 * Resolve a public GitHub ref without consuming the anonymous REST API quota.
 * Full commit SHAs are already immutable and need no network resolution.
 */
export async function resolvePublicGithubCommit(params: {
  repository: PublicGithubRepository;
  ref: string | null;
  signal?: AbortSignal;
}): Promise<string> {
  validateRepository(params.repository);
  const requestedRef = params.ref ?? "HEAD";
  if (GITHUB_COMMIT_SHA.test(requestedRef)) {
    return requestedRef.toLowerCase();
  }
  validateRef(requestedRef);

  const remote = githubRemoteUrl(params.repository);
  const patterns =
    requestedRef === "HEAD"
      ? ["HEAD"]
      : requestedRef.startsWith("refs/")
        ? [`${requestedRef}^{}`, requestedRef]
        : [
            `refs/heads/${requestedRef}`,
            `refs/tags/${requestedRef}^{}`,
            `refs/tags/${requestedRef}`,
          ];

  let stdout: string;
  try {
    stdout = await runGit(
      [
        "ls-remote",
        ...(requestedRef === "HEAD" ? ["--symref"] : []),
        "--exit-code",
        remote,
        ...patterns,
      ],
      {
        timeoutMs: GIT_REF_TIMEOUT_MS,
        maxStdoutBytes: MAX_REF_OUTPUT_BYTES,
        signal: params.signal,
      },
    );
  } catch (error) {
    throw new Error(
      `Public Git ref lookup failed for ${params.repository.slug}@${requestedRef}: ${errorMessage(error)}`,
    );
  }

  const refs = parseLsRemote(stdout);
  const preferredRefs =
    requestedRef === "HEAD"
      ? ["HEAD"]
      : requestedRef.startsWith("refs/")
        ? [`${requestedRef}^{}`, requestedRef]
        : [
            `refs/heads/${requestedRef}`,
            `refs/tags/${requestedRef}^{}`,
            `refs/tags/${requestedRef}`,
          ];
  for (const refName of preferredRefs) {
    const sha = refs.get(refName);
    if (sha) return sha;
  }
  throw new Error(
    `Public Git ref lookup returned no commit for ${params.repository.slug}@${requestedRef}`,
  );
}

/**
 * Load only Git tree objects for a public repository snapshot. `blob:none`
 * avoids downloading payload bytes; callers fetch only selected files through
 * raw.githubusercontent.com and enforce their actual byte limits there.
 */
export async function readPublicGithubTree(params: {
  repository: PublicGithubRepository;
  commitSha: string;
  signal?: AbortSignal;
}): Promise<PublicGithubTreeItem[]> {
  validateRepository(params.repository);
  if (!GITHUB_COMMIT_SHA.test(params.commitSha)) {
    throw new Error("Public Git tree lookup requires a full commit SHA");
  }

  const directory = await mkdtemp(join(tmpdir(), "archestra-plugin-git-"));
  try {
    await runGit(["init", "--bare", "--quiet", directory], {
      timeoutMs: GIT_COMMAND_TIMEOUT_MS,
      maxStdoutBytes: MAX_REF_OUTPUT_BYTES,
      signal: params.signal,
    });
    await runGit(
      [
        "-C",
        directory,
        "-c",
        "gc.auto=0",
        "-c",
        "maintenance.auto=false",
        "-c",
        "protocol.version=2",
        "fetch",
        "--quiet",
        "--no-tags",
        "--depth=1",
        "--filter=blob:none",
        githubRemoteUrl(params.repository),
        params.commitSha,
      ],
      {
        timeoutMs: GIT_FETCH_TIMEOUT_MS,
        maxStdoutBytes: MAX_REF_OUTPUT_BYTES,
        directoryBudget: {
          path: directory,
          maxBytes: MAX_GIT_DIRECTORY_BYTES,
        },
        signal: params.signal,
      },
    );
    if (await directoryExceedsLimit(directory, MAX_GIT_DIRECTORY_BYTES)) {
      throw new Error("git temporary repository exceeded the safe disk limit");
    }
    const stdout = await runGit(
      ["-C", directory, "ls-tree", "-r", "-z", "FETCH_HEAD"],
      {
        timeoutMs: GIT_COMMAND_TIMEOUT_MS,
        maxStdoutBytes: MAX_TREE_OUTPUT_BYTES,
        signal: params.signal,
      },
    );
    return parseLsTree(stdout);
  } catch (error) {
    throw new Error(
      `Public Git tree lookup failed for ${params.repository.slug}@${params.commitSha}: ${errorMessage(error)}`,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export function isGithubRateLimitError(error: unknown): boolean {
  if (!isRecord(error)) return false;
  const response = isRecord(error.response) ? error.response : null;
  const status = numberValue(error.status) ?? numberValue(response?.status);
  const remaining = response
    ? headerValue(response.headers, "x-ratelimit-remaining")
    : null;
  const message = errorMessage(error).toLowerCase();
  return (
    status === 429 ||
    (status === 403 &&
      (remaining === "0" ||
        message.includes("rate limit") ||
        message.includes("rate-limit")))
  );
}

// === Internal helpers ===

const GITHUB_COMMIT_SHA = /^[0-9a-f]{40}$/i;
const GITHUB_OWNER = /^[a-z0-9][a-z0-9-]{0,38}$/i;
const GITHUB_REPO = /^[a-z0-9._-]{1,100}$/i;
const GIT_REF_TIMEOUT_MS = 15_000;
const GIT_COMMAND_TIMEOUT_MS = 10_000;
const GIT_FETCH_TIMEOUT_MS = 60_000;
const MAX_REF_OUTPUT_BYTES = 512 * 1_024;
const MAX_TREE_OUTPUT_BYTES = 16 * 1_024 * 1_024;
const MAX_STDERR_BYTES = 64 * 1_024;
const MAX_GIT_DIRECTORY_BYTES = 32 * 1_024 * 1_024;
const DIRECTORY_BUDGET_POLL_MS = 100;

function validateRepository(repository: PublicGithubRepository): void {
  if (
    !GITHUB_OWNER.test(repository.owner) ||
    repository.owner.endsWith("-") ||
    !GITHUB_REPO.test(repository.repo) ||
    repository.repo === "." ||
    repository.repo === ".."
  ) {
    throw new Error("Invalid public GitHub repository name");
  }
}

function validateRef(ref: string): void {
  if (
    ref.length > 255 ||
    hasForbiddenRefCharacter(ref) ||
    ref.includes("..") ||
    ref.includes("@{") ||
    ref.includes("//") ||
    ref.startsWith("/") ||
    ref.endsWith("/") ||
    ref.endsWith(".")
  ) {
    throw new Error("Invalid public Git ref");
  }
}

function hasForbiddenRefCharacter(ref: string): boolean {
  for (const character of ref) {
    const code = character.charCodeAt(0);
    if (code <= 32 || code === 127) return true;
  }
  return /[~^:?*[\\]/.test(ref);
}

function githubRemoteUrl(repository: PublicGithubRepository): string {
  return `https://github.com/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}.git`;
}

function parseLsRemote(output: string): Map<string, string> {
  const refs = new Map<string, string>();
  for (const line of output.split("\n")) {
    const match = /^([0-9a-f]{40})\t(.+)$/.exec(line.trim());
    if (match) refs.set(match[2], match[1].toLowerCase());
  }
  return refs;
}

function parseLsTree(output: string): PublicGithubTreeItem[] {
  const tree: PublicGithubTreeItem[] = [];
  for (const record of output.split("\0")) {
    if (!record) continue;
    const match = /^([0-9]{6}) ([a-z]+) [0-9a-f]{40}\t([\s\S]+)$/.exec(record);
    if (!match) throw new Error("Git returned an invalid tree record");
    tree.push({
      mode: match[1],
      type: match[2],
      path: match[3],
    });
  }
  return tree;
}

async function runGit(
  args: string[],
  options: {
    timeoutMs: number;
    maxStdoutBytes: number;
    directoryBudget?: { path: string; maxBytes: number };
    signal?: AbortSignal;
  },
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      env: {
        ...process.env,
        GIT_ASKPASS: "true",
        GIT_TERMINAL_PROMPT: "0",
        LC_ALL: "C",
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let outputExceeded = false;
    let directoryExceeded = false;
    let aborted = false;
    let directoryCheckInFlight = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs);
    const abort = () => {
      aborted = true;
      child.kill("SIGKILL");
    };
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener("abort", abort, { once: true });
    const directoryTimer = options.directoryBudget
      ? setInterval(() => {
          if (settled || directoryCheckInFlight || !options.directoryBudget) {
            return;
          }
          directoryCheckInFlight = true;
          void directoryExceedsLimit(
            options.directoryBudget.path,
            options.directoryBudget.maxBytes,
          )
            .then((exceeded) => {
              if (!settled && exceeded) {
                directoryExceeded = true;
                child.kill("SIGKILL");
              }
            })
            .finally(() => {
              directoryCheckInFlight = false;
            });
        }, DIRECTORY_BUDGET_POLL_MS)
      : null;

    const clearTimers = () => {
      clearTimeout(timer);
      if (directoryTimer) clearInterval(directoryTimer);
      options.signal?.removeEventListener("abort", abort);
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > options.maxStdoutBytes) {
        outputExceeded = true;
        child.kill("SIGKILL");
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderrBytes >= MAX_STDERR_BYTES) return;
      const retained = chunk.subarray(0, MAX_STDERR_BYTES - stderrBytes);
      stderrBytes += retained.length;
      stderr.push(retained);
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimers();
      reject(error);
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimers();
      if (timedOut) {
        reject(new Error(`git timed out after ${options.timeoutMs}ms`));
        return;
      }
      if (aborted) {
        reject(
          options.signal?.reason instanceof Error
            ? options.signal.reason
            : new Error("git operation aborted"),
        );
        return;
      }
      if (outputExceeded) {
        reject(new Error("git output exceeded the safe limit"));
        return;
      }
      if (directoryExceeded) {
        reject(
          new Error("git temporary repository exceeded the safe disk limit"),
        );
        return;
      }
      if (code !== 0) {
        const detail = Buffer.concat(stderr).toString("utf8").trim();
        reject(
          new Error(
            detail || `git exited with code ${code ?? "unknown"} (${signal})`,
          ),
        );
        return;
      }
      resolve(Buffer.concat(stdout).toString("utf8"));
    });
  });
}

async function directoryExceedsLimit(
  root: string,
  maxBytes: number,
): Promise<boolean> {
  const pending = [root];
  let totalBytes = 0;
  while (pending.length > 0) {
    const directory = pending.pop();
    if (!directory) continue;
    let entries: Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(path);
        continue;
      }
      try {
        totalBytes += (await lstat(path)).size;
      } catch {
        continue;
      }
      if (totalBytes > maxBytes) return true;
    }
  }
  return false;
}

function headerValue(headers: unknown, name: string): string | null {
  if (headers instanceof Headers) return headers.get(name);
  if (!isRecord(headers)) return null;
  const value = headers[name] ?? headers[name.toLowerCase()];
  return typeof value === "string" ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
