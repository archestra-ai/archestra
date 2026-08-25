"use client";

import { useEffect, useState } from "react";
import {
  ATTACHMENT_CONTENT_URL_PREFIX,
  getLockedChatKey,
  LOCKED_CHAT_KEY_HEADER,
} from "@/lib/chat/locked-chat";

/**
 * Resolves an attachment byte URL for display.
 *
 * A locked chat's attachment bytes are sealed under a key this browser holds
 * and sends in a request header — and a header is exactly what the browser
 * will not send for you. `<img src>`, `<a download>` and `<iframe src>` issue
 * their own bare GETs, which reach the byte endpoint without the key and get a
 * 400. So for those attachments the bytes are fetched here, once, with the
 * header, and handed to the DOM as a `blob:` URL instead.
 *
 * Putting the key in the query string would have avoided all of this and is
 * why it is not done: URLs end up in access logs, referrers and browser
 * history, and this URL's query string would be the one copy of the key that
 * opens the chat.
 *
 * Everything else — an ordinary chat's attachment, a sandbox artifact, an
 * inline `data:` URL — is returned unchanged and costs nothing.
 */
export function useAttachmentContentUrl(
  url: string | undefined,
  conversationId: string | null | undefined,
): {
  /** The URL to render, or null while a sealed attachment is being fetched. */
  url: string | null;
  /** True once the fetch failed — the caller shows an unavailable state. */
  failed: boolean;
} {
  const needsKey = isAttachmentContentUrl(url) && !!conversationId;
  // Read at render, not in the effect, so a chat with no stored key never
  // schedules a fetch at all.
  const key = needsKey ? getLockedChatKey(conversationId) : null;

  const [resolved, setResolved] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!key || !url) return;
    let objectUrl: string | null = null;
    let cancelled = false;
    setFailed(false);

    fetch(url, { headers: { [LOCKED_CHAT_KEY_HEADER]: key } })
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.blob();
      })
      .then((blob) => {
        // Revoking on unmount is not enough on its own: an aborted-then-remounted
        // effect would otherwise leave this one attached to nothing.
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setResolved(objectUrl);
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

/** True for the chat-attachment byte endpoint, whose bytes may be sealed. */
function isAttachmentContentUrl(url: string | undefined): url is string {
  return (
    typeof url === "string" && url.startsWith(ATTACHMENT_CONTENT_URL_PREFIX)
  );
}
