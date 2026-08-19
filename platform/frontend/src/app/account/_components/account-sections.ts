import {
  KeyRound,
  MonitorSmartphone,
  ShieldCheck,
  Ticket,
  User,
} from "lucide-react";

export const accountSections = [
  { id: "profile", label: "Profile", Icon: User },
  { id: "api-keys", label: "API Keys", Icon: KeyRound },
  { id: "gateway-token", label: "Gateway Token", Icon: Ticket },
  { id: "two-factor", label: "Two-Factor", Icon: ShieldCheck },
  { id: "sessions", label: "Sessions", Icon: MonitorSmartphone },
] as const;

export type AccountSectionId = (typeof accountSections)[number]["id"];

/**
 * Picks the section to show from the URL.
 *
 * `?highlight=personal-token` is the deep link the connection instructions and
 * token-management links use to pop the gateway-token dialog. Only the visible
 * section is mounted, so that highlight has to select the gateway-token
 * section or the card that owns the dialog never renders and the link
 * silently does nothing. `?highlight=change-password` needs no such mapping —
 * its dialog lives on the page, not inside a section.
 */
export function resolveAccountSection({
  section,
  highlight,
}: {
  section: string | null;
  highlight: string | null;
}): AccountSectionId {
  const match = accountSections.find(({ id }) => id === section);
  if (match) return match.id;
  if (highlight === "personal-token") return "gateway-token";
  return "profile";
}
