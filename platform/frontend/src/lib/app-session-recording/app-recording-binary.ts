import type { AppRecordingBundle } from "@archestra/shared";

/**
 * Runtime ↔ stored conversion for a recording's binary events.
 *
 * The bundle at rest is JSON (zod-validated, IndexedDB-stored, uploaded to the
 * render route, downloadable), so frame bytes live there as base64 — but ONLY
 * there. Everywhere else — the SDK capturing in the app frame, postMessage
 * through the sandbox proxy, the recorder's in-memory buffer, the player
 * posting paints — frames travel as `Blob`/`Uint8Array`, which structured
 * clone carries without copying through strings. These two functions are the
 * bundle's edges: `serializeRecordingEvents` runs once when a stopped capture
 * is assembled into a bundle, `reviveRecordingEvents` once when a stored
 * bundle is opened for replay.
 */

type StoredEvent = AppRecordingBundle["recording"]["events"][number];
type StoredCanvasFrame = Extract<StoredEvent, { kind: "canvas" }>;
type StoredVideoConfig = Extract<StoredEvent, { kind: "video-config" }>;
type StoredVideoChunk = Extract<StoredEvent, { kind: "video-chunk" }>;
type StoredAudioConfig = Extract<StoredEvent, { kind: "audio-config" }>;
type StoredAudioChunk = Extract<StoredEvent, { kind: "audio-chunk" }>;

/** A canvas still with its pixels as an encoded-image Blob (WebP fallback). */
export type RuntimeCanvasFrame = Omit<StoredCanvasFrame, "data"> & {
  blob: Blob;
};
/** A stream config with its codec extradata as raw bytes. */
export type RuntimeVideoConfig = Omit<StoredVideoConfig, "description"> & {
  description?: Uint8Array;
};
/** An encoded video chunk with its payload as raw bytes. */
export type RuntimeVideoChunk = Omit<StoredVideoChunk, "data"> & {
  bytes: Uint8Array;
};
/** The audio stream config with its codec extradata as raw bytes. */
export type RuntimeAudioConfig = Omit<StoredAudioConfig, "description"> & {
  description?: Uint8Array;
};
/** An encoded audio chunk with its payload as raw bytes. */
export type RuntimeAudioChunk = Omit<StoredAudioChunk, "data"> & {
  bytes: Uint8Array;
};

export type RuntimeRecordingEvent =
  | Exclude<
      StoredEvent,
      | StoredCanvasFrame
      | StoredVideoConfig
      | StoredVideoChunk
      | StoredAudioConfig
      | StoredAudioChunk
    >
  | RuntimeCanvasFrame
  | RuntimeVideoConfig
  | RuntimeVideoChunk
  | RuntimeAudioConfig
  | RuntimeAudioChunk;

/**
 * Stored → runtime, once at bundle-open time. Synchronous: base64 decode is
 * the whole job, and paying it here — once, before playback starts — is what
 * keeps it off the per-frame paint path.
 */
export function reviveRecordingEvents(
  events: readonly StoredEvent[],
): RuntimeRecordingEvent[] {
  return events.map((event): RuntimeRecordingEvent => {
    if (event.kind === "canvas") {
      const { data, ...rest } = event;
      return { ...rest, blob: dataUrlToBlob(data) };
    }
    if (event.kind === "video-chunk") {
      const { data, ...rest } = event;
      return { ...rest, bytes: base64ToBytes(data) };
    }
    if (event.kind === "video-config") {
      const { description, ...rest } = event;
      return description === undefined
        ? rest
        : { ...rest, description: base64ToBytes(description) };
    }
    if (event.kind === "audio-chunk") {
      const { data, ...rest } = event;
      return { ...rest, bytes: base64ToBytes(data) };
    }
    if (event.kind === "audio-config") {
      const { description, ...rest } = event;
      return description === undefined
        ? rest
        : { ...rest, description: base64ToBytes(description) };
    }
    return event;
  });
}

/**
 * Runtime → stored, once when a stopped capture becomes a bundle. Async only
 * because reading a Blob is; runs host-side after recording ended, so the
 * encode cost never touches the recorded app.
 *
 * Events that already arrived in stored form (a string `data`) pass through —
 * the recorder ingests whatever the SDK posted, and an older SDK still posts
 * data URLs.
 */
export async function serializeRecordingEvents(
  events: readonly Record<string, unknown>[],
): Promise<Record<string, unknown>[]> {
  return Promise.all(
    events.map(async (event) => {
      if (event.kind === "canvas" && event.blob instanceof Blob) {
        const { blob, ...rest } = event;
        return { ...rest, data: await blobToDataUrl(blob) };
      }
      if (event.kind === "video-chunk" && event.bytes instanceof Uint8Array) {
        const { bytes, ...rest } = event;
        return { ...rest, data: bytesToBase64(bytes) };
      }
      if (
        event.kind === "video-config" &&
        event.description instanceof Uint8Array
      ) {
        return { ...event, description: bytesToBase64(event.description) };
      }
      if (event.kind === "audio-chunk" && event.bytes instanceof Uint8Array) {
        const { bytes, ...rest } = event;
        return { ...rest, data: bytesToBase64(bytes) };
      }
      if (
        event.kind === "audio-config" &&
        event.description instanceof Uint8Array
      ) {
        return { ...event, description: bytesToBase64(event.description) };
      }
      return event;
    }),
  );
}

/** data URL → Blob without fetch(): the payload is already in memory. */
export function dataUrlToBlob(dataUrl: string): Blob {
  const comma = dataUrl.indexOf(",");
  const header = comma >= 0 ? dataUrl.slice(0, comma) : "";
  const payload = comma >= 0 ? dataUrl.slice(comma + 1) : "";
  const mime = /^data:([^;,]+)/.exec(header)?.[1] ?? "application/octet-stream";
  const bytes = header.includes(";base64")
    ? base64ToBytes(payload)
    : new TextEncoder().encode(decodeURIComponent(payload));
  return new Blob([bytes as BlobPart], { type: mime });
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsDataURL(blob);
  });
}

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Chunked so a multi-megabyte frame never overflows the argument stack. */
export function bytesToBase64(bytes: Uint8Array): string {
  const STEP = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += STEP) {
    binary += String.fromCharCode(...bytes.subarray(i, i + STEP));
  }
  return btoa(binary);
}
