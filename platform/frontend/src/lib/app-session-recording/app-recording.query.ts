import {
  APP_RECORDING_RENDER_FPS,
  archestraApiSdk,
  validateRecordingBundle,
} from "@archestra/shared";
import {
  useIsMutating,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useCallback, useEffect } from "react";
import { toast } from "sonner";
import {
  type AppRecordingBundle,
  type AppRecordingEdits,
  type AppRecordingEnhancement,
  type RecordingEditHistory,
  type RecordingEditorState,
  recordingStore,
  subscribeToRecordingChanges,
} from "@/lib/app-session-recording/app-recording-store";
import { handleApiError, toApiError } from "@/lib/utils";

const {
  cancelAppRecordingRender,
  downloadAppRecordingVideo,
  enhanceAppRecording,
  getAppRecordingRenderStatus,
  renderAppRecordingVideo,
} = archestraApiSdk;

export type { AppRecordingBundle };

/** Query key for the single client-side recording of a conversation. */
export function appRecordingKey(conversationId: string | null) {
  return ["app-recording", conversationId] as const;
}

/**
 * The conversation's current recording (the one client-side bundle), or null
 * when the chat has none yet. Drives the player and the Replay button state.
 *
 * The store is one per-origin database shared by every tab, so a recording made
 * in another tab must show up here too: re-read the store fresh on mount/focus
 * (overriding the default staleTime) and invalidate live when another tab writes.
 */
export function useAppRecording(conversationId: string | null) {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!conversationId) return;
    return subscribeToRecordingChanges((changedKey) => {
      if (changedKey === conversationId) {
        queryClient.invalidateQueries({
          queryKey: appRecordingKey(conversationId),
        });
      }
    });
  }, [conversationId, queryClient]);

  return useQuery({
    queryKey: appRecordingKey(conversationId),
    enabled: !!conversationId,
    staleTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
    queryFn: async () => {
      if (!conversationId) return null;
      return await recordingStore.get(conversationId);
    },
  });
}

/** Query key for the app-bound lookup: the app's newest recording anywhere. */
const APP_RECORDING_FOR_APP_KEY_PREFIX = "app-recording-for-app";
function appRecordingForAppKey(appId: string | null) {
  return [APP_RECORDING_FOR_APP_KEY_PREFIX, appId] as const;
}

/**
 * The storage key (conversation id) of the newest recording bound to the app,
 * across ALL conversations. Recordings bind to the app the moment it exists,
 * so a fresh chat opened on an existing app still finds the last session
 * recorded on it — this is the Replay button's fallback when the current
 * conversation has no recording of its own.
 */
export function useLatestAppRecordingKeyForApp(appId: string | null) {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!appId) return;
    // Any write, to any key, can change which recording is the app's newest.
    return subscribeToRecordingChanges(() => {
      queryClient.invalidateQueries({
        queryKey: appRecordingForAppKey(appId),
      });
    });
  }, [appId, queryClient]);

  return useQuery({
    queryKey: appRecordingForAppKey(appId),
    enabled: !!appId,
    staleTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
    queryFn: async () => {
      if (!appId) return null;
      return await recordingStore.findLatestKeyForApp(appId);
    },
  });
}

/** Download the conversation's stored bundle as a JSON file for manual submission. */
export function useDownloadAppRecordingBundle() {
  return useMutation({
    mutationFn: async (conversationId: string) => {
      const bundle = await recordingStore.get(conversationId);
      if (!bundle) {
        toast.error("No recording to download for this session.");
        return null;
      }
      // The export must honor the same contract the player enforces — an
      // invalid bundle is refused rather than passed on.
      const validation = validateRecordingBundle(bundle);
      if (!validation.ok) {
        toast.error(`Download refused. ${validation.reason}`);
        return null;
      }
      saveBundleFile(validation.bundle);
      return conversationId;
    },
  });
}

