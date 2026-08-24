/**
 * Where the sidebar's Skills & Plugins row points, and what it is called.
 * Skills is the section's landing page, so the row falls back to Plugins only
 * for a reader who may open that page and not the other. The name follows the
 * same rule: it never advertises a page this reader (or this deployment)
 * cannot reach.
 */
export function getSkillsNavigation({
  permissionMap,
  pluginsEnabled,
}: {
  permissionMap: Partial<Record<string, boolean>> | null | undefined;
  pluginsEnabled: boolean | undefined;
}): { url: "/skills" | "/plugins"; title: string } {
  const canReadPlugins =
    pluginsEnabled === true && permissionMap?.["/plugins"] === true;
  // Permissions still loading reads as Skills, the landing page, rather than
  // renaming the row a moment later.
  if (permissionMap?.["/skills"] === false) {
    return canReadPlugins
      ? { url: "/plugins", title: "Plugins" }
      : { url: "/skills", title: "Skills" };
  }
  return {
    url: "/skills",
    title: canReadPlugins ? "Skills & Plugins" : "Skills",
  };
}
