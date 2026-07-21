import { beforeEach, describe, expect, test, vi } from "vitest";
import type { AppRecordingBundle } from "@/lib/app-session-recording/app-recording-store";
import {
  dropCachedGithubToken,
  GithubAuthError,
  submitRecordingToAppGallery,
} from "./app-gallery-share";

/**
 * The engine's contract is the exact conversation it has with api.github.com:
 * fork the gallery repo, branch the fork, commit the bundle (and a thumbnail
 * when the recording has canvas frames), open the PR. These tests stub fetch
 * and pin that wire sequence.
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

  beforeEach(() => {
    dropCachedGithubToken();
    stubGithub();
  });

  test("runs the fork workflow in order and returns the PR url", async () => {
    const stages: string[] = [];
    const result = await submitRecordingToAppGallery({
      token: "gho_token",
      repo: { owner: "archestra-ai", name: "app-gallery" },
      bundle: makeBundle(),
      signal: new AbortController().signal,
      onProgress: (stage) => stages.push(stage),
    });

    expect(result.prUrl).toBe(
      "https://github.com/archestra-ai/app-gallery/pull/7",
    );
    expect(stages).toEqual(["forking", "branching", "uploading", "opening-pr"]);
    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      "GET /user",
      "POST /repos/archestra-ai/app-gallery/forks",
      "GET /repos/sam/app-gallery/git/ref/heads/main",
      expect.stringMatching(/^POST \/repos\/sam\/app-gallery\/git\/refs$/),
      expect.stringMatching(
        /^PUT \/repos\/sam\/app-gallery\/contents\/submissions\/sam\/pr_review_queue\/recording\.json$/,
      ),
      "POST /repos/archestra-ai/app-gallery/pulls",
    ]);

    // The committed file is the bundle itself, byte for byte.
    const upload = calls.find((c) => c.method === "PUT") as {
      body: { content: string; branch: string };
    };
    expect(JSON.parse(atob(upload.body.content))).toEqual(makeBundle());

    // The PR names the participant's branch as head and carries the metadata.
    const pr = calls.at(-1)?.body as {
      head: string;
      base: string;
      title: string;
      body: string;
    };
    expect(pr.head).toBe(`sam:${upload.body.branch}`);
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

    await submitRecordingToAppGallery({
      token: "gho_token",
      repo: { owner: "archestra-ai", name: "app-gallery" },
      bundle,
      signal: new AbortController().signal,
      onProgress: () => {},
    });

    const uploads = calls.filter((c) => c.method === "PUT");
    expect(uploads).toHaveLength(2);
    expect(uploads[1].url).toContain(
      "/contents/submissions/sam/pr_review_queue/thumbnail.webp",
    );
    expect(atob((uploads[1].body as { content: string }).content)).toBe(
      "final-frame",
    );
  });

  test("a 401 from GitHub becomes GithubAuthError", async () => {
    stubGithub({
      respond: (method, url) =>
        method === "GET" && url.endsWith("/user")
          ? new Response("", { status: 401 })
          : null,
    });

    await expect(
      submitRecordingToAppGallery({
        token: "gho_revoked",
        repo: { owner: "archestra-ai", name: "app-gallery" },
        bundle: makeBundle(),
        signal: new AbortController().signal,
        onProgress: () => {},
      }),
    ).rejects.toBeInstanceOf(GithubAuthError);
  });

  test("surfaces GitHub's own error message on failure", async () => {
    stubGithub({
      respond: (method, url) =>
        method === "POST" && url.endsWith("/pulls")
          ? Response.json({ message: "Validation Failed" }, { status: 422 })
          : null,
    });

    await expect(
      submitRecordingToAppGallery({
        token: "gho_token",
        repo: { owner: "archestra-ai", name: "app-gallery" },
        bundle: makeBundle(),
        signal: new AbortController().signal,
        onProgress: () => {},
      }),
    ).rejects.toThrow(/422.*Validation Failed/);
  });
});
