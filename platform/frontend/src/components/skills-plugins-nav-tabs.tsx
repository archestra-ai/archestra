"use client";

import { requiredPagePermissionsMap } from "@archestra/shared/access-control";
import { Badge } from "@/components/ui/badge";
import { usePermissionMap } from "@/lib/auth/auth.query";
import { useFeature } from "@/lib/config/config.query";

/**
 * Tabs shared by the two pages of the Skills & Plugins section — Skills
 * (`/skills`) and Plugins (`/plugins`). Skills is the section's landing page
 * and the one the sidebar links to; Plugins is reached through this tab bar.
 *
 * A tab is dropped when the deployment has the feature turned off or the user
 * can't open the page behind it, so the bar never offers a link that would
 * only render a forbidden page. While the permission answer is still loading
 * the gated tabs stay hidden rather than flashing in and back out.
 *
 * One surviving tab means there is nowhere to switch to — the common case,
 * since plugins are off by default — so the bar collapses entirely rather
 * than underlining the page you are already on.
 */
export function useSkillsPluginsNavTabs() {
  const permissionMap = usePermissionMap(requiredPagePermissionsMap);
  const pluginsEnabled = useFeature("plugins");

  const reachable = NAV_TABS.filter(({ href }) => {
    if (href === "/plugins" && !pluginsEnabled) {
      return false;
    }
    const required = requiredPagePermissionsMap[href];
    const isGated = required && Object.keys(required).length > 0;
    return isGated ? permissionMap?.[href] === true : true;
  });

  if (reachable.length < 2) {
    return [];
  }
  return reachable.map(({ href, title, badge }) => ({
    href,
    label: <NavTabLabel title={title} badge={badge} />,
  }));
}

/**
 * The two tabs carry different chips because they are at different stages:
 * Skills is newly released, Plugins is still in beta. The sidebar row is
 * named for Skills and so carries the matching "New".
 */
const NAV_TABS = [
  { title: "Skills", href: "/skills", badge: "New" },
  { title: "Plugins", href: "/plugins", badge: "Beta" },
];

function NavTabLabel({ title, badge }: { title: string; badge: string }) {
  return (
    <span className="flex items-center gap-1.5">
      {title}
      <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
        {badge}
      </Badge>
    </span>
  );
}
