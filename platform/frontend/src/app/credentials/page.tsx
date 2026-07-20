"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { useHasPermissions } from "@/lib/auth/auth.query";

/**
 * Bare /credentials lands on Virtual Keys (the more common credential), but
 * the two tabs are gated by different permissions, so a viewer who can't read
 * virtual keys is sent to OAuth Clients instead. A viewer with neither
 * permission still ends at that tab's forbidden page.
 */
export default function CredentialsIndexPage() {
  const router = useRouter();
  const { data: canReadVirtualKeys, isPending } = useHasPermissions({
    llmVirtualKey: ["read"],
  });

  useEffect(() => {
    if (isPending) return;
    router.replace(
      canReadVirtualKeys
        ? "/credentials/virtual-keys"
        : "/credentials/oauth-clients",
    );
  }, [isPending, canReadVirtualKeys, router]);

  return null;
}
