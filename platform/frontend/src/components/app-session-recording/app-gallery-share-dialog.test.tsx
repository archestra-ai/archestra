import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppRecordingBundle } from "@/lib/app-session-recording/app-recording-store";
import { recordingStore } from "@/lib/app-session-recording/app-recording-store";
import { useFeature } from "@/lib/config/config.query";
import {
  AppGalleryShareButton,
  finalCutDurationMs,
  initialCategoryPick,
} from "./app-gallery-share-dialog";

vi.mock("@/lib/config/config.query");

// Only the async/network boundary is mocked — every pure helper
// (gallerySubmissionSlug, oversizedGallerySubmissionFile,
// rememberGallerySubmission, buildGallerySubmissionFiles, ...) runs for real,
// so this exercises the actual serialization path, not a stand-in for it.
vi.mock("@/lib/app-session-recording/app-gallery-share", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/app-session-recording/app-gallery-share")
  >("@/lib/app-session-recording/app-gallery-share");
  return {
    ...actual,
    takeCachedGithubToken: vi.fn(),
    submitRecordingToAppGallery: vi.fn(),
  };
});

import {
  submitRecordingToAppGallery,
  takeCachedGithubToken,
} from "@/lib/app-session-recording/app-gallery-share";

const mockTakeToken = vi.mocked(takeCachedGithubToken);
const mockSubmit = vi.mocked(submitRecordingToAppGallery);

const CONVERSATION_ID = "conv-category-gate";

function testBundle(
  overrides?: Partial<AppRecordingBundle["enhancement"]>,
): AppRecordingBundle {
  return {
    formatVersion: 1,
    app: { id: null, name: "Test App" },
    recording: {
      title: "Test App demo",
      startedAt: "2026-01-01T00:00:00.000Z",
      durationMs: 4_000,
      events: [{ kind: "segment", t: 0, version: 1 }],
      segments: [{ version: 1, html: "<h1>a</h1>", atMs: 0 }],
      transcript: [
        {
          id: "m1",
          role: "user",
          atMs: -1,
          parts: [{ type: "text", text: "hi" }],
        },
      ],
    },
    enhancement: {
      description: "A test app.",
      prompt: "Build a test app.",
      category: "Games",
      ...overrides,
    },
    meta: {
      authorName: "Tester",
      createdAt: "2026-01-01T00:00:00.000Z",
      platform: "archestra",
    },
  } as unknown as AppRecordingBundle;
}

describe("finalCutDurationMs", () => {
  it("reflects a cut, not the raw capture length", () => {
    const raw = testBundle();
    const cut: AppRecordingBundle = {
      ...raw,
      recording: { ...raw.recording, durationMs: 10_000 },
      edits: { cuts: [{ fromMs: 2_000, toMs: 10_000 }] },
    } as unknown as AppRecordingBundle;

    expect(finalCutDurationMs(cut)).toBeLessThan(10_000);
    expect(finalCutDurationMs(cut)).toBeGreaterThanOrEqual(0);
  });

  it("matches the uncut recording's own duration when there are no cuts", () => {
    const bundle = testBundle();
    // A single short segment with no interaction events collapses to (close
    // to) its own durationMs — the exact contract lives in buildPlayback's
    // own test suite; this only pins that the wrapper doesn't diverge from it.
    expect(finalCutDurationMs(bundle)).toBeLessThanOrEqual(
      bundle.recording.durationMs,
    );
  });
});

describe("initialCategoryPick", () => {
  it('picks a canonical suggestion directly, with no "Other" text pending', () => {
    expect(initialCategoryPick("Workflows")).toEqual({
      select: "Workflows",
      otherText: "",
    });
  });

  it('routes a non-canonical suggestion (old AI-draft vocabulary) to "Other", pre-filled', () => {
    expect(initialCategoryPick("Games")).toEqual({
      select: "Other",
      otherText: "Games",
    });
  });

  it('defaults to an empty "Other" when nothing was suggested', () => {
    expect(initialCategoryPick(null)).toEqual({
      select: "Other",
      otherText: "",
    });
  });
});

describe("AppGalleryShareButton — category gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    vi.mocked(useFeature).mockReturnValue({ owner: "acme", name: "gallery" });
    mockTakeToken.mockReturnValue("gho_cached_token");
    mockSubmit.mockResolvedValue({
      prUrl: "https://github.com/acme/gallery/pull/1",
    });
  });

  async function openDialog(conversationId: string) {
    const user = userEvent.setup();
    render(
      <AppGalleryShareButton
        conversationId={conversationId}
        disabled={false}
      />,
    );
    await user.click(
      screen.getByRole("button", { name: /submit this session/i }),
    );
    return user;
  }

  it("submits the freshly-chosen category on Continue, not a stale one read back from state", async () => {
    await recordingStore.put(
      CONVERSATION_ID,
      testBundle({ category: "Games" }),
    );
    const user = await openDialog(CONVERSATION_ID);

    // A cached token skips sign-in and lands directly on the category
    // screen — "Games" isn't one of the six canonical categories, so it's
    // offered as the pre-filled "Other" value per initialCategoryPick.
    await screen.findByText("Choose a category");
    expect(mockSubmit).not.toHaveBeenCalled();

    // Continue with the pre-filled value unchanged.
    await user.click(
      screen.getByRole("button", { name: /create pull request/i }),
    );

    await waitFor(() => expect(mockSubmit).toHaveBeenCalledTimes(1));
    const submittedBundle = mockSubmit.mock.calls[0][0].bundle;
    // This is the exact regression a stale `category` state read (instead of
    // the value `chooseCategory` passes straight into `run`) would produce:
    // the category gate would re-trigger instead of this ever being called.
    expect(submittedBundle.enhancement?.category).toBe("Games");
  });

  it("submits a canonical category chosen directly from the list", async () => {
    await recordingStore.put(
      `${CONVERSATION_ID}-canonical`,
      testBundle({ category: "Workflows" }),
    );
    const user = await openDialog(`${CONVERSATION_ID}-canonical`);

    await screen.findByText("Choose a category");
    await user.click(
      screen.getByRole("button", { name: /create pull request/i }),
    );

    await waitFor(() => expect(mockSubmit).toHaveBeenCalledTimes(1));
    expect(mockSubmit.mock.calls[0][0].bundle.enhancement?.category).toBe(
      "Workflows",
    );
  });

  it("blocks submission with a clear message when the recording has no description or prompt yet", async () => {
    await recordingStore.put(`${CONVERSATION_ID}-incomplete`, {
      ...testBundle(),
      enhancement: undefined,
    } as unknown as AppRecordingBundle);
    await openDialog(`${CONVERSATION_ID}-incomplete`);

    await screen.findByText(/no description or build prompt yet/i);
    expect(mockSubmit).not.toHaveBeenCalled();
  });
});