/**
 * Render the conversation's recording to a video and save it.
 *
 * The bundle is rendered offline from its own data rather than filmed off this
 * screen, so the export is frame-exact and needs no capture permission, and the
 * author can keep working while it runs. The recording is sent with the request
 * and rendered from that copy — the server stores no recordings.
 *
 * Rendering takes longer than a request may: a load balancer answers a
 * minute-long request with a gateway timeout no matter how patiently the
 * browser waits. So the render is a background job — this starts it, waits by
 * asking after it, and collects the file at the end.
 */
export function useRenderAppRecordingVideo() {
  return useMutation({
    // Keyed so the export button can tell a render is running even in a player
    // that was closed and reopened while it was: the mutation lives in the
    // cache, not in the component that started it.
    mutationKey: RENDER_VIDEO_MUTATION_KEY,
    mutationFn: async (params: { conversationId: string; title: string }) => {
      const bundle = await recordingStore.get(params.conversationId);
      if (!bundle) {
        toast.error("No recording to export for this session.");
        return null;
      }
      const validation = validateRecordingBundle(bundle);
      if (!validation.ok) {
        toast.error(`Export refused. ${validation.reason}`);
        return null;
      }
      // This render's own cancellation, registered so the export button can
      // reach a render whose toast has been dismissed. Per-run rather than one
      // module-level "the current job": a second render started before the
      // first settles would take that single slot, and the first render's
      // Cancel would then point at the wrong job — or at none — leaving a
      // render the author asked to stop running to the end on their one slot.
      const cancellation = new AbortController();
      runningRenders.add(cancellation);

      // Rendering runs for tens of seconds, so say so up front and say how
      // long: a silent spinner that long reads as a hang, and the author would
      // otherwise sit and watch a render they are free to walk away from. Both
      // the save and this toast live in the mutation, so closing the player
      // really does leave it running — and the toast carries the way to stop
      // it, since it is the only part of a mistaken click that stays on screen
      // after the player is gone.
      const toastId = toast.loading(
        `Preparing your video — will take about ${renderEstimate(validation.bundle)}. It downloads when it is done. You can now close the player.`,
        { action: { label: "Cancel", onClick: () => cancellation.abort() } },
      );

      try {
        const started = await renderAppRecordingVideo({
          body: { bundle: validation.bundle, title: params.title },
        });
        if (started.error || !started.data?.jobId) {
          toast.dismiss(toastId);
          if (started.error) handleApiError(started.error);
          return null;
        }
        const jobId = started.data.jobId;
        // The job has a name now, so calling it off can reach the server —
        // which is what actually stops it: the job outlives this page, and
        // dropping it here alone would leave a browser running on the author's
        // one render slot. A Cancel clicked while the start request was still
        // in flight fires no listener, so it is applied here rather than lost.
        const stopOnServer = () => {
          void cancelAppRecordingRender({ path: { jobId } });
        };
        if (cancellation.signal.aborted) {
          stopOnServer();
        } else {
          cancellation.signal.addEventListener("abort", stopOnServer, {
            once: true,
          });
        }

        const outcome = await awaitRenderJob(jobId, cancellation.signal);
        if (outcome === "cancelled") {
          toast.info("Video canceled.", { id: toastId });
          return null;
        }
        const { data, error } = await downloadAppRecordingVideo({
          path: { jobId },
          // The response is an MP4, not JSON.
          parseAs: "blob",
        });
        if (error || !data) {
          toast.dismiss(toastId);
          if (error) handleApiError(error);
          return null;
        }
        saveVideoFile(data as Blob, videoFileName(params.title));
        toast.success("Video downloaded.", { id: toastId });
        return params.conversationId;
      } catch (error) {
        // A render that fails, is lost, or outlives the poll has to say so in
        // the very toast that has been promising a download. Dismissing it
        // silently is what makes a dead render read as one still running —
        // there is nothing left on screen to say otherwise.
        toast.error(
          error instanceof Error && error.message
            ? error.message
            : "Your video could not be prepared.",
          { id: toastId },
        );
        return null;
      } finally {
        runningRenders.delete(cancellation);
      }
    },
  });
}

