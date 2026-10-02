"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { AccountPageActionSlotContext } from "@/app/account/_components/account-page-action";
import { AccountSectionNav } from "@/app/account/_components/account-section-nav";
import { ChangePasswordDialog } from "@/app/account/_components/change-password-dialog";
import { ExternalDocsLink } from "@/components/external-docs-link";
import { PageLayout } from "@/components/page-layout";
import { WithPermissions } from "@/components/roles/with-permissions";
import { Button } from "@/components/ui/button";
import { usePublicConfig } from "@/lib/config/config.query";
import { getFrontendDocsUrl } from "@/lib/docs/docs";

const PAGE_CONFIG: Record<
  string,
  { title: string; description: React.ReactNode }
> = {
  "/account": {
    title: "Profile",
    description: "Manage your profile and view your team memberships.",
  },
  "/account/permissions": {
    title: "Your permissions",
    description:
      "Permissions from your direct roles and team memberships. Focus a permission to see its source.",
  },
  "/account/api-keys": {
    title: "API Keys",
    description: <ApiKeysDescription />,
  },
  "/account/connections": {
    title: "Connections",
    description:
      "Connect a credential once to reuse it with your agents and MCP connections. Values stay private to you.",
  },
  "/account/auth": {
    title: "Auth",
    description: "Manage your gateway token and two-factor authentication.",
  },
  "/account/sessions": {
    title: "Sessions",
    description: "Manage where your account is signed in.",
  },
};

function ApiKeysDescription() {
  const apiDocsUrl = getFrontendDocsUrl("platform-api-reference");
  return (
    <>
      Keys that let scripts and integrations call the{" "}
      {apiDocsUrl ? (
        <ExternalDocsLink
          href={apiDocsUrl}
          className="text-inherit underline underline-offset-4"
          showIcon={false}
        >
          platform API
        </ExternalDocsLink>
      ) : (
        <span>platform API</span>
      )}{" "}
      as you.
      <WithPermissions
        permissions={{ serviceAccount: ["read"] }}
        noPermissionHandle="hide"
      >
        <span>
          {" "}
          For automation not tied to your user, use{" "}
          <Link
            href="/settings/service-accounts"
            className="underline underline-offset-4"
          >
            Service Accounts
          </Link>
          .
        </span>
      </WithPermissions>
    </>
  );
}

function AccountShell({ children }: { children: React.ReactNode }) {
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const highlight = searchParams.get("highlight");
  const config = PAGE_CONFIG[pathname] ?? PAGE_CONFIG["/account"];
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
      title={config.title}
      description={config.description}
      // Profile and Auth show password management in the header. API Keys
      // uses the same slot for Create API Key. The dialog stays mounted
      // here so the `?highlight=change-password` deep link still works.
      actionButton={
        pathname === "/account/api-keys" ? (
          <div ref={setPageActionSlot} />
        ) : showChangePasswordButton &&
          (pathname === "/account" || pathname === "/account/auth") ? (
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
      <Suspense fallback={null}>
        <AccountShell>{children}</AccountShell>
      </Suspense>
    </ErrorBoundary>
  );
}
