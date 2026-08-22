"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { AccountSectionNav } from "@/app/account/_components/account-section-nav";
import { ChangePasswordDialog } from "@/app/account/_components/change-password-dialog";
import { LoadingSpinner } from "@/components/loading";
import { PageLayout } from "@/components/page-layout";
import { Button } from "@/components/ui/button";
import { usePublicConfig } from "@/lib/config/config.query";

function AccountShell({ children }: { children: React.ReactNode }) {
  const searchParams = useSearchParams();
  const highlight = searchParams.get("highlight");
  const [isChangePasswordOpen, setIsChangePasswordOpen] = useState(false);
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
      // Page-level, not tucked inside a section: changing a password is the
      // thing people arrive here to do, and it should stay one click away
      // from whichever section they happen to be on. It lives in the layout so
      // the `?highlight=change-password` deep link works on every one of them.
      actionButton={
        showChangePasswordButton ? (
          <Button type="button" onClick={() => setIsChangePasswordOpen(true)}>
            Change Password
          </Button>
        ) : null
      }
    >
      <div className="grid items-start gap-6 lg:grid-cols-[220px_minmax(0,1fr)]">
        <AccountSectionNav />
        <div className="min-w-0">{children}</div>
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

export default function AccountLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <ErrorBoundary>
      <Suspense fallback={<LoadingSpinner />}>
        <AccountShell>{children}</AccountShell>
      </Suspense>
    </ErrorBoundary>
  );
}