/**
 * Stop the video renders running in this tab.
 *
 * A mistaken click otherwise costs the author a whole render they have to sit
 * through, so both places that show a render is running — the toast and the
 * export button — can call it off. The toast cancels the one render it belongs
 * to; this is the export button's way in, and it holds no reference to any
 * particular render, so it stops whatever is going.
 */
export function cancelAppRecordingVideoRender(): void {
  for (const cancellation of runningRenders) cancellation.abort();
}

/**
 * Wait for a render job to settle, by asking after it.
 *
 * Polling rather than streaming: the answer is one word and the wait is under a
 * minute, so a request every couple of seconds costs less than holding a
 * connection open through whatever sits between here and the server — which is
 * the very thing that made the synchronous render unshippable.
 */
async function awaitRenderJob(
  jobId: string,
  cancelled: AbortSignal,
): Promise<"done" | "cancelled"> {
  const deadline = Date.now() + RENDER_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (cancelled.aborted) return "cancelled";
    await new Promise((resolve) =>
      setTimeout(resolve, RENDER_POLL_INTERVAL_MS),
    );
    const { data, error } = await getAppRecordingRenderStatus({
      path: { jobId },
    });
    // The cancel and the poll race — a status request already in flight when
    // the author called it off can land afterwards still reporting `running` —
    // so the intent is read from the signal, not inferred from the answer.
    if (cancelled.aborted) return "cancelled";
    if (error) {
      // Jobs live in the server's memory, so a deploy or a restart takes every
      // render that was running with it. That reads as a plain 404 here, which
      // is true but says nothing an author can act on.
      throw new Error(
        isMissingJob(error)
          ? "The server restarted while your video was being prepared. Start the download again."
          : toApiError(error).message,
      );
    }
    if (data?.status === "cancelled") return "cancelled";
    if (data?.status === "failed") {
      throw new Error(data.error ?? "The video could not be rendered.");
    }
    if (data?.status === "done") return "done";
  }
  throw new Error("Preparing this video took too long. Try a shorter cut.");
}

/** A status poll that found no such job — it finished, expired, or was lost. */
function isMissingJob(error: unknown): boolean {
  const status = (error as { status?: number } | null)?.status;
  if (status === 404) return true;
  return /no longer available/i.test(toApiError(error as never).message);
}

/**
 * The renders going in this tab, so the export button can call one off: it
 * holds no reference to the mutation that started one, and the toast that does
 * may already have been dismissed. A set rather than a single current job —
 * two renders started in quick succession are both really running, and a
 * cancel has to reach both rather than whichever one registered last.
 */
const runningRenders = new Set<AbortController>();
const RENDER_POLL_INTERVAL_MS = 1_500;
/** Well past the longest export the editor allows, as a stuck-job backstop. */
const RENDER_POLL_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Whether a video render is running anywhere in this tab. The export button
 * reads this rather than its own mutation state, which a closed-and-reopened
 * player would have forgotten — leaving the button live and inviting a second
 * render of the same recording.
 */
export function useIsRenderingAppRecordingVideo(): boolean {
  return useIsMutating({ mutationKey: RENDER_VIDEO_MUTATION_KEY }) > 0;
}

const RENDER_VIDEO_MUTATION_KEY = ["app-recording", "render-video"] as const;

/** The description used when AI generation is unavailable or still pending. */
export function fallbackRecordingDescription(appName: string): string {
  return `${appName} — an interactive app built in chat.`;
}

/**
 * Draft the AI enhancement (one-sentence description + consolidated build
 * prompt) for the conversation's recording. Pure generation — nothing is
 * stored until it is applied (automatically at stop, or via the edit
 * controls).
 */
