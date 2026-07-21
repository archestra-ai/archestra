"use client";

import type { AppRecordingBundle } from "@archestra/shared";
import { useCallback, useEffect, useState } from "react";
import { AppSessionPlayer } from "@/components/app-session-recording/app-session-player";
import { recordingStore } from "@/lib/app-session-recording/app-recording-store";
import {
  drainEncoder,
  enqueueFrame,
  finishEncoder,
  repeatFrame,
  startEncoder,
} from "@/lib/app-session-recording/app-recording-video-encoder";

/**
 * The page an offline video render drives — never navigated to by a person.
 *
 * It mounts the ordinary player so a rendered video is pixel-identical to what
 * the author sees, then exposes the handful of controls the renderer needs on
 * `window`: seed a bundle, report the duration, seek to an exact millisecond,
 * and encode frames the renderer captures. Seeding through the normal store
 * keeps the player's data path untouched — the renderer supplies the bundle
 * because recordings live in the author's browser and never on the server.
 */
export default function AppRecordingRenderPage() {
  // Seeded state lives OUTSIDE the component: the providers above this page
  // remount their children as auth and config resolve, and a remount that
  // reset this back to null would strand the renderer waiting for a replay
  // that had already been seeded.
  const [conversationId, setConversationId] = useState<string | null>(
    seededConversationId,
  );

  const seed = useCallback(async (bundle: AppRecordingBundle) => {
    // A fixed id: this page renders exactly one recording per page load.
    const id = RENDER_CONVERSATION_ID;
    await recordingStore.put(id, bundle);
    seededConversationId = id;
    setConversationId(id);
  }, []);

  useEffect(() => {
    window.__archestraRenderSeed = (bundle) =>
      seed(bundle as unknown as AppRecordingBundle);
    window.__archestraRenderReady = async () => {
      const replay = await waitFor(() => window.__archestraReplay);
      await replay.ready();
      return replay.durationMs();
    };
    window.__archestraRenderSeek = async (ms) => {
      const replay = await waitFor(() => window.__archestraReplay);
      await replay.seek(ms);
    };
    window.__archestraRenderEncoderStart = startEncoder;
    window.__archestraRenderEncodeFrame = async (jpeg, index) =>
      enqueueFrame(jpeg, index);
    window.__archestraRenderRepeatFrame = async (index) => repeatFrame(index);
    window.__archestraRenderEncodeDrain = drainEncoder;
    window.__archestraRenderEncoderFinish = finishEncoder;
  }, [seed]);

  if (!conversationId) return null;
  return (
    <AppSessionPlayer
      conversationId={conversationId}
      open
      onOpenChange={() => {}}
      filming
    />
  );
}

/** Fixed and valid hex: `m` is not a hex digit, and this id reaches a store
 *  keyed by conversation ids that are UUIDs everywhere else. */
const RENDER_CONVERSATION_ID = "00000000-0000-4000-8000-000000000f11";

/** Survives the remounts the provider chain above this page performs. */
let seededConversationId: string | null = null;

/** Poll until the player has published its replay controls. */
async function waitFor<T>(read: () => T | undefined): Promise<T> {
  for (let i = 0; i < 600; i++) {
    const value = read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("The replay never became ready to render.");
}
