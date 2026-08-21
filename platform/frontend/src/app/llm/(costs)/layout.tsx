"use client";

import { requiredPagePermissionsMap } from "@archestra/shared/access-control";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { createContext, useContext, useMemo, useState } from "react";
import { ExternalDocsLink } from "@/components/external-docs-link";
import { PageLayout } from "@/components/page-layout";
import { useHasPermissions, usePermissionMap } from "@/lib/auth/auth.query";
import { getFrontendDocsUrl } from "@/lib/docs/docs";

const TABS = [
  { label: "Costs", href: "/llm/costs" },
  { label: "Limits", href: "/llm/limits" },
];

const PAGE_CONFIG: Record<
  string,
  { title: React.ReactNode; description: React.ReactNode }
> = {
  "/llm/costs": {
    title: "Costs",
    description: (
      <>
        Monitor usage costs and savings across teams, agents, and models. View
        and edit model token prices in{" "}
        <Link href="/llm/models" className="text-primary hover:underline">
          Model Settings
        </Link>
        .
      </>
    ),
  },
  "/llm/limits": {
    title: "Limits",
    description:
      "Control LLM spend with token-cost limits scoped to the organization, teams, agents, users, virtual keys, or environments.",
  },
};

/**
 * What the Costs page is for a reader without `llmCost:read`: their own usage,
 * and none of the organization-wide charts the default description describes.
 */
const PERSONAL_COSTS_PAGE_CONFIG = {
  title: "Costs",
  description:
    "Your own LLM usage and spend. Organization-wide cost reporting needs additional permissions.",
};

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
  const permissionMap = usePermissionMap(requiredPagePermissionsMap);
  const prometheusDocsUrl = getFrontendDocsUrl(
    "platform-deployment",
    "prometheus-metrics",
  );

  // The Costs tab is reachable by everyone (it leads with the reader's own
  // usage), so its siblings can no longer be assumed reachable too — someone
  // arriving here without `llmLimit:read` would otherwise be offered a tab that
  // only ever renders a forbidden page. Tabs with no entry in the map are
  // ungated; the rest wait for the permission answer rather than flashing.
  const tabs = TABS.filter(({ href }) => {
    const required = requiredPagePermissionsMap[href];
    const isGated = required && Object.keys(required).length > 0;
    return isGated ? permissionMap?.[href] === true : true;
  });

  // The Costs page shows organization-wide charts only to those who may read
  // them; for everyone else it is their own usage summary and nothing more, so
  // the description says that rather than promising figures they won't see.
  const { data: canReadOrganizationCosts = false } = useHasPermissions({
    llmCost: ["read"],
  });

  const config =
    pathname === "/llm/costs" && !canReadOrganizationCosts
      ? PERSONAL_COSTS_PAGE_CONFIG
      : (PAGE_CONFIG[pathname] ?? {
          title: "Costs & Limits",
          description: "Monitor and manage AI model usage costs.",
        });

  const contextValue = useMemo(() => ({ setActionButton }), []);

  return (
    <CostsLayoutContext.Provider value={contextValue}>
      <PageLayout
        title={config.title}
        description={
          pathname === "/llm/costs" &&
          canReadOrganizationCosts &&
          prometheusDocsUrl ? (
            <>
              {config.description} Check{" "}
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
            config.description
          )
        }
        tabs={tabs}
        actionButton={actionButton}
      >
        {children}
      </PageLayout>
    </CostsLayoutContext.Provider>
  );
}
