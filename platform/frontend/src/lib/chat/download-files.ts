import { resolveSealedAttachmentUrl } from "@/lib/chat/locked-chat-attachment";

/**
 * Start a browser download for each file that has a byte endpoint. There is no
 * zip endpoint, so this fires one download per file (the browser may prompt to
 * allow multiple downloads). Files without a `contentUrl` — e.g. the in-memory
 * `artifact.md` row — are skipped. Returns how many downloads were started.
 *
 * `conversationId` is what lets this work in a locked chat: those attachments
 * only serve their bytes to a request carrying the conversation key, which an
 * anchor cannot send, so they are fetched first and downloaded from a `blob:`
 * URL. A file that cannot be fetched is skipped rather than downloaded as an
 * error page.
 */
export async function downloadFiles(
  items: Array<{ name: string; contentUrl: string }>,
  conversationId?: string | null,
): Promise<number> {
  let started = 0;
  for (const item of items) {
    if (!item.contentUrl) continue;

    let objectUrl: string | null = null;
    try {
      objectUrl = await resolveSealedAttachmentUrl(
        item.contentUrl,
        conversationId,
      );
    } catch {
      // Sealed but unreadable here (no key, or a key that does not match).
      // Nothing useful to hand the browser, so leave this one out.
      continue;
    }

    const anchor = document.createElement("a");
    anchor.href = objectUrl ?? item.contentUrl;
    anchor.download = item.name;
    anchor.rel = "noopener";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    // Revoked on the next tick: revoking synchronously can race the browser's
    // read of the blob it was just handed.
    if (objectUrl) setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
    started += 1;
  }
  return started;
}
