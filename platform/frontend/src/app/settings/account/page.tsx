"use client";

import { UpdateNameCard } from "@daveyplate/better-auth-ui";
import { Suspense } from "react";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { LightDarkToggle } from "@/app/settings/account/_components/light-dark-toggle";
import { LoadingSpinner } from "@/components/loading";
import { RolePermissionsCard } from "@/components/settings/role-permissions-card";
import { useOrgTheme } from "@/lib/theme.hook";

function AccountSettingsContent() {
  const orgTheme = useOrgTheme();
  const currentUITheme = orgTheme?.currentUITheme;

  return (
    <div className="space-y-6">
      <RolePermissionsCard />
      <UpdateNameCard classNames={{ base: "w-full" }} />
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
