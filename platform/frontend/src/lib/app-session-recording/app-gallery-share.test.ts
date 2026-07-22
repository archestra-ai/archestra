import { beforeEach, describe, expect, test, vi } from "vitest";
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
} from "./app-gallery-share";

/**
 * The engine's contract is the exact conversation it has with api.github.com:
 * refuse a duplicate submission up front, fork the gallery repo, branch the
 * fork (one STABLE branch per participant+app), commit the bundle (and a
 * thumbnail when the recording has canvas frames), open the PR. These tests
 * stub fetch and pin that wire sequence, including the duplicate guards.
 */

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
    const labels: string[] = [];
    const result = await submit({ onProgress: (label) => labels.push(label) });

    expect(result.prUrl).toBe(
      "https://github.com/archestra-ai/app-gallery/pull/7",
    );
    // Progress narrates the real repositories, branch, and files by name.
    expect(labels).toEqual([
      "Checking github.com/archestra-ai/app-gallery for an existing submission…",
      "Forking github.com/archestra-ai/app-gallery to your GitHub account…",
      "Waiting for your fork github.com/sam/app-gallery to be ready…",
      "Creating branch submission/pr_review_queue in github.com/sam/app-gallery…",
      "Uploading recording.json to github.com/sam/app-gallery…",
      "Opening the pull request on github.com/archestra-ai/app-gallery…",
    ]);
    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      "GET /user",
      "GET /repos/archestra-ai/app-gallery/pulls",
      "POST /repos/archestra-ai/app-gallery/forks",
      "GET /repos/sam/app-gallery/git/ref/heads/main",
      "POST /repos/sam/app-gallery/git/refs",
      "GET /repos/sam/app-gallery/contents/submissions/sam/pr_review_queue/recording.json",
      "PUT /repos/sam/app-gallery/contents/submissions/sam/pr_review_queue/recording.json",
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
    expect(pr.title).toBe("App session: Building a review queue");
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
      "/contents/submissions/sam/pr_review_queue/thumbnail.webp",
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

  test("a merged pull request blocks too — the app is already in the gallery", async () => {
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

    const failure = await submit().catch((error) => error);
    expect(failure).toBeInstanceOf(DuplicateSubmissionError);
    expect(failure).toMatchObject({ merged: true });
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
        if (method === "GET" && url.includes("/contents/")) {
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
      "GitHub is rate-limiting requests — wait a moment and retry.",
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
    await expect(submit()).rejects.toThrow(/403.*Repository access blocked/);
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

    await expect(submit()).rejects.toThrow(/422.*Validation Failed/);
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

describe("fetchSubmittedPrState", () => {
  const prUrl = "https://github.com/archestra-ai/app-gallery/pull/7";

  test.each([
    ["open", { state: "open", merged_at: null }],
    ["merged", { state: "closed", merged_at: "2026-07-20T00:00:00Z" }],
    ["closed", { state: "closed", merged_at: null }],
  ] as const)("reports %s", async (expected, payload) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(payload)),
    );
    await expect(fetchSubmittedPrState(prUrl)).resolves.toBe(expected);
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
