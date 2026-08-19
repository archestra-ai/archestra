"use client";

import { ClientRedirect } from "@/components/client-redirect";

// The account page moved out of settings to /account.
export default function AccountSettingsPage() {
  return <ClientRedirect to="/account" />;
}
