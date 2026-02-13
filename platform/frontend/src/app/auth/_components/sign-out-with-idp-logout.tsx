"use client";

import { archestraApiSdk } from "@shared";
import { Loader2 } from "lucide-react";
import { useEffect, useRef } from "react";

export function SignOutWithIdpLogout() {
  const hasStarted = useRef(false);

  useEffect(() => {
    if (hasStarted.current) return;
    hasStarted.current = true;

    performSignOut();
  }, []);

  return (
    <div className="flex flex-col items-center justify-center gap-4 p-8">
      <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      <p className="text-sm text-muted-foreground">Signing out...</p>
    </div>
  );
}

async function performSignOut() {
  // Fetch IdP logout URL while still authenticated
  let idpLogoutUrl: string | null = null;
  try {
    const { data } = await archestraApiSdk.getIdentityProviderIdpLogoutUrl();
    idpLogoutUrl = data?.url ?? null;
  } catch {
    // Proceed with local sign-out even if IdP URL fetch fails
  }

  // Clear local session using direct fetch to avoid React state updates
  // from authClient.signOut() which can trigger navigation before our redirect
  try {
    await fetch("/api/auth/sign-out", {
      method: "POST",
      credentials: "include",
    });
  } catch {
    // Proceed with redirect even if session cleanup fails
  }

  // Redirect to IdP logout or sign-in page
  if (idpLogoutUrl) {
    window.location.href = idpLogoutUrl;
  } else {
    window.location.href = "/auth/sign-in";
  }
}
