export const SIDEBAR_COOKIE_NAME = "sidebar_state";

export function parseSidebarOpen(
  value: string | null | undefined,
): boolean | null {
  return value === "true" ? true : value === "false" ? false : null;
}

export function rememberSidebarOpenCookie(open: boolean) {
  try {
    // Keep the server's next render in sync even when local storage is blocked.
    // biome-ignore lint/suspicious/noDocumentCookie: non-sensitive layout preference shared with SSR
    document.cookie = `${SIDEBAR_COOKIE_NAME}=${open}; path=/; max-age=${60 * 60 * 24 * 7}; samesite=lax`;
  } catch {
    // The in-memory choice still works when browser storage is unavailable.
  }
}
