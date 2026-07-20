import { describe, expect, it } from "vitest";
import {
  type AppRecordingBundle,
  MemoryRecordingStore,
} from "@/lib/app-session-recording/app-recording-store";

function bundle(
  appId: string,
  title: string,
  createdAtMs = 0,
): AppRecordingBundle {
  return {
    formatVersion: 1,
    app: { id: appId, name: "App" },
    recording: {
      title,
      startedAt: new Date(0).toISOString(),
      durationMs: 1_000,
      events: [{ kind: "segment", t: 0, version: 1 }],
      segments: [{ version: 1, html: "<h1>v1</h1>", atMs: 0 }],
      transcript: [],
    },
    meta: {
      authorName: null,
      createdAt: new Date(createdAtMs).toISOString(),
      platform: "archestra",
    },
  };
}

describe("MemoryRecordingStore", () => {
  it("returns null for an app with no recording", async () => {
    const store = new MemoryRecordingStore();
    expect(await store.get("app-1")).toBeNull();
  });

  it("stores and reads one recording per app", async () => {
    const store = new MemoryRecordingStore();
    await store.put("app-1", bundle("app-1", "first"));
    expect((await store.get("app-1"))?.recording.title).toBe("first");
  });

  it("overwrites the app's previous recording (one per app)", async () => {
    const store = new MemoryRecordingStore();
    await store.put("app-1", bundle("app-1", "first"));
    await store.put("app-1", bundle("app-1", "second"));
    expect((await store.get("app-1"))?.recording.title).toBe("second");
  });

  it("keeps recordings for different apps separate", async () => {
    const store = new MemoryRecordingStore();
    await store.put("app-1", bundle("app-1", "one"));
    await store.put("app-2", bundle("app-2", "two"));
    expect((await store.get("app-1"))?.recording.title).toBe("one");
    expect((await store.get("app-2"))?.recording.title).toBe("two");
  });

  it("stores an edited bundle and the history describing it together", async () => {
    const store = new MemoryRecordingStore();
    // The editor writes both halves of an edit at once — a history that landed
    // without its bundle would leave undo pointing at a state the recording is
    // not in.
    await store.putWithHistory({
      key: "conv-1",
      bundle: bundle("app-1", "edited"),
      history: { entries: [{}, { edits: { cuts: [] } }], cursor: 1 },
    });

    expect((await store.get("conv-1"))?.recording.title).toBe("edited");
    expect(await store.getHistory("conv-1")).toEqual({
      entries: [{}, { edits: { cuts: [] } }],
      cursor: 1,
    });
  });

  it("deletes a recording", async () => {
    const store = new MemoryRecordingStore();
    await store.put("app-1", bundle("app-1", "first"));
    await store.delete("app-1");
    expect(await store.get("app-1")).toBeNull();
  });

  it("finds the app's newest recording across conversations", async () => {
    const store = new MemoryRecordingStore();
    // Recordings are keyed by CONVERSATION; the same app was recorded in two
    // different chats, and another app's recording sits alongside.
    await store.put("conv-1", bundle("app-1", "older", 1_000));
    await store.put("conv-2", bundle("app-1", "newer", 2_000));
    await store.put("conv-3", bundle("app-2", "other", 3_000));

    expect(await store.findLatestKeyForApp("app-1")).toBe("conv-2");
    expect(await store.findLatestKeyForApp("app-2")).toBe("conv-3");
    expect(await store.findLatestKeyForApp("app-none")).toBeNull();
  });
});
