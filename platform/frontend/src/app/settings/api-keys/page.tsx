"use client";

import { ClientRedirect } from "@/components/client-redirect";

// API key management moved onto the account page.
export default function ApiKeysSettingsPage() {
  return <ClientRedirect to="/account?section=api-keys" />;
}
