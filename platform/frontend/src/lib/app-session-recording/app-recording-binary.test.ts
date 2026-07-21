import { describe, expect, it } from "vitest";
import {
  base64ToBytes,
  bytesToBase64,
  dataUrlToBlob,
  reviveRecordingEvents,
  serializeRecordingEvents,
} from "./app-recording-binary";

type StoredEvents = Parameters<typeof reviveRecordingEvents>[0];

describe("recording event binary conversion", () => {
  it("round-trips a WebP still through the stored form", async () => {
    const payload = new Uint8Array([1, 2, 3, 250, 251]);
    const runtime = [
      {
        kind: "canvas",
        t: 10,
        sel: "#c",
        blob: new Blob([payload], { type: "image/webp" }),
      },
    ];
    const stored = await serializeRecordingEvents(runtime);
    expect(String(stored[0].data)).toMatch(/^data:image\/webp;base64,/);
    expect(stored[0]).not.toHaveProperty("blob");
    const revived = reviveRecordingEvents(stored as unknown as StoredEvents);
    const frame = revived[0] as { blob: Blob };
    expect(new Uint8Array(await frame.blob.arrayBuffer())).toEqual(payload);
    expect(frame.blob.type).toBe("image/webp");
    expect(frame).not.toHaveProperty("data");
  });

  it("round-trips video chunks and configs as raw bytes", async () => {
    const bytes = Uint8Array.from({ length: 300 }, (_, i) => (i * 7) % 256);
    const description = new Uint8Array([9, 8, 7]);
    const runtime = [
      {
        kind: "video-config",
        t: 0,
        sel: "#c",
        codec: "vp8",
        codedWidth: 640,
        codedHeight: 360,
        description,
      },
      { kind: "video-chunk", t: 5, sel: "#c", type: "key", tsUs: 5_000, bytes },
    ];
    const stored = await serializeRecordingEvents(runtime);
    expect(typeof stored[0].description).toBe("string");
    expect(typeof stored[1].data).toBe("string");
    expect(stored[1]).not.toHaveProperty("bytes");
    const revived = reviveRecordingEvents(stored as unknown as StoredEvents);
    expect((revived[0] as { description: Uint8Array }).description).toEqual(
      description,
    );
    expect((revived[1] as { bytes: Uint8Array }).bytes).toEqual(bytes);
    expect(revived[1]).not.toHaveProperty("data");
  });

  it("passes non-binary events through and tolerates legacy stored stills", async () => {
    const pointer = { kind: "pointer", t: 1, type: "click", x: 1, y: 2 };
    const legacy = {
      kind: "canvas",
      t: 2,
      sel: "#c",
      data: "data:image/webp;base64,AAEC",
    };
    const stored = await serializeRecordingEvents([pointer, legacy]);
    expect(stored[0]).toEqual(pointer);
    // Already in stored form (an older recorder posted data URLs) — untouched.
    expect(stored[1]).toEqual(legacy);
    // And a legacy stored still revives to the same runtime shape as new ones.
    const revived = reviveRecordingEvents([legacy] as unknown as StoredEvents);
    expect((revived[0] as { blob: Blob }).blob).toBeInstanceOf(Blob);
  });

  it("survives large buffers through the base64 helpers", () => {
    const bytes = Uint8Array.from({ length: 200_000 }, (_, i) => i % 256);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  });

  it("decodes a data URL's mime and payload without fetch", async () => {
    const blob = dataUrlToBlob(
      `data:image/webp;base64,${bytesToBase64(new Uint8Array([0, 128, 255]))}`,
    );
    expect(blob.type).toBe("image/webp");
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(
      new Uint8Array([0, 128, 255]),
    );
  });
});
