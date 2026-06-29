import type { FileUIPart } from "ai";

/**
 * In-memory carrier for chat attachments handed off from a surface that starts
 * a chat elsewhere — e.g. the project page composer handing off to `/chat`.
 *
 * The files are already self-contained data URLs, but an attachment can be tens
 * of MB, far past what a URL or `sessionStorage` (~5 MB quota) can hold. A
 * module-level singleton survives the client-side handoff navigation (and the
 * follow-up navigation to `/chat/<id>`) without a storage quota; a hard reload
 * starts empty, which is acceptable for a one-shot handoff.
 *
 * Every handoff replaces the set wholesale, so an attachment-free handoff can
 * never inherit a stale set left behind by an abandoned one. Draining is bound
 * to the `attachments=1` handoff URL marker on the `/chat` side so the shared
 * auto-send path never pulls these files into an unrelated handoff.
 */

let pendingFiles: FileUIPart[] = [];

/** Stash the attachments for the next chat handoff, replacing any prior set. */
export function setPendingChatHandoffFiles(files: FileUIPart[]): void {
  pendingFiles = files;
}

/** Whether attachments are waiting — a peek that does not consume them. */
export function hasPendingChatHandoffFiles(): boolean {
  return pendingFiles.length > 0;
}

/** Return the stashed attachments and clear the store. */
export function drainPendingChatHandoffFiles(): FileUIPart[] {
  const files = pendingFiles;
  pendingFiles = [];
  return files;
}
