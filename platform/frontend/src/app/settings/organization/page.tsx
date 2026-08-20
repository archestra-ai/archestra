"use client";

import { ClientRedirect } from "@/components/client-redirect";

// The old combined Organization page split into Appearance and Auth; keep old
// links working by forwarding to the appearance half.
export default function OrganizationSettingsPage() {
  return <ClientRedirect to="/settings/appearance" />;
}
