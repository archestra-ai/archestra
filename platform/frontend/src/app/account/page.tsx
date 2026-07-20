"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { ChangePasswordDialog } from "@/app/account/_components/change-password-dialog";
import { SessionsCard } from "@/app/account/_components/sessions-card";
import { TwoFactorCard } from "@/app/account/_components/two-factor-card";
import { LoadingSpinner } from "@/components/loading";
import { PageLayout } from "@/components/page-layout";
import { ApiKeysCard } from "@/components/settings/api-keys-card";
import { PersonalTokenCard } from "@/components/settings/personal-token-card";
import { RolePermissionsCard } from "@/components/settings/role-permissions-card";
import { SettingsSectionStack } from "@/components/settings/settings-block";
import { Button } from "@/components/ui/button";
import { usePublicConfig } from "@/lib/config/config.query";
import { useOrganization } from "@/lib/organization.query";

function AccountContent() {
  const searchParams = useSearchParams();
  const highlight = searchParams.get("highlight");
  const [isChangePasswordOpen, setIsChangePasswordOpen] = useState(false);
  const { data: organization } = useOrganization();
  const { data: publicConfig, isLoading: isLoadingPublicConfig } =
    usePublicConfig();
  const isBasicAuthDisabled = publicConfig?.disableBasicAuth ?? false;
  const showChangePasswordButton =
    !isLoadingPublicConfig && !isBasicAuthDisabled;

  useEffect(() => {
    if (highlight === "change-password" && showChangePasswordButton) {
      setIsChangePasswordOpen(true);
    }
  }, [highlight, showChangePasswordButton]);

  return (
    <PageLayout
      title="Your Account"
      description="Manage your personal profile, API keys, sessions, and sign-in settings."
      actionButton={
        showChangePasswordButton ? (
          <Button type="button" onClick={() => setIsChangePasswordOpen(true)}>
            Change Password
          </Button>
        ) : null
      }
    >
      <SettingsSectionStack>
        <RolePermissionsCard />
        <ApiKeysCard />
        <PersonalTokenCard />
        {organization?.showTwoFactor && <TwoFactorCard />}
        <SessionsCard />
      </SettingsSectionStack>
      {showChangePasswordButton && (
        <ChangePasswordDialog
          open={isChangePasswordOpen}
          onOpenChange={setIsChangePasswordOpen}
        />
      )}
    </PageLayout>
  );
}

export default function AccountPage() {
  return (
    <ErrorBoundary>
      <Suspense fallback={<LoadingSpinner />}>
        <AccountContent />
      </Suspense>
    </ErrorBoundary>
  );
}
