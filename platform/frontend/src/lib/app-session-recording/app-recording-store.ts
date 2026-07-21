import type { AppRecordingBundle } from "@archestra/shared";

/**
 * The portable, self-contained recording bundle — the shared contract's
 * `AppRecordingBundle`, re-exported so feature code has one import home.
 * Assembled in the browser at record time so it needs no server round-trip to
 * replay or download.
 */
export type { AppRecordingBundle };

export type AppRecordingEdits = NonNullable<AppRecordingBundle["edits"]>;
export type AppRecordingEnhancement = NonNullable<
  AppRecordingBundle["enhancement"]
>;

/**
 * Everything the player's editor can mutate — the layered objects that ride on
 * the bundle NEXT TO the immutable capture: timeline edits (cuts) and the
 * AI-drafted enhancement (description + consolidated prompt).
 */
export interface RecordingEditorState {
  edits?: AppRecordingBundle["edits"];
  enhancement?: AppRecordingBundle["enhancement"];
}

/**
 * The editor's undo/redo history for one recording: snapshots of the editor
 * state, oldest first, with `cursor` pointing at the current state. Stored
 * next to the bundle (never inside it), so it survives reloads for as long as
 * the recording is stored, but never leaves the browser — the bundle's own
 * `edits`/`enhancement` always carry the current resulting state.
 */
export interface RecordingEditHistory {
  entries: RecordingEditorState[];
  cursor: number;
}

/**
 * One app-session recording per conversation, kept entirely client-side.
 * Keyed by conversation id (a new recording overwrites the chat's previous
 * one), durable across reloads and crashes so a demo survives without
 * re-recording. The edit history rides alongside under a prefixed key and
 * follows the same lifetime.
 */
export interface RecordingStore {
  get(key: string): Promise<AppRecordingBundle | null>;
  put(key: string, bundle: AppRecordingBundle): Promise<void>;
  /**
   * Store a bundle and the edit history describing it as ONE write.
   *
   * They are two halves of a single edit and have to land together. A history
   * that persisted without its bundle leaves undo pointing at a state the
   * recording is not in — the player replays the older bundle while the editor
   * believes the newer one was applied. One transaction means a write refused
   * partway (the quota the second one trips) takes the first back out with it.
   */
  putWithHistory(params: {
    key: string;
    bundle: AppRecordingBundle;
    history: RecordingEditHistory;
  }): Promise<void>;
  delete(key: string): Promise<void>;
  /**
   * The storage key of the newest stored recording bound to the app — across
   * every conversation. Recordings bind to the app the moment it exists (the
   * bundle carries `app.id`), so a fresh chat opened on an existing app can
   * find the last session recorded anywhere on that app.
   */
  findLatestKeyForApp(appId: string): Promise<string | null>;
  getHistory(key: string): Promise<RecordingEditHistory | null>;
  deleteHistory(key: string): Promise<void>;
}

const DB_NAME = "archestra-app-recordings";
const DB_VERSION = 1;
const OBJECT_STORE = "recordings";
const CHANGE_CHANNEL = "archestra-app-recording-changes";
/** History records share the bundle object store under a prefixed key. */
const HISTORY_KEY_PREFIX = "edit-history:";

/**
 * Announce a write so other tabs of this origin re-read the shared store. The
 * store is a single per-origin database, so a recording made in one tab must
 * invalidate the recording query in every other tab.
 */
function broadcastRecordingChange(key: string): void {
  if (typeof BroadcastChannel === "undefined") return;
  try {
    const channel = new BroadcastChannel(CHANGE_CHANNEL);
    channel.postMessage({ key });
    channel.close();
  } catch {
    // best-effort cross-tab sync
  }
}

/** Subscribe to recording writes from other tabs; returns an unsubscribe. */
export function subscribeToRecordingChanges(
  onChange: (key: string) => void,
): () => void {
  if (typeof BroadcastChannel === "undefined") return () => {};
  const channel = new BroadcastChannel(CHANGE_CHANNEL);
  channel.onmessage = (event) => {
    const key = (event.data as { key?: unknown } | null)?.key;
    if (typeof key === "string") onChange(key);
  };
  return () => channel.close();
}

/** IndexedDB-backed store (the browser). Values persist to disk per origin. */
class IndexedDbRecordingStore implements RecordingStore {
  private dbPromise: Promise<IDBDatabase> | null = null;
  private persistenceRequested = false;

  async get(key: string): Promise<AppRecordingBundle | null> {
    const db = await this.db();
    const value = await this.run<AppRecordingBundle | undefined>(
      db,
      "readonly",
      (store) => store.get(key),
    );
    return value ?? null;
  }

  async put(key: string, bundle: AppRecordingBundle): Promise<void> {
    void this.requestPersistence();
    const db = await this.db();
    await this.run(db, "readwrite", (store) => store.put(bundle, key));
    broadcastRecordingChange(key);
  }

  async putWithHistory(params: {
    key: string;
    bundle: AppRecordingBundle;
    history: RecordingEditHistory;
  }): Promise<void> {
    void this.requestPersistence();
    const db = await this.db();
    await this.runBatch(db, (store) => {
      store.put(params.bundle, params.key);
      store.put(params.history, HISTORY_KEY_PREFIX + params.key);
    });
    broadcastRecordingChange(params.key);
  }

  async delete(key: string): Promise<void> {
    const db = await this.db();
    await this.run(db, "readwrite", (store) => store.delete(key));
    broadcastRecordingChange(key);
  }

