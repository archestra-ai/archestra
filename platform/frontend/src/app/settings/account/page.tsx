"use client";

import { SessionsCard, TwoFactorCard } from "@daveyplate/better-auth-ui";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { ChangePasswordDialog } from "@/app/settings/account/_components/change-password-dialog";
import { LightDarkToggle } from "@/app/settings/account/_components/light-dark-toggle";
import { useSetSettingsAction } from "@/app/settings/layout";
import { LoadingSpinner } from "@/components/loading";
import { PersonalTokenCard } from "@/components/settings/personal-token-card";
import { RolePermissionsCard } from "@/components/settings/role-permissions-card";
import { SettingsSectionStack } from "@/components/settings/settings-block";
import { Button } from "@/components/ui/button";
import { usePublicConfig } from "@/lib/config/config.query";
import { useOrganization } from "@/lib/organization.query";

function AccountSettingsContent() {
  const searchParams = useSearchParams();
  const highlight = searchParams.get("highlight");
  const setSettingsAction = useSetSettingsAction();
  const [isChangePasswordOpen, setIsChangePasswordOpen] = useState(false);
  const { data: organization } = useOrganization();
  const { data: publicConfig, isLoading: isLoadingPublicConfig } =
    usePublicConfig();
  const isBasicAuthDisabled = publicConfig?.disableBasicAuth ?? false;
  const showChangePasswordButton =
    !isLoadingPublicConfig && !isBasicAuthDisabled;

  const changePasswordAction = useMemo(() => {
    if (!showChangePasswordButton) return null;
    return (
      <Button type="button" onClick={() => setIsChangePasswordOpen(true)}>
        Change Password
      </Button>
    );
  }, [showChangePasswordButton]);

  useEffect(() => {
    setSettingsAction(changePasswordAction);
    return () => setSettingsAction(null);
  }, [changePasswordAction, setSettingsAction]);

  useEffect(() => {
    if (highlight === "change-password" && showChangePasswordButton) {
      setIsChangePasswordOpen(true);
    }
  }, [highlight, showChangePasswordButton]);

  return (
    <>
      <SettingsSectionStack>
        <RolePermissionsCard />
        <PersonalTokenCard />
        {organization?.showTwoFactor && (
          <TwoFactorCard classNames={{ base: "w-full" }} />
        )}
        <LightDarkToggle />
        <SessionsCard classNames={{ base: "w-full" }} />
      </SettingsSectionStack>
      {showChangePasswordButton && (
        <ChangePasswordDialog
          open={isChangePasswordOpen}
          onOpenChange={setIsChangePasswordOpen}
        />
      )}
    </>
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
