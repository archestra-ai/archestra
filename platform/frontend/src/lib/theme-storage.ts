import { SUPPORTED_THEMES } from "@archestra/shared";

/** Where this browser remembers the organization's theme (see useOrgTheme). */
export const THEME_STORAGE_KEY = "archestra-theme";

/**
 * Inline `<head>` script for a document rendered before the server knew the
 * organization's theme (a process still waiting on its first appearance
 * read). It swaps the default theme class for the one this browser last saw,
 * before the first paint, so the page does not show the default theme until
 * the client's appearance read lands. Unknown or unreadable values leave the
 * default in place.
 */
export const RESTORE_REMEMBERED_THEME_SCRIPT = `(() => {
  try {
    const theme = localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});
    if (!${JSON.stringify(SUPPORTED_THEMES)}.includes(theme)) return;
    const root = document.documentElement;
    for (const cls of Array.from(root.classList)) {
      if (cls.startsWith("theme-")) root.classList.remove(cls);
    }
    root.classList.add("theme-" + theme);
  } catch {
    // Storage blocked: keep the server's default theme.
  }
})();`;
