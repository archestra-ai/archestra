import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { AppRecordingBundle } from "@/lib/app-session-recording/app-recording-store";
import {
  buildGallerySubmissionFiles,
  DuplicateSubmissionError,
  dropCachedGithubToken,
  fetchSubmittedPrState,
  forgetGallerySubmission,
  GithubAuthError,
  recallGallerySubmission,
  rememberGallerySubmission,
  submitRecordingToAppGallery,
  takeCachedGithubToken,
} from "./app-gallery-share";

/**
 * The engine's contract is the exact conversation it has with api.github.com:
 * refuse a duplicate submission up front, fork the gallery repo, branch the
 * fork (one STABLE branch per participant+app), commit the bundle (and a
 * thumbnail when the recording has canvas frames), open the PR. These tests
 * stub fetch and pin that wire sequence, including the duplicate guards.
 */

afterEach(() => {
  // vitest is not configured to auto-unstub globals, so put the real fetch
  // back explicitly instead of leaning on every later test re-stubbing it.
  vi.unstubAllGlobals();
});

function makeBundle(
  events: AppRecordingBundle["recording"]["events"] = [],
): AppRecordingBundle {
  return {
    formatVersion: 1,
    app: { id: null, name: "PR Review Queue" },
    recording: {
      title: "Building a review queue",
      startedAt: "2026-07-21T00:00:00.000Z",
      durationMs: 42_000,
      events,
      segments: [{ start: 0, end: 42_000 }],
      transcript: [],
    },
    enhancement: {
      description: "Every open PR, sorted by wait time.",
      prompt: "Build me a review queue.",
      category: "Development",
    },
    meta: {
      authorName: "Sam Participant",
      createdAt: "2026-07-21T00:00:00.000Z",
      platform: "archestra",
      mcpServers: ["github"],
    },
  } as unknown as AppRecordingBundle;
}

