"use client";

import { usePathname } from "next/navigation";
import { createContext, useContext, useMemo, useState } from "react";
import { PageLayout } from "@/components/page-layout";

const TABS = [
  {
    label: "Virtual Keys",
    href: "/llm/proxy-auth/virtual-keys",
  },
  {
    label: "OAuth Clients",
    href: "/llm/proxy-auth/oauth-clients",
  },
];

const PAGE_CONFIG: Record<string, { title: string; description: string }> = {
  "/llm/proxy-auth/virtual-keys": {
    title: "Virtual Keys",
    description:
      "Virtual keys let OpenAI-compatible clients use the LLM Proxy without exposing real provider keys",
  },
  "/llm/proxy-auth/oauth-clients": {
    title: "OAuth Clients",
    description:
      "Register backend services and bots that authenticate to the Model Router with OAuth client credentials",
  },
};

type ProxyAuthLayoutContextType = {
  setActionButton: (button: React.ReactNode) => void;
};

const ProxyAuthLayoutContext = createContext<ProxyAuthLayoutContextType>({
  setActionButton: () => {},
});

export function useSetProxyAuthAction() {
  return useContext(ProxyAuthLayoutContext).setActionButton;
}

export default function ProxyAuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const [actionButton, setActionButton] = useState<React.ReactNode>(null);

  const config = PAGE_CONFIG[pathname] ?? {
    title: "Proxy Auth",
    description: "",
  };

  const contextValue = useMemo(() => ({ setActionButton }), []);

  return (
    <ProxyAuthLayoutContext.Provider value={contextValue}>
      <PageLayout
        title={config.title}
        description={config.description}
        tabs={TABS}
        actionButton={actionButton}
      >
        {children}
      </PageLayout>
    </ProxyAuthLayoutContext.Provider>
  );
}
