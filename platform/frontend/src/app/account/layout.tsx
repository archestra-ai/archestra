"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { AccountPageActionSlotContext } from "@/app/account/_components/account-page-action";
import { AccountSectionNav } from "@/app/account/_components/account-section-nav";
import { ChangePasswordDialog } from "@/app/account/_components/change-password-dialog";
import { LoadingState } from "@/components/loading";
import { PageLayout } from "@/components/page-layout";
import { Button } from "@/components/ui/button";
import { usePublicConfig } from "@/lib/config/config.query";

function AccountShell({ children }: { children: React.ReactNode }) {
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const highlight = searchParams.get("highlight");
  const [isChangePasswordOpen, setIsChangePasswordOpen] = useState(false);
  const [pageActionSlot, setPageActionSlot] = useState<HTMLDivElement | null>(
    null,
  );
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
      // Most account sections keep password management one click away. A page
      // with a primary action of its own can replace it in the same header
      // slot; API Keys uses that for Create API Key. The dialog stays mounted
      // here so the `?highlight=change-password` deep link still works.
      actionButton={
        pathname === "/account/api-keys" ? (
          <div ref={setPageActionSlot} />
        ) : showChangePasswordButton ? (
          <Button type="button" onClick={() => setIsChangePasswordOpen(true)}>
            Change Password
          </Button>
        ) : null
      }
    >
      <AccountPageActionSlotContext.Provider value={pageActionSlot}>
        <div className="grid items-start gap-6 lg:grid-cols-[220px_minmax(0,1fr)]">
          <AccountSectionNav />
          <div className="min-w-0">{children}</div>
        </div>
      </AccountPageActionSlotContext.Provider>
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
      <Suspense fallback={<LoadingState variant="page" />}>
        <AccountShell>{children}</AccountShell>
      </Suspense>
    </ErrorBoundary>
  );
}
