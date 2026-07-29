import { randomUUID } from "node:crypto";
import { GITHUB_MAX_FILE_BYTES } from "@archestra/shared";
import { HttpResponse, http } from "msw";
import { describe, expect, test } from "@/test";
import { useMswServer } from "@/test/msw";
import { useRouteTestApp } from "@/test/route-test-app";
import appRecordingRoutes from "./app-recording.routes";

const RAW_URL =
  "https://raw.githubusercontent.com/archestra-ai/apps-gallery/main/apps/example_app/recording.json";
const RAW_ROUTE =
  "https://raw.githubusercontent.com/:owner/:repo/:ref/apps/:slug/recording.json";

/** The smallest bundle the recording contract accepts. */
function minimalBundle() {
  return {
    formatVersion: 1,
    app: { id: randomUUID(), name: "Example" },
    recording: {
      title: "Example demo",
      startedAt: new Date(0).toISOString(),
      durationMs: 1_000,
      events: [] as unknown[],
      segments: [{ version: 1, html: "<main>app</main>", atMs: 0 }],
      transcript: [
        {
          id: "msg-1",
          role: "user",
          atMs: 0,
          parts: [{ type: "text", text: "Build me an app." }],
        },
      ],
    },
    meta: {
      authorName: "Author",
      createdAt: new Date(0).toISOString(),
      platform: "archestra",
    },
  };
}

/**
 * A bundle the size a real full-motion submission reaches: padded with
 * schema-valid encoded-video chunks until its JSON crosses `bytes`.
 */
function bundleOfAtLeast(bytes: number) {
  const bundle = minimalBundle();
  const data = "A".repeat(1_900_000);
  while (JSON.stringify(bundle).length < bytes) {
    bundle.recording.events.push({
      kind: "video-chunk",
      t: 0,
      sel: "#game",
      type: "delta",
      tsUs: 0,
      data,
    });
  }
  return bundle;
}

describe("GET /api/app-recording/review", () => {
  const ctx = useRouteTestApp(appRecordingRoutes);
  // biome-ignore lint/correctness/useHookAtTopLevel: vitest lifecycle helper (per-test MSW server), not a React hook
  const server = useMswServer();

  test("admits a bundle as large as the gallery itself accepts", async () => {
    // The gallery's only size rule is GitHub's 50MB file ceiling, so a
    // full-motion submission legitimately reaches tens of megabytes — the
    // recorder's governor allows ~29MB for a one-minute cut. A review cap
    // tighter than the gallery's own (it was 15MB once) turns an accepted
    // submission into one the review player never even receives.
    const bundle = bundleOfAtLeast(20 * 1024 * 1024);
    server.use(http.get(RAW_ROUTE, () => HttpResponse.json(bundle)));

    const response = await ctx.app.inject({
      method: "GET",
      url: `/api/app-recording/review?src=${encodeURIComponent(RAW_URL)}`,
    });

    expect(response.statusCode).toBe(200);
    const returned = response.json();
    expect(returned.formatVersion).toBe(1);
    expect(returned.recording.events).toHaveLength(
      bundle.recording.events.length,
    );
  });

  test("refuses a body that runs past GitHub's own file ceiling", async () => {
    // No gallery file can legitimately be this large — GitHub refuses the
    // upload — so past this line the response is not a submission, and the
    // stream is abandoned instead of buffered.
    const chunk = new Uint8Array(1024 * 1024).fill(120);
    const chunks = Math.floor(GITHUB_MAX_FILE_BYTES / chunk.length) + 1;
    server.use(
      http.get(
        RAW_ROUTE,
        () =>
          new HttpResponse(
            new ReadableStream({
              start(controller) {
                for (let i = 0; i < chunks; i++) controller.enqueue(chunk);
                controller.close();
              },
            }),
          ),
      ),
    );

    const response = await ctx.app.inject({
      method: "GET",
      url: `/api/app-recording/review?src=${encodeURIComponent(RAW_URL)}`,
    });

    expect(response.statusCode).toBe(413);
    expect(response.json().error.message).toMatch(/50MB review limit/);
  });

  test("refuses a source anywhere but raw.githubusercontent.com", async () => {
    const response = await ctx.app.inject({
      method: "GET",
      url: `/api/app-recording/review?src=${encodeURIComponent(
        "https://example.com/recording.json",
      )}`,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toMatch(
      /raw\.githubusercontent\.com/,
    );
  });
});
