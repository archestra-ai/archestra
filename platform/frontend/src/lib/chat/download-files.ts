/**
 * Start a browser download for each file that has a byte endpoint. There is no
 * zip endpoint, so this fires one download per file (the browser may prompt to
 * allow multiple downloads). Files without a `contentUrl` — e.g. the in-memory
 * `artifact.md` row — are skipped. Returns how many downloads were started.
 */
export function downloadFiles(
  items: Array<{ name: string; contentUrl: string }>,
): number {
  let started = 0;
  for (const item of items) {
    if (!item.contentUrl) continue;
    const anchor = document.createElement("a");
    anchor.href = item.contentUrl;
    anchor.download = item.name;
    anchor.rel = "noopener";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    started += 1;
  }
  return started;
}
