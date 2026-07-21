import { archestraApiSdk } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cancelAppRecordingVideoRender,
  useRenderAppRecordingVideo,
} from "./app-recording.query";
import { type AppRecordingBundle, recordingStore } from "./app-recording-store";

// The render is a background job on the server, so the SDK is the boundary:
// the real mutation, the real poll loop and the real cancellation run here.
vi.mock("@archestra/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@archestra/shared")>();
  return {
    ...actual,
    archestraApiSdk: {
      renderAppRecordingVideo: vi.fn(),
      getAppRecordingRenderStatus: vi.fn(),
      downloadAppRecordingVideo: vi.fn(),
      cancelAppRecordingRender: vi.fn(),
    },
  };
});
vi.mock("sonner");

const sdk = vi.mocked(archestraApiSdk);

// Bundle validation requires a real UUID app id.
const APP_ID = "3b1f8d3e-8f5a-4c57-9a4e-2f60cf1f2b01";
/** Just past one poll interval, so a cancelled loop reaches its exit. */
const DRAIN_MS = 1_700;

function bundle(title: string): AppRecordingBundle {
  return {
    formatVersion: 1,
    app: { id: APP_ID, name: "App" },
    recording: {
      title,
      startedAt: new Date(0).toISOString(),
      durationMs: 1_000,
      events: [{ kind: "segment", t: 0, version: 1 }],
      segments: [{ version: 1, html: "<h1>v1</h1>", atMs: 0 }],
      // A bundle with no chat activity is refused before a render starts.
      transcript: [
        {
          id: "m1",
          role: "user",
          atMs: 0,
          parts: [{ type: "text", text: "Build me an app." }],
        },
      ],
    },
    meta: {
      authorName: null,
      createdAt: new Date(0).toISOString(),
      platform: "archestra",
    },
  };
}

const createWrapper = () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
};

/** The Cancel handler carried by the nth loading toast raised so far. */
function toastCancel(nth: number): () => void {
  const call = vi.mocked(toast.loading).mock.calls[nth];
  const action = call?.[1]?.action;
  if (!action || typeof action !== "object" || !("onClick" in action)) {
    throw new Error(`Toast ${nth} carried no Cancel action`);
  }
  return () => (action.onClick as (event: unknown) => void)(undefined);
}

/** Start a render and wait until the server has named its job. */
async function startRender(conversationId: string, started: number) {
  const { result } = renderHook(() => useRenderAppRecordingVideo(), {
    wrapper: createWrapper(),
  });
  act(() => {
    result.current.mutate({ conversationId, title: conversationId });
  });
  await waitFor(() =>
    expect(sdk.renderAppRecordingVideo).toHaveBeenCalledTimes(started),
  );
  // Let the job id land and its cancellation listener attach.
  await act(async () => {});
  return result;
}

