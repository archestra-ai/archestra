"use client";

import { useEffect, useState } from "react";
import {
  ATTACHMENT_CONTENT_URL_PREFIX,
  getLockedChatKey,
  LOCKED_CHAT_KEY_HEADER,
} from "@/lib/chat/locked-chat";

/**
 * Resolving an attachment byte URL for the DOM.
 *
 * A locked chat's attachment bytes are sealed under a key this browser holds
 * and sends in a request header — and a header is exactly what the browser
 * will not send for you. `<img src>`, `<a download>` and `<iframe src>` issue
 * their own bare GETs, which reach the byte endpoint without the key and get a
 * 400. So for those attachments the bytes are fetched here, with the header,
 * and handed to the DOM as a `blob:` URL instead.
 *
 * Putting the key in the query string would have avoided all of this and is
 * why it is not done: URLs end up in access logs, referrers and browser
 * history, and this URL's query string would be the one copy of the key that
 * opens the chat.
 *
 * Everything else — an ordinary chat's attachment, a sandbox artifact, an
 * inline `data:` URL — is returned unchanged and costs nothing.
 */

/**
 * The URL to render for `url`, kept alive for as long as the component is.
 *
 * Returns `{ url }` immediately for anything that needs no key. For a sealed
 * attachment `url` is null until the bytes arrive, then a `blob:` URL that is
 * revoked on unmount; `failed` turns true if the fetch does not come back.
 */
export function useAttachmentContentUrl(
  url: string | undefined,
  conversationId: string | null | undefined,
): { url: string | null; failed: boolean } {
  // Read at render, not in the effect, so a chat with no stored key never
  // schedules a fetch at all.
  const key = lockedChatKeyFor(url, conversationId);

  const [resolved, setResolved] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!key || !url) return;
    let objectUrl: string | null = null;
    let cancelled = false;
    setFailed(false);

    fetchSealedObjectUrl(url, key)
      .then((created) => {
        // Revoking on unmount is not enough on its own: an aborted-then-
        // remounted effect would otherwise leave this one attached to nothing.
        if (cancelled) {
          URL.revokeObjectURL(created);
          return;
        }
        objectUrl = created;
        setResolved(created);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      setResolved(null);
    };
  }, [url, key]);

  if (!key) return { url: url ?? null, failed: false };
  return { url: resolved, failed };
}

/**
 * One-shot resolution for a URL that is used and discarded — a download click,
 * as opposed to something rendered for the life of a component. The caller
 * revokes what it gets back once the browser has taken it.
 *
 * Returns null when `url` needs no key, meaning "use it as it is".
 */
export async function resolveSealedAttachmentUrl(
  url: string,
  conversationId: string | null | undefined,
): Promise<string | null> {
  const key = lockedChatKeyFor(url, conversationId);
  return key ? await fetchSealedObjectUrl(url, key) : null;
}

// === Internal ===

/**
 * The conversation key needed to read `url`, or null when the URL is not a
 * chat attachment, there is no conversation, or this browser holds no key for
 * it (an ordinary chat — the common case).
 */
function lockedChatKeyFor(
  url: string | undefined,
  conversationId: string | null | undefined,
): string | null {
  if (
    typeof url !== "string" ||
    !url.startsWith(ATTACHMENT_CONTENT_URL_PREFIX)
  ) {
    return null;
  }
  return conversationId ? getLockedChatKey(conversationId) : null;
}

async function fetchSealedObjectUrl(url: string, key: string): Promise<string> {
  const response = await fetch(url, {
    headers: { [LOCKED_CHAT_KEY_HEADER]: key },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return URL.createObjectURL(await response.blob());
}