  async findLatestKeyForApp(appId: string): Promise<string | null> {
    const db = await this.db();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(OBJECT_STORE, "readonly");
      const request = tx.objectStore(OBJECT_STORE).openCursor();
      let bestKey: string | null = null;
      let bestCreatedAt = "";
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          resolve(bestKey);
          return;
        }
        const key = String(cursor.key);
        if (!key.startsWith(HISTORY_KEY_PREFIX)) {
          const candidate = cursor.value as AppRecordingBundle | undefined;
          if (candidate?.app?.id === appId) {
            const createdAt = candidate.meta?.createdAt ?? "";
            if (bestKey === null || createdAt > bestCreatedAt) {
              bestKey = key;
              bestCreatedAt = createdAt;
            }
          }
        }
        cursor.continue();
      };
      request.onerror = () => reject(request.error);
      // The cursor's own error covers a failed read, but not a transaction the
      // browser tears down under it (an eviction, a force-close). Without this
      // the promise never settles and the Replay button waits forever.
      tx.onabort = () => reject(tx.error);
    });
  }

  async getHistory(key: string): Promise<RecordingEditHistory | null> {
    const db = await this.db();
    const value = await this.run<RecordingEditHistory | undefined>(
      db,
      "readonly",
      (store) => store.get(HISTORY_KEY_PREFIX + key),
    );
    return value ?? null;
  }

  async deleteHistory(key: string): Promise<void> {
    const db = await this.db();
    await this.run(db, "readwrite", (store) =>
      store.delete(HISTORY_KEY_PREFIX + key),
    );
  }

  private db(): Promise<IDBDatabase> {
    if (!this.dbPromise) {
      this.dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(OBJECT_STORE)) {
            db.createObjectStore(OBJECT_STORE);
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    }
    return this.dbPromise;
  }

  private run<T>(
    db: IDBDatabase,
    mode: IDBTransactionMode,
    op: (store: IDBObjectStore) => IDBRequest,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(OBJECT_STORE, mode);
      const request = op(tx.objectStore(OBJECT_STORE));
      request.onsuccess = () => resolve(request.result as T);
      request.onerror = () => reject(request.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  /**
   * Apply several writes as ONE transaction — all of them land or none do.
   *
   * Settles on the TRANSACTION rather than on the requests: a request that
   * succeeded says nothing about a later one being refused, and it is that
   * refusal which has to take the earlier write back out again.
   */
  private runBatch(
    db: IDBDatabase,
    ops: (store: IDBObjectStore) => void,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(OBJECT_STORE, "readwrite");
      ops(tx.objectStore(OBJECT_STORE));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  /**
   * Ask the browser to keep this origin's storage from being evicted under disk
   * pressure. Best-effort and one-shot — a denial just leaves the default
   * (still durable across reloads, only evictable under pressure).
   */
  private async requestPersistence(): Promise<void> {
    if (this.persistenceRequested) return;
    this.persistenceRequested = true;
    try {
      if (
        navigator.storage?.persist &&
        !(await navigator.storage.persisted())
      ) {
        await navigator.storage.persist();
      }
    } catch {
      // best-effort; ignore
    }
  }
}

/** In-memory store: the SSR/no-IndexedDB fallback, and the store used in tests. */
export class MemoryRecordingStore implements RecordingStore {
  private readonly map = new Map<string, AppRecordingBundle>();
  private readonly histories = new Map<string, RecordingEditHistory>();

  async get(key: string): Promise<AppRecordingBundle | null> {
    return this.map.get(key) ?? null;
  }

  async put(key: string, bundle: AppRecordingBundle): Promise<void> {
    this.map.set(key, bundle);
  }

  async putWithHistory(params: {
    key: string;
    bundle: AppRecordingBundle;
    history: RecordingEditHistory;
  }): Promise<void> {
    this.map.set(params.key, params.bundle);
    this.histories.set(params.key, params.history);
  }

  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }

  async findLatestKeyForApp(appId: string): Promise<string | null> {
    let bestKey: string | null = null;
    let bestCreatedAt = "";
    for (const [key, candidate] of this.map) {
      if (candidate.app.id !== appId) continue;
      const createdAt = candidate.meta?.createdAt ?? "";
      if (bestKey === null || createdAt > bestCreatedAt) {
        bestKey = key;
        bestCreatedAt = createdAt;
      }
    }
    return bestKey;
  }

  async getHistory(key: string): Promise<RecordingEditHistory | null> {
    return this.histories.get(key) ?? null;
  }

  async deleteHistory(key: string): Promise<void> {
    this.histories.delete(key);
  }
}

export const recordingStore: RecordingStore =
  typeof indexedDB !== "undefined"
    ? new IndexedDbRecordingStore()
    : new MemoryRecordingStore();

declare global {
  interface Window {
    /**
     * Published by the player only while rendering a video, and driven by the
     * offline renderer: seek to an exact millisecond, then screenshot.
     */
    __archestraReplay?: {
      ready(): Promise<void>;
      durationMs(): number;
      seek(ms: number): Promise<void>;
    };
    __archestraRenderSeed(bundle: unknown): Promise<void>;
    __archestraRenderReady(): Promise<number>;
    __archestraRenderSeek(ms: number): Promise<void>;
    __archestraRenderEncoderStart(params: {
      width: number;
      height: number;
      fps: number;
      crop?: { x: number; y: number; width: number; height: number };
    }): Promise<void>;
    /** Enqueue a frame; resolves with the encoder's backlog depth. */
    __archestraRenderEncodeFrame(jpeg: string, index: number): Promise<number>;
    /** Re-add the previous frame at this index (compositor saw no change). */
    __archestraRenderRepeatFrame(index: number): Promise<number>;
    /** Wait out the encode backlog; rethrows a queued frame's failure. */
    __archestraRenderEncodeDrain(): Promise<void>;
    __archestraRenderEncoderFinish(): Promise<string>;
  }
}
