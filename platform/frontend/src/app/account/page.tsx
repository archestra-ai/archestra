"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { AccountSectionNav } from "@/app/account/_components/account-section-nav";
import { resolveAccountSection } from "@/app/account/_components/account-sections";
import { ChangePasswordDialog } from "@/app/account/_components/change-password-dialog";
import { SessionsCard } from "@/app/account/_components/sessions-card";
import { TwoFactorCard } from "@/app/account/_components/two-factor-card";
import { LoadingSpinner } from "@/components/loading";
import { PageLayout } from "@/components/page-layout";
import { ApiKeysCard } from "@/components/settings/api-keys-card";
import { PersonalTokenCard } from "@/components/settings/personal-token-card";
import { RolePermissionsCard } from "@/components/settings/role-permissions-card";
import { Button } from "@/components/ui/button";
import { usePublicConfig } from "@/lib/config/config.query";
import { useOrganization } from "@/lib/organization.query";

function AccountContent() {
  const searchParams = useSearchParams();
  const highlight = searchParams.get("highlight");
  const activeSection = resolveAccountSection({
    section: searchParams.get("section"),
    highlight,
  });
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
      title="Personal Settings"
      description="Manage your personal profile, API keys, sessions, and sign-in settings."
      actionButton={
        showChangePasswordButton ? (
          <Button type="button" onClick={() => setIsChangePasswordOpen(true)}>
            Change Password
          </Button>
        ) : null
      }
    >
      <div className="grid items-start gap-6 lg:grid-cols-[220px_minmax(0,1fr)]">
        <AccountSectionNav activeSection={activeSection} />
        {/* Only the selected section mounts, so each card fetches its own data
            lazily rather than all five firing on every visit. */}
        <div className="min-w-0">
          {activeSection === "profile" && <RolePermissionsCard />}
          {activeSection === "api-keys" && <ApiKeysCard />}
          {activeSection === "gateway-token" && <PersonalTokenCard />}
          {activeSection === "two-factor" && (
            <TwoFactorCard required={organization?.requireTwoFactor ?? false} />
          )}
          {activeSection === "sessions" && <SessionsCard />}
        </div>
      </div>
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
