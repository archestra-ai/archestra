/**
 * Loads the Agents page's code ahead of a navigation, e.g. on hover of a link
 * to it. Route prefetch stops at the page's loading boundary, so without this
 * the page's chunks start downloading only after the click. Loading the code
 * starts no request for the page's data.
 */
export function preloadAgentsPage() {
  void import("./page.client").catch(() => {});
}
