"use client";

import { DocsPage, getDocsUrl } from "@shared";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { createContext, useContext, useMemo, useState } from "react";
import { PageLayout } from "@/components/page-layout";

const TABS = [
  { label: "Costs", href: "/llm/costs" },
  { label: "Limits", href: "/llm/limits" },
  { label: "Optimization Rules", href: "/llm/optimization-rules" },
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
        <Link
          href="/llm/providers/models"
          className="text-primary hover:underline"
        >
          Model Settings
        </Link>
        . Check{" "}
        <a
          href={getDocsUrl(DocsPage.PlatformObservability)}
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary hover:underline"
        >
          Prometheus metrics capabilities
        </a>{" "}
        to get cost-related insights at scale.
      </>
    ),
  },
  "/llm/limits": {
    title: "Limits",
    description:
      "Control LLM spend with scoped limits for teams and the organization.",
  },
  "/llm/optimization-rules": {
    title: "Optimization Rules",
    description:
      "Route requests to lower-cost models based on provider, model, and request conditions.",
  },
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

  const config = PAGE_CONFIG[pathname] ?? {
    title: "Costs & Limits",
    description: "Monitor and manage AI model usage costs.",
  };

  const contextValue = useMemo(() => ({ setActionButton }), []);

  return (
    <CostsLayoutContext.Provider value={contextValue}>
      <PageLayout
        title={config.title}
        description={config.description}
        tabs={TABS}
        actionButton={actionButton}
      >
        {children}
      </PageLayout>
    </CostsLayoutContext.Provider>
  );
}