export function useEnhanceAppRecording() {
  return useMutation({
    mutationFn: async (params: { conversationId: string; appName: string }) => {
      const { data, error } = await enhanceAppRecording({ body: params });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data ?? null;
    },
  });
}

/** Bound so a marathon editing session can't grow the stored history unbounded. */
const MAX_EDIT_HISTORY = 100;

function editHistoryKey(conversationId: string | null) {
  return ["app-recording-edit-history", conversationId] as const;
}

/**
 * The recording editor: applies mutations (cuts, the AI enhancement) to the
 * conversation's stored bundle and maintains a persistent undo/redo history.
 * The captured `recording` object is never touched — the bundle's layered
 * `edits`/`enhancement` objects always carry the CURRENT resulting state (that
 * is what playback applies and what Download saves), while the history snapshots
 * live in a separate client-side record that survives reloads for as long as
 * the recording is stored. Undo/redo move the cursor through the snapshots; a
 * new edit after undos discards the redo tail — edits A,B,C,D with C,D undone
 * and then E,F applied yields A,B,E,F.
 */
export function useAppRecordingEditor(conversationId: string | null) {
  const queryClient = useQueryClient();

  const { data: history } = useQuery({
    queryKey: editHistoryKey(conversationId),
    enabled: !!conversationId,
    staleTime: 0,
    refetchOnMount: "always",
    queryFn: async () => {
      if (!conversationId) return null;
      return await recordingStore.getHistory(conversationId);
    },
  });

  // Write one history state: persist it, stamp its current entry onto the
  // bundle's layered objects, and refresh both queries so the player replays it.
  const mutation = useMutation({
    mutationFn: async (params: {
      conversationId: string;
      next: RecordingEditHistory;
    }) => {
      const bundle = await recordingStore.get(params.conversationId);
      if (!bundle) {
        toast.error("No recording to edit for this session.");
        return null;
      }
      const state = params.next.entries[params.next.cursor];
      // Never wedge the stored recording: an edit that would break the shared
      // bundle contract is refused outright, leaving bundle and history as
      // they were (the player validates on load, so an invalid write would
      // take down the whole replay).
      const stamped = {
        ...bundle,
        edits: state?.edits,
        enhancement: state?.enhancement,
      };
      const validation = validateRecordingBundle(stamped);
      if (!validation.ok) {
        toast.error(`Edit not applied. ${validation.reason}`);
        return null;
      }
      // Both halves of the edit in one write: a history that persisted while
      // the bundle it describes did not would leave undo pointing at a state
      // the recording is not in.
      await recordingStore.putWithHistory({
        key: params.conversationId,
        bundle: stamped,
        history: params.next,
      });
      return params;
    },
    onSuccess: (result) => {
      if (!result) return;
      queryClient.invalidateQueries({
        queryKey: appRecordingKey(result.conversationId),
      });
      queryClient.invalidateQueries({
        queryKey: editHistoryKey(result.conversationId),
      });
    },
  });

  const commit = useCallback(
    (next: RecordingEditHistory) => {
      if (!conversationId) return;
      mutation.mutate({ conversationId, next });
    },
    [conversationId, mutation],
  );

  const applyChange = useCallback(
    async (change: Partial<RecordingEditorState>) => {
      if (!conversationId) return;
      // Seed the history lazily with the bundle's pre-editing state, so the
      // first undo returns to the recording as it was before any edit.
      const seeded: RecordingEditHistory =
        (await recordingStore.getHistory(conversationId)) ??
        (await (async () => {
          const bundle = await recordingStore.get(conversationId);
          return {
            entries: [
              { edits: bundle?.edits, enhancement: bundle?.enhancement },
            ],
            cursor: 0,
          };
        })());
      // A new edit layers onto the current state and truncates the redo tail.
      const current = seeded.entries[seeded.cursor] ?? {};
      const entries = [
        ...seeded.entries.slice(0, seeded.cursor + 1),
        { ...current, ...change },
      ].slice(-MAX_EDIT_HISTORY);
      commit({ entries, cursor: entries.length - 1 });
    },
    [conversationId, commit],
  );

  const applyEdits = useCallback(
    (edits: AppRecordingEdits) => applyChange({ edits }),
    [applyChange],
  );
  const applyEnhancement = useCallback(
    (enhancement: AppRecordingEnhancement | undefined) =>
      applyChange({ enhancement }),
    [applyChange],
  );

  const undo = useCallback(() => {
    if (!history || history.cursor <= 0) return;
    commit({ ...history, cursor: history.cursor - 1 });
  }, [history, commit]);

  const redo = useCallback(() => {
    if (!history || history.cursor >= history.entries.length - 1) return;
    commit({ ...history, cursor: history.cursor + 1 });
  }, [history, commit]);

  return {
    applyEdits,
    applyEnhancement,
    undo,
    redo,
    canUndo: !!history && history.cursor > 0,
    canRedo: !!history && history.cursor < history.entries.length - 1,
    isSaving: mutation.isPending,
  };
}

