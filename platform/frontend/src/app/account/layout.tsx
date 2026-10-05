"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Suspense, useState } from "react";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { AccountPageActionSlotContext } from "@/app/account/_components/account-page-action";
import { accountSections } from "@/app/account/_components/account-sections";
import { ExternalDocsLink } from "@/components/external-docs-link";
import { PageLayout } from "@/components/page-layout";
import { WithPermissions } from "@/components/roles/with-permissions";
import { getFrontendDocsUrl } from "@/lib/docs/docs";

// The title stays put across tabs — the tab bar says which one is open — and
// the description says what the open tab is for.
const PAGE_DESCRIPTIONS: Record<string, React.ReactNode> = {
  "/account": "Settings that apply only to you, not your organization.",
  "/account/api-keys": <ApiKeysDescription />,
  "/account/sessions":
    "The browsers and devices you're signed in on. Sign out of any you don't recognize.",
};

function ApiKeysDescription() {
  const apiDocsUrl = getFrontendDocsUrl("platform-api-reference");
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
  const [pageActionSlot, setPageActionSlot] = useState<HTMLDivElement | null>(
    null,
  );

  return (
    <PageLayout
      title="Personal Settings"
      description={PAGE_DESCRIPTIONS[pathname] ?? PAGE_DESCRIPTIONS["/account"]}
      tabs={accountSections}
      // API Keys puts Create API Key in the header through this slot.
      actionButton={
        pathname === "/account/api-keys" ? (
          <div ref={setPageActionSlot} />
        ) : null
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
