"use client";

import Link from "next/link";
import { useHasPermissions } from "@/lib/auth/auth.query";

/**
 * One line under a personal-token picker sending automation to service
 * accounts, which replaced the shared organization and team tokens. Hidden
 * from users who cannot open the service accounts page.
 */
export function ServiceAccountHint() {
  const { data: canReadServiceAccounts } = useHasPermissions({
    serviceAccount: ["read"],
  });
  if (!canReadServiceAccounts) return null;

  return (
    <p className="text-xs text-muted-foreground">
      For automation, use a{" "}
      <Link
        href="/settings/service-accounts"
        className="underline hover:text-foreground"
      >
        service account
      </Link>{" "}
      key.
    </p>
  );
}
