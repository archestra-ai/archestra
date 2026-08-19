import {
  KeyRound,
  ListChecks,
  MonitorSmartphone,
  ShieldCheck,
  Ticket,
  User,
} from "lucide-react";

export const accountSections = [
  { id: "profile", label: "Profile", Icon: User },
  { id: "permissions", label: "Permissions", Icon: ListChecks },
  { id: "api-keys", label: "API Keys", Icon: KeyRound },
  { id: "gateway-token", label: "Gateway Token", Icon: Ticket },
  { id: "security", label: "Security", Icon: ShieldCheck },
  { id: "sessions", label: "Sessions", Icon: MonitorSmartphone },
] as const;

export type AccountSectionId = (typeof accountSections)[number]["id"];

/**
 * Picks the section to show from the URL.
 *
 * Both `?highlight=` deep links have to name a section. Only the visible
 * section mounts, so `personal-token` — used by the connection instructions
 * and the token-management links — must select the gateway-token section, or
 * the card owning that dialog never renders and the link silently does
 * nothing. `change-password`, used by the default-credentials warnings, must
 * select security for the same reason: its dialog opens over that section,
 * and closing it should leave the reader on the control that reopens it.
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
  if (highlight === "change-password") return "security";
  return "profile";
}