describe("submitRecordingToAppGallery", () => {
  const calls: { method: string; url: string; body: unknown }[] = [];

  function stubGithub(overrides?: {
    respond?: (method: string, url: string) => Response | null;
  }) {
    calls.length = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        calls.push({
          method,
          url,
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        });
        const overridden = overrides?.respond?.(method, url);
        if (overridden) return overridden;

        if (method === "GET" && url.endsWith("/user")) {
          return Response.json({ login: "sam" });
        }
        if (method === "GET" && url.includes("/pulls?")) {
          // No prior submission from this participant+branch.
          return Response.json([]);
        }
        if (method === "POST" && url.includes("/forks")) {
          return Response.json(
            {
              name: "app-gallery",
              default_branch: "main",
              owner: { login: "sam" },
            },
            { status: 202 },
          );
        }
        if (method === "GET" && url.includes("/git/ref/heads/main")) {
          return Response.json({ object: { sha: "base-sha" } });
        }
        if (method === "POST" && url.includes("/git/refs")) {
          return Response.json({}, { status: 201 });
        }
        if (method === "GET" && url.includes("/contents/")) {
          // Fresh branch: the file isn't there yet.
          return Response.json({ message: "Not Found" }, { status: 404 });
        }
        if (method === "PUT" && url.includes("/contents/")) {
          return Response.json({}, { status: 201 });
        }
        if (method === "POST" && url.endsWith("/pulls")) {
          return Response.json({
            html_url: "https://github.com/archestra-ai/app-gallery/pull/7",
          });
        }
        throw new Error(`unexpected request: ${method} ${url}`);
      }),
    );
  }

  function submit(
    overrides?: Partial<Parameters<typeof submitRecordingToAppGallery>[0]>,
  ) {
    return submitRecordingToAppGallery({
      token: "gho_token",
      repo: { owner: "archestra-ai", name: "app-gallery" },
      bundle: makeBundle(),
      signal: new AbortController().signal,
      onProgress: () => {},
      ...overrides,
    });
  }

  beforeEach(() => {
    dropCachedGithubToken();
    stubGithub();
  });

  test("runs the fork workflow in order and returns the PR url", async () => {
    const progress: string[] = [];
    const result = await submit({
      onProgress: ({ stage, label }) => progress.push(`${stage}: ${label}`),
    });

    expect(result.prUrl).toBe(
      "https://github.com/archestra-ai/app-gallery/pull/7",
    );
    // Progress names the step (for failure titling) and narrates the real
    // repositories, branch, and files.
    expect(progress).toEqual([
      "check: Checking github.com/archestra-ai/app-gallery for an existing submission…",
      "fork: Forking github.com/archestra-ai/app-gallery to your GitHub account…",
      "fork: Waiting for your fork github.com/sam/app-gallery to be ready…",
      "branch: Creating branch submission/pr_review_queue in github.com/sam/app-gallery…",
      "upload: Uploading recording.json to github.com/sam/app-gallery…",
      "pr: Opening the pull request on github.com/archestra-ai/app-gallery…",
    ]);
    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      "GET /user",
      "GET /repos/archestra-ai/app-gallery/pulls",
      // The in-the-gallery-already probe: the submission's file on the
      // gallery's default branch.
      "GET /repos/archestra-ai/app-gallery/contents/apps/sam_pr_review_queue/recording.json",
      "POST /repos/archestra-ai/app-gallery/forks",
      "GET /repos/sam/app-gallery/git/ref/heads/main",
      "POST /repos/sam/app-gallery/git/refs",
      "GET /repos/sam/app-gallery/contents/apps/sam_pr_review_queue/recording.json",
      "PUT /repos/sam/app-gallery/contents/apps/sam_pr_review_queue/recording.json",
      "POST /repos/archestra-ai/app-gallery/pulls",
    ]);

    // The pre-flight looks up exactly this participant's stable branch, in
    // every state (open AND closed — merged PRs count as closed there).
    const preflight = calls.find(
      (c) => c.method === "GET" && c.url.includes("/pulls?"),
    );
    expect(preflight?.url).toContain("head=sam%3Asubmission%2Fpr_review_queue");
    expect(preflight?.url).toContain("state=all");

    // The committed file is the bundle itself, byte for byte — and a fresh
    // branch uploads without an update sha.
    const upload = calls.find((c) => c.method === "PUT") as {
      body: { content: string; branch: string };
    };
    expect(JSON.parse(atob(upload.body.content))).toEqual(makeBundle());
    expect(upload.body).not.toHaveProperty("sha");

    // The PR names the participant's branch as head and carries the metadata.
    const pr = calls.at(-1)?.body as {
      head: string;
      base: string;
      title: string;
      body: string;
    };
    expect(pr.head).toBe("sam:submission/pr_review_queue");
    expect(pr.base).toBe("main");
    // The app's NAME, not the recording's default session title — those
    // carry a timestamp that means nothing in a PR title.
    expect(pr.title).toBe("App session: PR Review Queue");
    expect(pr.body).toContain("PR Review Queue");
    expect(pr.body).toContain("Category: Development");
    expect(pr.body).toContain("MCP servers: github");
  });

  test("commits the last canvas frame as the thumbnail when one exists", async () => {
    const bundle = makeBundle([
      {
        kind: "canvas",
        t: 100,
        sel: "#c",
        data: `data:image/webp;base64,${btoa("first")}`,
      },
      {
        kind: "canvas",
        t: 200,
        sel: "#c",
        data: `data:image/webp;base64,${btoa("final-frame")}`,
      },
    ] as AppRecordingBundle["recording"]["events"]);

    await submit({ bundle });

    const uploads = calls.filter((c) => c.method === "PUT");
    expect(uploads).toHaveLength(2);
    expect(uploads[1].url).toContain(
      "/contents/apps/sam_pr_review_queue/thumbnail.webp",
    );
    expect(atob((uploads[1].body as { content: string }).content)).toBe(
      "final-frame",
    );
  });

  test("uploads are byte-identical to the manual-submission package", async () => {
    const bundle = makeBundle([
      {
        kind: "canvas",
        t: 100,
        sel: "#c",
        data: `data:image/png;base64,${btoa("pixels")}`,
      },
    ] as AppRecordingBundle["recording"]["events"]);

    await submit({ bundle });

    const uploads = calls.filter((c) => c.method === "PUT");
    const files = buildGallerySubmissionFiles(bundle);
    // Same files, same order, same bytes — the manual fallback's downloads
    // must match what the automatic path commits, byte for byte.
    expect(
      uploads.map((u) => new URL(u.url).pathname.split("/").at(-1)),
    ).toEqual(files.map((f) => f.name));
    for (const [i, upload] of uploads.entries()) {
      const uploadedBinary = atob((upload.body as { content: string }).content);
      const fileBinary = Array.from(files[i].bytes, (b) =>
        String.fromCharCode(b),
      ).join("");
      expect(uploadedBinary).toBe(fileBinary);
    }
  });

  test("a bundle over GitHub's file limit is refused before anything touches the network", async () => {
    // Pad one event so the serialized bundle crosses the ceiling — GitHub's
    // contents API would refuse it as unreadable 5xx weather mid-flow.
    const bundle = makeBundle([
      { kind: "padding", data: "x".repeat(101 * 1024 * 1024) },
    ] as unknown as AppRecordingBundle["recording"]["events"]);

    const failure = await submit({ bundle }).catch((error) => error);
    expect(failure).toBeInstanceOf(Error);
    // GitHub's real per-file ceiling, phrased as GitHub's — never a
    // product quota.
    expect(String(failure)).toMatch(/GitHub refuses files over 100MB/);
    // Not even the duplicate pre-flight ran — no request left the browser.
    expect(calls).toHaveLength(0);
  });

  test("an existing open pull request blocks resubmission before anything is written", async () => {
    stubGithub({
      respond: (method, url) =>
        method === "GET" && url.includes("/pulls?")
          ? Response.json([
              {
                state: "open",
                merged_at: null,
                html_url: "https://github.com/archestra-ai/app-gallery/pull/3",
              },
            ])
          : null,
    });

    const failure = await submit().catch((error) => error);
    expect(failure).toBeInstanceOf(DuplicateSubmissionError);
    expect(failure).toMatchObject({
      prUrl: "https://github.com/archestra-ai/app-gallery/pull/3",
      merged: false,
    });
    // Nothing was forked, branched, uploaded, or PR'd.
    expect(calls.every((c) => c.method === "GET")).toBe(true);
  });

  test("a merged pull request blocks while its files are still in the gallery", async () => {
    stubGithub({
      respond: (method, url) => {
        if (method === "GET" && url.includes("/pulls?")) {
          return Response.json([
            {
              state: "closed",
              merged_at: "2026-07-20T00:00:00Z",
              html_url: "https://github.com/archestra-ai/app-gallery/pull/4",
            },
          ]);
        }
        if (
          method === "GET" &&
          url.includes("/repos/archestra-ai/app-gallery/contents/")
        ) {
          return Response.json({ sha: "in-gallery" });
        }
        return null;
      },
    });

    const failure = await submit().catch((error) => error);
    expect(failure).toBeInstanceOf(DuplicateSubmissionError);
    expect(failure).toMatchObject({
      merged: true,
      prUrl: "https://github.com/archestra-ai/app-gallery/pull/4",
    });
  });

  test("a merged pull request whose files were since removed does NOT block", async () => {
    // GitHub keeps merged_at forever — but the gallery's default branch was
    // rewritten (or the submission reverted), so the app is NOT in the
    // gallery and a fresh submission must go through.
    stubGithub({
      respond: (method, url) =>
        method === "GET" && url.includes("/pulls?")
          ? Response.json([
              {
                state: "closed",
                merged_at: "2026-07-20T00:00:00Z",
                html_url: "https://github.com/archestra-ai/app-gallery/pull/4",
              },
            ])
          : null,
    });

    const result = await submit();
    expect(result.prUrl).toBe(
      "https://github.com/archestra-ai/app-gallery/pull/7",
    );
  });

  test("files sitting in the gallery block even with no pull request on record", async () => {
    // A hand-made (manual) submission has no PR from this head — the files
    // themselves are the signal, and the folder is what gets linked.
    stubGithub({
      respond: (method, url) =>
        method === "GET" &&
        url.includes("/repos/archestra-ai/app-gallery/contents/")
          ? Response.json({ sha: "in-gallery" })
          : null,
    });

    const failure = await submit().catch((error) => error);
    expect(failure).toBeInstanceOf(DuplicateSubmissionError);
    expect(failure).toMatchObject({
      merged: true,
      prUrl:
        "https://github.com/archestra-ai/app-gallery/tree/HEAD/apps/sam_pr_review_queue",
    });
  });

  test("a closed-unmerged (rejected) pull request does not block a resubmission", async () => {
    stubGithub({
      respond: (method, url) =>
        method === "GET" && url.includes("/pulls?")
          ? Response.json([
              {
                state: "closed",
                merged_at: null,
                html_url: "https://github.com/archestra-ai/app-gallery/pull/5",
              },
            ])
          : null,
    });

    const result = await submit();
    expect(result.prUrl).toBe(
      "https://github.com/archestra-ai/app-gallery/pull/7",
    );
  });

  test("a leftover branch from a rejected submission is reused, updating its files in place", async () => {
    stubGithub({
      respond: (method, url) => {
        if (method === "POST" && url.includes("/git/refs")) {
          return Response.json(
            { message: "Reference already exists" },
            { status: 422 },
          );
        }
        // Only the FORK's file lookup — the upstream gallery-presence probe
        // must keep 404ing, or it would read as "already in the gallery".
        if (
          method === "GET" &&
          url.includes("/repos/sam/app-gallery/contents/")
        ) {
          return Response.json({ sha: "stale-blob-sha" });
        }
        return null;
      },
    });

    const result = await submit();
    expect(result.prUrl).toBe(
      "https://github.com/archestra-ai/app-gallery/pull/7",
    );
    // The collision re-checked for a racing PR (a second pulls lookup)…
    expect(
      calls.filter((c) => c.method === "GET" && c.url.includes("/pulls?")),
    ).toHaveLength(2);
    // …and the upload replaced the stale file instead of failing on it.
    const upload = calls.find((c) => c.method === "PUT");
    expect((upload?.body as { sha?: string }).sha).toBe("stale-blob-sha");
  });

  test("a pull request that appears mid-run stops the flow and names it", async () => {
    let pullsLookups = 0;
    stubGithub({
      respond: (method, url) => {
        if (method === "GET" && url.includes("/pulls?")) {
          pullsLookups += 1;
          return Response.json(
            pullsLookups === 1
              ? []
              : [
                  {
                    state: "open",
                    merged_at: null,
                    html_url:
                      "https://github.com/archestra-ai/app-gallery/pull/9",
                  },
                ],
          );
        }
        if (method === "POST" && url.includes("/git/refs")) {
          return Response.json(
            { message: "Reference already exists" },
            { status: 422 },
          );
        }
        return null;
      },
    });

    const failure = await submit().catch((error) => error);
    expect(failure).toBeInstanceOf(DuplicateSubmissionError);
    expect(failure).toMatchObject({
      prUrl: "https://github.com/archestra-ai/app-gallery/pull/9",
    });
  });

  test("GitHub refusing a second pull request resolves to the existing one", async () => {
    let pullsLookups = 0;
    stubGithub({
      respond: (method, url) => {
        if (method === "GET" && url.includes("/pulls?")) {
          pullsLookups += 1;
          return Response.json(
            pullsLookups === 1
              ? []
              : [
                  {
                    state: "open",
                    merged_at: null,
                    html_url:
                      "https://github.com/archestra-ai/app-gallery/pull/11",
                  },
                ],
          );
        }
        if (method === "POST" && url.endsWith("/pulls")) {
          // GitHub's real shape: generic top-level message, the actual
          // reason buried in errors[].
          return Response.json(
            {
              message: "Validation Failed",
              errors: [
                {
                  message:
                    "A pull request already exists for sam:submission/pr_review_queue.",
                },
              ],
            },
            { status: 422 },
          );
        }
        return null;
      },
    });

    const failure = await submit().catch((error) => error);
    expect(failure).toBeInstanceOf(DuplicateSubmissionError);
    expect(failure).toMatchObject({
      prUrl: "https://github.com/archestra-ai/app-gallery/pull/11",
      merged: false,
    });
  });

  test("a 401 from GitHub becomes GithubAuthError", async () => {
    stubGithub({
      respond: (method, url) =>
        method === "GET" && url.endsWith("/user")
          ? new Response("", { status: 401 })
          : null,
    });

    await expect(submit({ token: "gho_revoked" })).rejects.toBeInstanceOf(
      GithubAuthError,
    );
  });

  test("phrases rate limiting as a short retriable message", async () => {
    stubGithub({
      respond: (method, url) =>
        method === "GET" && url.endsWith("/user")
          ? Response.json(
              { message: "API rate limit exceeded" },
              { status: 429 },
            )
          : null,
    });

    await expect(submit()).rejects.toThrow(
      "GitHub is rate-limiting requests — wait a moment and try again.",
    );
  });

  test("a hard refusal during the fork wait surfaces immediately, not after the retry window", async () => {
    stubGithub({
      respond: (method, url) =>
        method === "GET" && url.includes("/git/ref/heads/main")
          ? Response.json(
              { message: "Repository access blocked" },
              { status: 403 },
            )
          : null,
    });

    const started = Date.now();
    // GitHub's verdict verbatim, but never a status code — those mean
    // nothing to a participant.
    await expect(submit()).rejects.toThrow(
      "GitHub refused the request. Repository access blocked",
    );
    // Only 404/409 mean "fork still materializing" — a verdict must not sit
    // through the 40-second readiness loop before reaching the participant.
    expect(Date.now() - started).toBeLessThan(1500);
  });

  test("surfaces GitHub's own error message on failure", async () => {
    stubGithub({
      respond: (method, url) =>
        method === "POST" && url.endsWith("/pulls")
          ? Response.json({ message: "Validation Failed" }, { status: 422 })
          : null,
    });

    await expect(submit()).rejects.toThrow(
      "GitHub refused the request. Validation Failed",
    );
  });
});