/** Invalidate the conversation's recording query after a new recording is stored. */
export function useInvalidateAppRecording() {
  const queryClient = useQueryClient();
  return useCallback(
    (conversationId: string) => {
      queryClient.invalidateQueries({
        queryKey: appRecordingKey(conversationId),
      });
      // A new recording can also change which one is an app's newest — the
      // same-tab path (BroadcastChannel never echoes to its own tab).
      queryClient.invalidateQueries({
        queryKey: [APP_RECORDING_FOR_APP_KEY_PREFIX],
      });
    },
    [queryClient],
  );
}

function saveBundleFile(bundle: AppRecordingBundle) {
  const blob = new Blob([JSON.stringify(bundle, null, 2)], {
    type: "application/json",
  });
  // Revoked on a delay, exactly as a video download is: the browser reads the
  // blob asynchronously after the click, so revoking in a `finally` races that
  // read and truncates a bundle big enough to matter.
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${slugify(bundle.recording.title)}.demo.json`;
  anchor.style.display = "none";
  document.body.append(anchor);
  anchor.click();
  setTimeout(() => {
    anchor.remove();
    URL.revokeObjectURL(url);
  }, DOWNLOAD_HANDOFF_MS);
}

function videoFileName(title: string): string {
  return `${slugify(title)}-session.mp4`;
}

/**
 * Roughly how long this recording will take to render, phrased coarsely on
 * purpose — the real cost is one screenshot and one encode per frame, which
 * varies with the machine doing it. Three buckets is the whole useful range:
 * the editor caps an export at half a minute of video, which is about a minute
 * of rendering, so a finer number would be false precision either way.
 */
function renderEstimate(bundle: AppRecordingBundle): string {
  const frames =
    (bundle.recording.durationMs / 1000) * APP_RECORDING_RENDER_FPS;
  const seconds = RENDER_STARTUP_SECONDS + frames * RENDER_SECONDS_PER_FRAME;
  if (seconds < 30) return "half a minute";
  if (seconds < 75) return "a minute";
  return "a couple of minutes";
}

/** Measured: browser launch, page load and encoder finalize. */
const RENDER_STARTUP_SECONDS = 2;
/** Measured: one seek, one cropped screenshot, one encoded frame. */
const RENDER_SECONDS_PER_FRAME = 0.083;

/**
 * Save a rendered video through the browser's own download flow. The object
 * URL must outlive the click: revoking straight away races the download
 * manager, which is still reading the blob, and truncates exactly the large
 * files a long render produces.
 */
function saveVideoFile(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.style.display = "none";
  document.body.append(anchor);
  anchor.click();
  setTimeout(() => {
    anchor.remove();
    URL.revokeObjectURL(url);
  }, DOWNLOAD_HANDOFF_MS);
}

/** How long the object URL is held after the click, so the download can read it. */
const DOWNLOAD_HANDOFF_MS = 60_000;

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "app-session"
  );
}
