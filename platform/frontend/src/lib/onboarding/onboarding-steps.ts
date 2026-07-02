/**
 * Onboarding step config: which sidebar menu items get a gentle red dot.
 *
 * Each step is a leaf, completed (persisted) once the user visits it. Absence
 * of a completed key means the dot still shows, so new users see the full
 * onboarding. Tab rollup dots (AI / Studio) and the collapsed-sidebar nudge are
 * derived from these.
 *
 * To add onboarding targets, extend `ONBOARDING_MENU_STEPS`.
 */

/** Sidebar tab an item lives under (mirrors the sidebar's AI/Studio toggle). */
export type SidebarTab = "chats" | "studio";

export interface MenuStep {
  /** Stable, persisted key for this menu item (cleared on navigation). */
  key: string;
  /** Sidebar nav `url` this dot attaches to (matches a `NavItem.url`). */
  url: string;
  /** Which sidebar tab this item lives under; drives the tab rollup dot. */
  tab: SidebarTab;
  /**
   * Extra urls that resolve to the same item — e.g. a feature-flagged beta
   * route. The dot and its navigation completion apply to all of them.
   */
  altUrls?: string[];
}

export const ONBOARDING_MENU_STEPS: MenuStep[] = [
  { key: "projects", url: "/projects", tab: "chats" },
  { key: "apps", url: "/apps", tab: "chats" },
  {
    key: "connect",
    url: "/connection",
    tab: "chats",
    altUrls: ["/connection_beta"],
  },
  {
    key: "mcp-registry",
    url: "/mcp/registry",
    tab: "studio",
    altUrls: ["/mcp/registry/beta"],
  },
  { key: "model-providers", url: "/llm/model-providers", tab: "studio" },
];

/** All urls a menu step attaches to (its primary url plus any alternates). */
function urlsForStep(step: MenuStep): string[] {
  return step.altUrls ? [step.url, ...step.altUrls] : [step.url];
}

/** The menu step attached to a sidebar item's url, if any. */
export function menuStepForUrl(
  url: string,
  steps: readonly MenuStep[] = ONBOARDING_MENU_STEPS,
): MenuStep | undefined {
  return steps.find((step) => urlsForStep(step).includes(url));
}

/** Whether a menu item has been visited. */
export function isMenuStepDone(
  step: MenuStep,
  done: ReadonlySet<string>,
): boolean {
  return done.has(step.key);
}

/**
 * Menu steps whose url matches the current pathname — these auto-complete on
 * navigation. Prefix match so deep links under the section (e.g.
 * `/mcp/registry/foo`) still count as visiting it.
 */
export function menuStepsForPath(
  pathname: string,
  steps: readonly MenuStep[] = ONBOARDING_MENU_STEPS,
): MenuStep[] {
  return steps.filter((step) =>
    urlsForStep(step).some(
      (url) => pathname === url || pathname.startsWith(`${url}/`),
    ),
  );
}

/**
 * A sidebar tab's rollup dot is done once every *visible* item under that tab
 * is done. Used for the tab-level dot that nudges the user to a section whose
 * per-item dots are hidden while another tab is showing. Steps the user can't
 * see (`visibleKeys`) are excluded, so RBAC/feature-hidden items never keep the
 * rollup lit. A tab with no visible items is trivially done (no dot).
 */
export function isSidebarTabDone(
  tab: SidebarTab,
  done: ReadonlySet<string>,
  steps: readonly MenuStep[] = ONBOARDING_MENU_STEPS,
  visibleKeys?: ReadonlySet<string>,
): boolean {
  return steps
    .filter((step) => step.tab === tab && isStepVisible(step, visibleKeys))
    .every((step) => isMenuStepDone(step, done));
}

/**
 * Whether any *visible* dotted menu item is still incomplete. Drives the
 * collapsed-sidebar nudge dot on the toggle button, since the per-item dots are
 * hidden while the sidebar is closed. Excludes steps the user can't see.
 */
export function hasPendingOnboarding(
  done: ReadonlySet<string>,
  steps: readonly MenuStep[] = ONBOARDING_MENU_STEPS,
  visibleKeys?: ReadonlySet<string>,
): boolean {
  return steps.some(
    (step) => isStepVisible(step, visibleKeys) && !isMenuStepDone(step, done),
  );
}

/**
 * Whether a step counts toward parent (rollup / toggle) dots. When no
 * visibility set is provided (e.g. unit tests), every step counts.
 */
function isStepVisible(
  step: MenuStep,
  visibleKeys?: ReadonlySet<string>,
): boolean {
  return !visibleKeys || visibleKeys.has(step.key);
}
