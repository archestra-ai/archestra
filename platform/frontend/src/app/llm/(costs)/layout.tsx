"use client";

import { DocsPage, getDocsUrl } from "@archestra/shared";
import { requiredPagePermissionsMap } from "@archestra/shared/access-control";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { createContext, useContext, useMemo, useState } from "react";
import { ExternalDocsLink } from "@/components/external-docs-link";
import { PageLayout } from "@/components/page-layout";
import { usePermissionMap } from "@/lib/auth/auth.query";
import { getFrontendDocsUrl } from "@/lib/docs/docs";
import { useTeamLimitAccess } from "@/lib/limits-access";

const TABS = [
  { label: "Costs", href: "/llm/costs" },
  { label: "Limits", href: "/llm/limits" },
  { label: "Exports", href: "/llm/cost-exports" },
];

const PAGE_CONFIG: Record<
  string,
  { title: React.ReactNode; description: React.ReactNode }
> = {
  "/llm/costs": {
    title: "Costs",
    description: (
      <>
        Track spend, token usage and requests across your organization.{" "}
        <ModelSettingsNote />
      </>
    ),
  },
  "/llm/limits": {
    title: "Limits",
    description: "Set spend and rate limits for LLM traffic.",
  },
  "/llm/cost-exports": {
    title: "Exports",
    description: <CostExportsDescription />,
  },
};

/**
 * The Costs description for a team admin without organization cost access.
 * Team admins may not be able to open Model Settings, so the link is shown
 * only to those who can.
 */
function TeamCostsDescription({ canReadModels }: { canReadModels: boolean }) {
  return (
    <>
      Track spend, token usage and requests across the teams you administer.
      {canReadModels && (
        <>
          {" "}
          <ModelSettingsNote />
        </>
      )}
    </>
  );
}

function CostExportsDescription() {
  return (
    <>
      Send cost and usage to your own object storage on a schedule, in the
      FinOps FOCUS format. Exports write to a{" "}
      <Link
        href="/settings/blob-providers"
        className="text-primary hover:underline"
      >
        blob provider
      </Link>
      .{" "}
      <ExternalDocsLink
        href={getDocsUrl(
          DocsPage.PlatformCostExports,
          "schedule-exports-to-object-storage",
        )}
        className="hover:underline"
      >
        Learn more
      </ExternalDocsLink>
    </>
  );
}

function ModelSettingsNote() {
  return (
    <>
      View and edit model token prices in{" "}
      <Link href="/llm/models" className="text-primary hover:underline">
        Model Settings
      </Link>
      .
    </>
  );
}

type CostsLayoutContextType = {
  setActionButton: (button: React.ReactNode) => void;
};

const CostsLayoutContext = createContext<CostsLayoutContextType>({
  setActionButton: () => {},
});

export function useSetCostsAction() {
  return useContext(CostsLayoutContext).setActionButton;
}

export default function CostsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const [actionButton, setActionButton] = useState<React.ReactNode>(null);
  const pageMap = usePermissionMap(requiredPagePermissionsMap);
  const limitsAccess = useTeamLimitAccess();
  const permissionMap: Record<string, boolean> | null = pageMap
    ? {
        ...pageMap,
        "/llm/costs": pageMap["/llm/costs"] || limitsAccess.isTeamAdmin,
        "/llm/limits": pageMap["/llm/limits"] || limitsAccess.canRead,
      }
    : null;
  const prometheusDocsUrl = getFrontendDocsUrl("admin/observability/metrics");

  // Wait for the permission answer rather than flashing tabs that would only
  // render a forbidden page.
  const tabs = TABS.filter(({ href }) => {
    const required = requiredPagePermissionsMap[href];
    const isGated = required && Object.keys(required).length > 0;
    return isGated ? permissionMap?.[href] === true : true;
  });

  const teamScopedCosts =
    pathname === "/llm/costs" &&
    pageMap?.["/llm/costs"] === false &&
    limitsAccess.isTeamAdmin;
  const config = PAGE_CONFIG[pathname] ?? {
    title: "Costs & Limits",
    description: "Monitor and manage AI model usage costs.",
  };
  const description = teamScopedCosts ? (
    <TeamCostsDescription canReadModels={pageMap?.["/llm/models"] === true} />
  ) : (
    config.description
  );

  const contextValue = useMemo(() => ({ setActionButton }), []);

  return (
    <CostsLayoutContext.Provider value={contextValue}>
      <PageLayout
        minWidth="phone"
        title={config.title}
        description={
          pathname === "/llm/costs" && prometheusDocsUrl ? (
            <>
              {description} Check{" "}
              <ExternalDocsLink
                href={prometheusDocsUrl}
                className="hover:underline"
                showIcon={false}
              >
                Prometheus metrics capabilities
              </ExternalDocsLink>{" "}
              to get cost-related insights at scale.
            </>
          ) : (
            description
          )
        }
        tabs={tabs.length > 1 ? tabs : []}
        actionButton={actionButton}
      >
        {children}
      </PageLayout>
    </CostsLayoutContext.Provider>
  );
}
