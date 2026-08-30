import {
  KeyRound,
  ListChecks,
  MonitorSmartphone,
  PlugZap,
  ShieldCheck,
  Ticket,
  User,
} from "lucide-react";

/**
 * Each section is its own route, so a section is deep-linkable, survives
 * back/forward, and only mounts the card it owns.
 *
 * Profile is the index rather than `/account/profile`: it is what `/account`
 * has always shown, and every link to the bare path should keep landing on it.
 */
export const accountSections = [
  { id: "profile", label: "Profile", href: "/account", Icon: User },
  {
    id: "permissions",
    label: "Permissions",
    href: "/account/permissions",
    Icon: ListChecks,
  },
  {
    id: "api-keys",
    label: "API Keys",
    href: "/account/api-keys",
    Icon: KeyRound,
  },
  {
    id: "connections",
    label: "Connections",
    href: "/account/connections",
    Icon: PlugZap,
    feature: "agentBackgroundExecution" as const,
  },
  {
    id: "gateway-token",
    label: "Gateway Token",
    href: "/account/gateway-token",
    Icon: Ticket,
  },
  {
    id: "two-factor",
    label: "Two-Factor",
    href: "/account/two-factor",
    Icon: ShieldCheck,
  },
  {
    id: "sessions",
    label: "Sessions",
    href: "/account/sessions",
    Icon: MonitorSmartphone,
  },
] as const;

export type AccountSectionId = (typeof accountSections)[number]["id"];

/**
 * Where an old `/account?section=…` link should land.
 *
 * These URLs are bookmarked and printed in docs, so `/account` still honours
 * the query param by redirecting to the route that replaced it.
 * `?highlight=personal-token` is the deep link the connection instructions and
 * token-management links use to pop the gateway-token dialog; it has to select
 * the gateway-token route or the card that owns the dialog never mounts and
 * the link silently does nothing.
 *
 * `?highlight=change-password` needs no mapping — both its button and its
 * dialog sit in the layout, above the sections, so it works from any of them.
 */
export function resolveLegacyAccountHref({
  section,
  highlight,
}: {
  section: string | null;
  highlight: string | null;
}): string | null {
  const match = accountSections.find(({ id }) => id === section);
  if (match) return match.href;
  if (highlight === "personal-token") return "/account/gateway-token";
  return null;
}
