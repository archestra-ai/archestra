"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { AccountPageActionSlotContext } from "@/app/account/_parts/account-page-action";
import { accountSections } from "@/app/account/_parts/account-sections";
import { useAccountCredentialsAccess } from "@/app/account/_parts/use-account-credentials-access";
import { BetaBadge } from "@/components/beta-badge";
import { ExternalDocsLink } from "@/components/external-docs-link";
import { PageLayout } from "@/components/page-layout";
import { QueryLoadError } from "@/components/query-load-error";
import { WithPermissions } from "@/components/roles/with-permissions";
import { getFrontendDocsUrl } from "@/lib/docs/docs";
import { useOrganization } from "@/lib/organization.query";

const PAGE_TITLES: Record<string, string> = {
  "/account": "Personal Settings",
  "/account/credentials": "Credentials",
  "/account/api-keys": "API Keys",
  "/account/devices": "Devices",
  "/account/sessions": "Sessions",
};

const PAGE_DESCRIPTIONS: Record<string, React.ReactNode> = {
  "/account": "Settings that apply only to you, not your organization.",
  "/account/credentials":
    "Credentials your agents use on your behalf. Values stay private to you.",
  "/account/api-keys": <ApiKeysDescription />,
  "/account/sessions":
    "The browsers and devices you're signed in on. Sign out of any you don't recognize.",
  "/account/devices":
    "Local devices connected to your account. Only you can see, rename or remove them.",
};

const PAGES_WITH_ACTION = new Set([
  "/account/api-keys",
  "/account/credentials",
]);

function ApiKeysDescription() {
  const apiDocsUrl = getFrontendDocsUrl("reference/api");
  return (
    <>
      Personal keys that let your scripts and integrations call the{" "}
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
  const pathname = usePathname();
  const router = useRouter();
  const organization = useOrganization();
  const devicesEnabled = organization.data?.deviceMcpEnabled === true;
  const isDevicesPage = pathname === "/account/devices";
  useEffect(() => {
    if (isDevicesPage && organization.data?.deviceMcpEnabled === false) {
      router.replace("/account");
    }
  }, [isDevicesPage, organization.data?.deviceMcpEnabled, router]);
  const [pageActionSlot, setPageActionSlot] = useState<HTMLDivElement | null>(
    null,
  );
  // No Credentials tab for a reader who uses Settings → Credentials, or who
  // has nothing to show here (no credential:read, no Claude Code agent); its
  // page forwards them.
  const { hasTab: hasCredentialsTab } = useAccountCredentialsAccess();
  const tabs = accountSections
    .filter(
      (section) =>
        (section.href !== "/account/credentials" ||
          hasCredentialsTab !== false) &&
        (section.href !== "/account/devices" || devicesEnabled),
    )
    .map((section) => ({
      ...section,
      label: section.beta ? (
        <span className="inline-flex items-center gap-1.5">
          {section.label} <BetaBadge />
        </span>
      ) : (
        section.label
      ),
    }));

  // Do not mount device queries or briefly expose the disabled feature on a deep link.
  if (isDevicesPage && !devicesEnabled) {
    if (organization.isError) {
      return (
        <QueryLoadError
          title="Couldn't load device settings"
          onRetry={() => void organization.refetch()}
        />
      );
    }
    return null;
  }

  return (
    <PageLayout
      title={PAGE_TITLES[pathname] ?? PAGE_TITLES["/account"]}
      description={PAGE_DESCRIPTIONS[pathname] ?? PAGE_DESCRIPTIONS["/account"]}
      tabs={tabs}
      // API Keys puts Create API Key, and Credentials Add credential, in the
      // header through this slot.
      actionButton={
        PAGES_WITH_ACTION.has(pathname) ? <div ref={setPageActionSlot} /> : null
      }
    >
      <AccountPageActionSlotContext.Provider value={pageActionSlot}>
        {children}
      </AccountPageActionSlotContext.Provider>
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