describe("useRenderAppRecordingVideo", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await recordingStore.put("conv-a", bundle("A"));
    await recordingStore.put("conv-b", bundle("B"));
    sdk.renderAppRecordingVideo
      .mockResolvedValueOnce({ data: { jobId: "job-a" } } as never)
      .mockResolvedValueOnce({ data: { jobId: "job-b" } } as never);
    // Never settles on its own: these tests are about how a render ends when
    // the author ends it.
    sdk.getAppRecordingRenderStatus.mockResolvedValue({
      data: { status: "running" },
    } as never);
    sdk.cancelAppRecordingRender.mockResolvedValue({ data: {} } as never);
  });

  afterEach(async () => {
    // The set of running renders is module state. A case that deliberately
    // leaves one polling would otherwise still be registered when the next
    // case counts them — so stop them, then give the poll loops the one
    // interval they need to notice and deregister.
    cancelAppRecordingVideoRender();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, DRAIN_MS));
    });
  });

  it("cancels the render its own toast belongs to, not whichever started last", async () => {
    await startRender("conv-a", 1);
    await startRender("conv-b", 2);

    // The first render's toast, clicked while a second render is also going.
    // A single module-level "current job" would have been overwritten by the
    // second start, sending this click to job-b — cancelling a render the
    // author never asked to stop and leaving theirs running to the end.
    act(toastCancel(0));

    expect(sdk.cancelAppRecordingRender).toHaveBeenCalledTimes(1);
    expect(sdk.cancelAppRecordingRender).toHaveBeenCalledWith({
      path: { jobId: "job-a" },
    });
  });

  it("stops a render the author called off before the server named the job", async () => {
    // Cancel clicked while the start request is still in flight: there is no
    // job id to send yet, so the intent has to survive until there is one.
    let nameTheJob!: (value: unknown) => void;
    sdk.renderAppRecordingVideo.mockReset();
    sdk.renderAppRecordingVideo.mockReturnValue(
      new Promise((resolve) => {
        nameTheJob = resolve;
      }) as never,
    );

    const { result } = renderHook(() => useRenderAppRecordingVideo(), {
      wrapper: createWrapper(),
    });
    act(() => {
      result.current.mutate({ conversationId: "conv-a", title: "A" });
    });
    await waitFor(() => expect(toast.loading).toHaveBeenCalledTimes(1));

    act(toastCancel(0));
    expect(sdk.cancelAppRecordingRender).not.toHaveBeenCalled();

    await act(async () => {
      nameTheJob({ data: { jobId: "job-late" } });
    });

    // Dropping it here alone would leave a browser running on the author's one
    // render slot: the job outlives this page.
    expect(sdk.cancelAppRecordingRender).toHaveBeenCalledWith({
      path: { jobId: "job-late" },
    });
    await waitFor(() => expect(result.current.data).toBeNull());
  });

  it("rides out a transient status-poll failure instead of failing the render", async () => {
    // A backend blip mid-render — a 5xx from a pod being drained in a rolling
    // deploy, a dropped connection — used to abort the whole render on the
    // first failed poll and surface a raw error. It must instead keep polling:
    // the render is still fine and the video still downloads once the server
    // answers again. Only a definitive "no such job" 404 ends it early.
    const createObjectURL = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue("blob:mock");
    const revokeObjectURL = vi
      .spyOn(URL, "revokeObjectURL")
      .mockReturnValue(undefined);
    try {
      sdk.getAppRecordingRenderStatus
        .mockReset()
        // A transient 5xx (not a missing-job 404) on the first poll...
        .mockResolvedValueOnce({ error: { status: 500 } } as never)
        // ...then the render reports finished.
        .mockResolvedValue({ data: { status: "done" } } as never);
      sdk.downloadAppRecordingVideo.mockResolvedValue({
        data: new Blob(["mp4"], { type: "video/mp4" }),
      } as never);

      await startRender("conv-a", 1);

      await waitFor(
        () =>
          expect(toast.success).toHaveBeenCalledWith(
            "Video downloaded.",
            expect.anything(),
          ),
        { timeout: 8_000 },
      );
      // The blip was ridden out: the video was collected, not reported as an
      // error the author has to decode.
      expect(sdk.downloadAppRecordingVideo).toHaveBeenCalledWith({
        path: { jobId: "job-a" },
        parseAs: "blob",
      });
      expect(toast.error).not.toHaveBeenCalled();
    } finally {
      createObjectURL.mockRestore();
      revokeObjectURL.mockRestore();
    }
  });

  it("stops every running render when the export button calls them off", async () => {
    await startRender("conv-a", 1);
    await startRender("conv-b", 2);

    // The button holds no reference to a particular render — and after a
    // double-click there are two, both really running.
    act(() => cancelAppRecordingVideoRender());

    expect(sdk.cancelAppRecordingRender).toHaveBeenCalledTimes(2);
    expect(sdk.cancelAppRecordingRender).toHaveBeenCalledWith({
      path: { jobId: "job-a" },
    });
    expect(sdk.cancelAppRecordingRender).toHaveBeenCalledWith({
      path: { jobId: "job-b" },
    });
  });
});
