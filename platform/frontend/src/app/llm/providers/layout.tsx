"use client";

import { usePathname } from "next/navigation";
import { createContext, useContext, useMemo, useState } from "react";
import { PageLayout } from "@/components/page-layout";

const TABS = [
  {
    label: "API Keys",
    href: "/llm/providers/api-keys",
  },
  {
    label: "Virtual Keys",
    href: "/llm/providers/virtual-keys",
  },
  {
    label: "Models",
    href: "/llm/providers/models",
  },
];

const PAGE_CONFIG: Record<string, { title: string; description: string }> = {
  "/llm/providers/api-keys": {
    title: "API Keys",
    description: "Manage API keys for LLM providers used in Chat and LLM Proxy",
  },
  "/llm/providers/virtual-keys": {
    title: "Virtual Keys",
    description:
      "Virtual keys let external clients use your provider keys via the LLM Proxy without exposing the real API key",
  },
  "/llm/providers/models": {
    title: "Models",
    description:
      'Models available from your configured API keys. Use "Refresh Models" to re-fetch models and capabilities from providers.',
  },
};

type ProviderLayoutContextType = {
  setActionButton: (button: React.ReactNode) => void;
};

const ProviderLayoutContext = createContext<ProviderLayoutContextType>({
  setActionButton: () => {},
});

export function useSetProviderAction() {
  return useContext(ProviderLayoutContext).setActionButton;
}

export default function ProviderSettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const [actionButton, setActionButton] = useState<React.ReactNode>(null);

  const config = PAGE_CONFIG[pathname] ?? {
    title: "Providers",
    description: "",
  };

  const contextValue = useMemo(() => ({ setActionButton }), []);

  return (
    <ProviderLayoutContext.Provider value={contextValue}>
      <PageLayout
        title={config.title}
        description={config.description}
        tabs={TABS}
        actionButton={actionButton}
      >
        {children}
      </PageLayout>
    </ProviderLayoutContext.Provider>
  );
}