describe("gallery submission memory", () => {
  const repo = { owner: "archestra-ai", name: "app-gallery" };

  beforeEach(() => {
    localStorage.clear();
  });

  test("remember → recall → forget round-trips, scoped per gallery repo", () => {
    rememberGallerySubmission({
      repo,
      slug: "pr_review_queue",
      prUrl: "https://github.com/archestra-ai/app-gallery/pull/7",
    });
    expect(recallGallerySubmission({ repo, slug: "pr_review_queue" })).toEqual({
      prUrl: "https://github.com/archestra-ai/app-gallery/pull/7",
    });
    // A submission to a test gallery must not block the real one, and
    // vice versa.
    expect(
      recallGallerySubmission({
        repo: { owner: "someone", name: "gallery-test" },
        slug: "pr_review_queue",
      }),
    ).toBeNull();

    forgetGallerySubmission({ repo, slug: "pr_review_queue" });
    expect(
      recallGallerySubmission({ repo, slug: "pr_review_queue" }),
    ).toBeNull();
  });
});

describe("github token storage", () => {
  const KEY = "archestra.appGalleryGithubToken";

  beforeEach(() => {
    dropCachedGithubToken();
    localStorage.clear();
  });

  test("a stored token is usable until its expiry, then dropped from storage", () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({ token: "gho_live", expiresAt: Date.now() + 60_000 }),
    );
    expect(takeCachedGithubToken()).toBe("gho_live");

    dropCachedGithubToken();
    localStorage.setItem(
      KEY,
      JSON.stringify({ token: "gho_stale", expiresAt: Date.now() - 1 }),
    );
    expect(takeCachedGithubToken()).toBeNull();
    // The expired entry is gone, not just ignored — no live-scoped token
    // left sitting in localStorage after the hackathon.
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  test("a tab held open past the expiry stops using the in-memory copy too", () => {
    vi.useFakeTimers();
    try {
      localStorage.setItem(
        KEY,
        JSON.stringify({ token: "gho_live", expiresAt: Date.now() + 1_000 }),
      );
      expect(takeCachedGithubToken()).toBe("gho_live");
      vi.advanceTimersByTime(1_001);
      expect(takeCachedGithubToken()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  test("an entry without an expiry (pre-TTL token, corruption) is cleared on sight", () => {
    localStorage.setItem(KEY, "gho_bare_legacy_token");
    expect(takeCachedGithubToken()).toBeNull();
    expect(localStorage.getItem(KEY)).toBeNull();
  });
});

describe("fetchSubmittedPrState", () => {
  const prUrl = "https://github.com/archestra-ai/app-gallery/pull/7";

  test.each([
    ["open", { state: "open", merged_at: null }],
    ["closed", { state: "closed", merged_at: null }],
  ] as const)("reports %s", async (expected, payload) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(payload)),
    );
    await expect(fetchSubmittedPrState(prUrl)).resolves.toBe(expected);
  });

  test("merged counts only while the submission is still in the gallery", async () => {
    const stubMergedPr = (contents: () => Response) =>
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL) => {
          const url = String(input);
          if (url.includes("/files")) {
            return Response.json([
              { filename: "apps/sam_pr_review_queue/recording.json" },
            ]);
          }
          if (url.includes("/contents/")) return contents();
          return Response.json({
            state: "closed",
            merged_at: "2026-07-20T00:00:00Z",
          });
        }),
      );

    stubMergedPr(() => Response.json({ sha: "still-there" }));
    await expect(fetchSubmittedPrState(prUrl)).resolves.toBe("merged");

    // Files gone (revert / history rewrite) — behaves like a closed PR, so
    // the remembered submission clears and the button re-enables.
    stubMergedPr(() => new Response("", { status: 404 }));
    await expect(fetchSubmittedPrState(prUrl)).resolves.toBe("closed");

    // Can't tell → never a false verdict.
    stubMergedPr(() => new Response("", { status: 500 }));
    await expect(fetchSubmittedPrState(prUrl)).resolves.toBe("unknown");
  });

  test("anything unverifiable is unknown, never a false verdict", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 404 })),
    );
    await expect(fetchSubmittedPrState(prUrl)).resolves.toBe("unknown");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    await expect(fetchSubmittedPrState(prUrl)).resolves.toBe("unknown");

    await expect(fetchSubmittedPrState("not a pull request url")).resolves.toBe(
      "unknown",
    );
  });
});
