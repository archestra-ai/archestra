/**
 * Registry of onboarding red-dot targets in the sidebar. Keys are opaque
 * strings server-side (see `user_onboarding_seen_items`), so future dot
 * targets — including in-page element dots — only need a new entry here.
 */
export type NavDotKey =
  | "nav:projects"
  | "nav:apps"
  | "nav:connect"
  | "nav:model-providers"
  | "nav:mcp-registry";

export interface DottedNavItem {
  key: NavDotKey;
  /** Which sidebar tab the item lives in; "studio" items roll up into the Studio segment dot. */
  mode: "chats" | "studio";
  /** All route variants (incl. beta) that count as visiting the item. */
  urlPrefixes: string[];
}

export const DOTTED_NAV_ITEMS: DottedNavItem[] = [
  { key: "nav:projects", mode: "chats", urlPrefixes: ["/projects"] },
  { key: "nav:apps", mode: "chats", urlPrefixes: ["/apps"] },
  {
    key: "nav:connect",
    mode: "chats",
    urlPrefixes: ["/connection"],
  },
  {
    key: "nav:model-providers",
    mode: "studio",
    urlPrefixes: ["/llm/model-providers", "/llm/models"],
  },
  {
    key: "nav:mcp-registry",
    mode: "studio",
    urlPrefixes: ["/mcp/registry"],
  },
];

/** The dot target the given pathname belongs to, if any. */
export function navDotKeyForPathname(pathname: string): NavDotKey | undefined {
  return DOTTED_NAV_ITEMS.find((item) =>
    item.urlPrefixes.some(
      (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
    ),
  )?.key;
}
