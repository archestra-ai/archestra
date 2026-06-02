const SERVICE_LOGO_ICON_SOURCES: Record<string, string> = {
  playwright: "/icons/simple-icons-microsoft/playwright.svg",
};

export function getServiceLogoIconSrc(icon?: string | null): string | null {
  if (!icon?.startsWith("logo:")) return null;

  const slug = icon.slice("logo:".length);
  return SERVICE_LOGO_ICON_SOURCES[slug] ?? null;
}
