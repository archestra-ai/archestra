"use client";

import {
  ChangePasswordCard,
  SessionsCard,
  TwoFactorCard,
  UpdateNameCard,
} from "@daveyplate/better-auth-ui";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { LightDarkToggle } from "@/app/settings/account/_components/light-dark-toggle";
import { LoadingSpinner } from "@/components/loading";
import { PersonalTokenCard } from "@/components/settings/personal-token-card";
import { RolePermissionsCard } from "@/components/settings/role-permissions-card";
import config from "@/lib/config";
import { useOrganization } from "@/lib/organization.query";
import { useOrgTheme } from "@/lib/theme.hook";
import { cn } from "@/lib/utils";

function AccountSettingsContent() {
  const searchParams = useSearchParams();
  const highlight = searchParams.get("highlight");
  const changePasswordRef = useRef<HTMLDivElement>(null);
  const [isPulsing, setIsPulsing] = useState(false);
  const orgTheme = useOrgTheme();
  const currentUITheme = orgTheme?.currentUITheme;
  const { data: organization } = useOrganization();

  useEffect(() => {
    if (highlight === "change-password" && changePasswordRef.current) {
      changePasswordRef.current.scrollIntoView({
        behavior: "smooth",
        block: "center",
      });
      setIsPulsing(true);
      const timer = setTimeout(() => setIsPulsing(false), 3000);
      return () => clearTimeout(timer);
    }
  }, [highlight]);

  return (
    <div className="space-y-6">
      <RolePermissionsCard />
      <UpdateNameCard classNames={{ base: "w-full" }} />
      <PersonalTokenCard />
      {!config.disableBasicAuth && (
        <div
          ref={changePasswordRef}
          className={cn(
            "rounded-lg transition-shadow duration-500",
            isPulsing &&
              "ring-2 ring-destructive/50 animate-pulse shadow-lg shadow-destructive/10",
          )}
        >
          <ChangePasswordCard classNames={{ base: "w-full" }} />
        </div>
      )}
      {organization?.showTwoFactor && (
        <TwoFactorCard classNames={{ base: "w-full" }} />
      )}
      <SessionsCard classNames={{ base: "w-full" }} />
      <LightDarkToggle currentThemeId={currentUITheme} />
    </div>
  );
}

export default function AccountSettingsPage() {
  return (
    <ErrorBoundary>
      <Suspense fallback={<LoadingSpinner />}>
        <AccountSettingsContent />
      </Suspense>
    </ErrorBoundary>
  );
}
