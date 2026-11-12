"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Suspense, useState } from "react";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { AccountPageActionSlotContext } from "@/app/account/_parts/account-page-action";
import { accountSections } from "@/app/account/_parts/account-sections";
import { useAccountCredentialsAccess } from "@/app/account/_parts/use-account-credentials-access";
import { AlphaBadge } from "@/components/alpha-badge";
import { ExternalDocsLink } from "@/components/external-docs-link";
import { PageLayout } from "@/components/page-layout";
import { WithPermissions } from "@/components/roles/with-permissions";
import { useFeature } from "@/lib/config/config.query";
import { getFrontendDocsUrl } from "@/lib/docs/docs";
import { DEVICES_HREF } from "@/lib/mcp/desktop-mcp";

// The title stays put across tabs — the tab bar says which one is open — and
// the description says what the open tab is for.
const PAGE_DESCRIPTIONS: Record<string, React.ReactNode> = {
  "/account": "Settings that apply only to you, not your organization.",
  "/account/credentials":
    "Credentials your agents use on your behalf. Values stay private to you.",
  "/account/api-keys": <ApiKeysDescription />,
  "/account/sessions":
    "The browsers and devices you're signed in on. Sign out of any you don't recognize.",
  "/account/devices":
    "The device where the MCP bridge runs MCP servers for your agents.",
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
  const [pageActionSlot, setPageActionSlot] = useState<HTMLDivElement | null>(
    null,
  );
  // No Credentials tab for a reader who uses Settings → Credentials, or who
  // has nothing to show here (no credential:read, no Claude Code agent); its
  // page forwards them.
  const { hasTab: hasCredentialsTab } = useAccountCredentialsAccess();
  // The Device tab is desktop MCP, in alpha: only with the beta flag, and
  // only once the flag is known, so it does not flash and vanish.
  const desktopMcpEnabled = useFeature("betaEnabled") === true;
  const tabs = accountSections
    .filter(
      (section) =>
        (section.href !== "/account/credentials" ||
          hasCredentialsTab !== false) &&
        (section.href !== DEVICES_HREF || desktopMcpEnabled),
    )
    .map((section) =>
      section.href === DEVICES_HREF
        ? {
            ...section,
            label: (
              <span className="inline-flex items-center gap-1.5">
                <span>{section.label}</span>
                <AlphaBadge />
              </span>
            ),
          }
        : section,
    );

  return (
    <PageLayout
      title="Personal Settings"
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
