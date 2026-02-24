"use client";

import { DEFAULT_ADMIN_EMAIL } from "@shared";
import { AlertTriangle } from "lucide-react";
import Link from "next/link";
import { DefaultCredentialsWarning } from "@/components/default-credentials-warning";
import { useDefaultCredentialsEnabled } from "@/lib/auth.query";
import { authClient } from "@/lib/clients/auth/auth-client";
import { useFeatures } from "@/lib/config.query";

export function SidebarWarnings() {
  const { data: session } = authClient.useSession();
  const userEmail = session?.user?.email;
  const { data: defaultCredentialsEnabled, isLoading: isLoadingCreds } =
    useDefaultCredentialsEnabled();
  const { data: features, isLoading: isLoadingFeatures } = useFeatures();

  const isPermissive = features?.globalToolPolicy === "permissive";

  // Determine which warnings should be shown (only for authenticated users)
  const showSecurityEngineWarning =
    !!session && !isLoadingFeatures && features !== undefined && isPermissive;
  const showDefaultCredsWarning =
    !isLoadingCreds &&
    defaultCredentialsEnabled !== undefined &&
    defaultCredentialsEnabled &&
    userEmail === DEFAULT_ADMIN_EMAIL;

  // Don't render anything if no warnings
  if (!showSecurityEngineWarning && !showDefaultCredsWarning) {
    return null;
  }

  return (
    <div className="px-2 pb-1 space-y-1">
      {showSecurityEngineWarning && (
        <div className="rounded-lg border bg-card px-3 py-1.5 text-xs text-destructive">
          <p className="flex items-center gap-1.5 whitespace-nowrap">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            <span>
              Security engine off
              {" - "}
              <Link href="/tool-policies" className="underline font-medium">
                Fix
              </Link>
            </span>
          </p>
        </div>
      )}
      {showDefaultCredsWarning && <DefaultCredentialsWarning alwaysShow slim />}
    </div>
  );
}
