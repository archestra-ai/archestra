import { conversationStorageKeys } from "@/lib/chat/chat-utils";

/**
 * A hackathon submission being reviewed inside a chat. The Slack "Replay" button
 * deep-links into `/chat/new?...&review=<sub>&reviewSrc=<rawUrl>&pr=&repo=&app=&
 * by=&name=&cat=`; those params seed one of these, which docks the read-only
 * replay player into the chat's right panel while the reviewer talks to the
 * Hackathon agent about that one submission.
 *
 * Mirrors the full-page `/review` link contract (`sub, src, pr, repo, app, by,
 * name, cat`). `src` is the raw recording.json URL the bundle is fetched from
 * (via `/api/app-recording/review?src=`); `prUrl` is derived from `repo`+`pr`.
 */
export interface ChatReviewContext {
  /** Submission id — the `review` (aliased `sub`) param. */
  sub: string;
  /** Raw recording.json URL — the `reviewSrc` (aliased `src`) param. */
  src: string;
  pr?: string;
  repo?: string;
  /** App display name. */
  app?: string;
  /** Author github login. */
  by?: string;
  /** Author display name. */
  name?: string;
  /** Category label. */
  cat?: string;
}

/**
 * Per-conversation review context, kept in a module-level map so it survives the
 * shallow `/chat/new` -> `/chat` -> `/chat/<id>` navigation (which drops the URL
 * params), and mirrored to localStorage so a hard reload of `/chat/<id>` keeps
 * the review docked. Keyed by conversation id, so an unrelated chat never
 * inherits a stale review.
 */
const memory = new Map<string, ChatReviewContext | null>();
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function readStored(conversationId: string): ChatReviewContext | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(
      conversationStorageKeys(conversationId).reviewContext,
    );
    return raw ? (JSON.parse(raw) as ChatReviewContext) : null;
  } catch {
    return null;
  }
}

/** Attach (or replace) the review context for a conversation. */
export function setReviewContext(
  conversationId: string,
  context: ChatReviewContext,
): void {
  memory.set(conversationId, context);
  try {
    localStorage.setItem(
      conversationStorageKeys(conversationId).reviewContext,
      JSON.stringify(context),
    );
  } catch {
    // A private-mode / quota failure only loses reload persistence; the
    // in-memory copy still docks the review for this session.
  }
  emit();
}

/**
 * Drop a conversation's review context from both the in-memory map and
 * localStorage. Call on conversation deletion so abandoned entries don't leak.
 */
export function clearReviewContext(conversationId: string): void {
  memory.delete(conversationId);
  try {
    localStorage.removeItem(
      conversationStorageKeys(conversationId).reviewContext,
    );
  } catch {
    // Nothing persisted / private mode — the in-memory delete above is enough.
  }
  emit();
}

/**
 * The conversation's review context, or null. Hydrates from localStorage on the
 * first read and caches the parsed object, so repeated calls return a stable
 * reference — safe as a `useSyncExternalStore` snapshot.
 */
export function getReviewContext(
  conversationId: string | undefined,
): ChatReviewContext | null {
  if (!conversationId) return null;
  if (memory.has(conversationId)) return memory.get(conversationId) ?? null;
  const stored = readStored(conversationId);
  memory.set(conversationId, stored);
  return stored;
}

/** Subscribe to review-context changes (any conversation). */
export function subscribeReviewContext(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
