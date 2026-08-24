"use client";

import { requiredPagePermissionsMap } from "@archestra/shared/access-control";
import { Badge } from "@/components/ui/badge";
import { usePermissionMap } from "@/lib/auth/auth.query";
import { useFeature } from "@/lib/config/config.query";

/**
 * Tabs shared by the three pages of the Agents section — Agents
 * (`/agents`), Skills (`/skills`) and Plugins (`/plugins`). Agents is the
 * section's landing page and the only one the sidebar links to; its siblings
 * are reached through this tab bar.
 *
 * A tab is dropped when the deployment has the feature turned off or the user
 * can't open the page behind it, so the bar never offers a link that would
 * only render a forbidden page. While the permission answer is still loading
 * the gated tabs stay hidden rather than flashing in and back out.
 */
export function useAgentsNavTabs() {
  const permissionMap = usePermissionMap(requiredPagePermissionsMap);
  const pluginsEnabled = useFeature("plugins");

  return AGENTS_NAV_TABS.filter(({ href }) => {
    if (href === "/plugins" && !pluginsEnabled) {
      return false;
    }
    const required = requiredPagePermissionsMap[href];
    const isGated = required && Object.keys(required).length > 0;
    return isGated ? permissionMap?.[href] === true : true;
  }).map(({ href, title, beta }) => ({
    href,
    label: beta ? <BetaTabLabel title={title} /> : title,
  }));
}

const AGENTS_NAV_TABS = [
  { title: "Agents", href: "/agents", beta: false },
  { title: "Skills", href: "/skills", beta: true },
  { title: "Plugins", href: "/plugins", beta: true },
];

function BetaTabLabel({ title }: { title: string }) {
  return (
    <span className="flex items-center gap-1.5">
      {title}
      <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
        Beta
      </Badge>
    </span>
  );
}
