/**
 * Copies text to the user's clipboard.
 *
 * `navigator.clipboard` only exists in secure contexts (HTTPS or localhost),
 * so deployments reached over plain HTTP (e.g. `http://<host>:3000`) don't get
 * the async Clipboard API at all. In that case — or when the Clipboard API
 * rejects (e.g. permission denied) — fall back to the legacy hidden-textarea +
 * `document.execCommand("copy")` approach, which still works there.
 *
 * Rejects if the text could not be copied by either mechanism.
 */
export async function copyToClipboard(text: string): Promise<void> {
  if (navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fall through to the legacy fallback
    }
  }
  legacyCopyToClipboard(text);
}

// === Internal helpers ===

function legacyCopyToClipboard(text: string) {
  const textArea = document.createElement("textarea");
  textArea.value = text;
  // Keep the textarea invisible without affecting layout or scroll position
  textArea.style.position = "fixed";
  textArea.style.left = "-9999px";
  textArea.style.top = "0";
  textArea.setAttribute("readonly", "");
  document.body.appendChild(textArea);
  textArea.select();
  try {
    if (!document.execCommand("copy")) {
      throw new Error("Copying to the clipboard is not supported here");
    }
  } finally {
    document.body.removeChild(textArea);
  }
}
