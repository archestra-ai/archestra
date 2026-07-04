"use client";

import { requiredPagePermissionsMap } from "@archestra/shared/access-control";
import { usePathname } from "next/navigation";
import React from "react";
import { useHasPermissions, usePermissionMap } from "@/lib/auth/auth.query";
import {
  DOTTED_NAV_ITEMS,
  type NavDotKey,
  navDotKeyForPathname,
} from "@/lib/onboarding/nav-onboarding";
import {
  useMarkNavItemsSeen,
  useSeenNavItems,
} from "@/lib/onboarding/onboarding.query";

/**
 * Single source of truth for the onboarding red dots: which dotted nav items
 * are visible to this user (RBAC/feature-flag filtered — hidden items never
 * propagate a dot), which are still unseen, and the aggregate dots for the
 * Studio segment and the collapsed-sidebar toggle. Also clears a dot when the
 * user lands on its route (deep links included).
 *
 * `unseenKeys` stays empty until every gating query has resolved, so dots only
 * ever appear (or get dismissed) — they never flash and vanish on load.
 */
export function useNavOnboarding() {
  const pathname = usePathname();
  const { data: seenData, isSuccess: seenLoaded } = useSeenNavItems();
  const permissionMap = usePermissionMap(requiredPagePermissionsMap);
  // Connect is compound-gated (same as the sidebar): both reads required.
  const { data: canReadLlmProxy } = useHasPermissions({ llmProxy: ["read"] });
  const { data: canReadMcpGateway } = useHasPermissions({
    mcpGateway: ["read"],
  });
  const { mutate: markItemsSeen } = useMarkNavItemsSeen();

  const ready =
    seenLoaded &&
    permissionMap !== null &&
    canReadLlmProxy !== undefined &&
    canReadMcpGateway !== undefined;

  const unseenKeys = React.useMemo(() => {
    if (!ready) return new Set<NavDotKey>();
    const seen = new Set(seenData?.items ?? []);
    const visible = (key: NavDotKey): boolean => {
      switch (key) {
        case "nav:projects":
          return permissionMap["/projects"] ?? true;
        case "nav:apps":
          return permissionMap["/apps"] ?? true;
        case "nav:connect":
          return canReadLlmProxy === true && canReadMcpGateway === true;
        case "nav:model-providers":
          return permissionMap["/llm/model-providers"] ?? true;
        case "nav:mcp-registry":
          return permissionMap["/mcp/registry"] ?? true;
      }
    };
    return new Set(
      DOTTED_NAV_ITEMS.filter(
        (item) => visible(item.key) && !seen.has(item.key),
      ).map((item) => item.key),
    );
  }, [ready, seenData, permissionMap, canReadLlmProxy, canReadMcpGateway]);

  const markSeen = React.useCallback(
    (key: NavDotKey) => {
      if (!unseenKeys.has(key) || inFlightKeys.has(key)) return;
      inFlightKeys.add(key);
      markItemsSeen([key], {
        onSettled: () => inFlightKeys.delete(key),
      });
    },
    [unseenKeys, markItemsSeen],
  );

  // Deep-link clearing: landing on a dotted route counts as visiting it.
  React.useEffect(() => {
    if (!ready) return;
    const key = navDotKeyForPathname(pathname);
    if (key) markSeen(key);
  }, [ready, pathname, markSeen]);

  return {
    unseenKeys,
    showChatsDot: DOTTED_NAV_ITEMS.some(
      (item) => item.mode === "chats" && unseenKeys.has(item.key),
    ),
    showStudioDot: DOTTED_NAV_ITEMS.some(
      (item) => item.mode === "studio" && unseenKeys.has(item.key),
    ),
    showCollapsedToggleDot: unseenKeys.size > 0,
    markSeen,
  };
}

// Shared across hook instances (sidebar + app shell) so a route visit only
// fires one mark-seen request even though both instances observe it.
const inFlightKeys = new Set<NavDotKey>();
