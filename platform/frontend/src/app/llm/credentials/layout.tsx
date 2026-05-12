"use client";

import { usePathname } from "next/navigation";
import { createContext, useContext, useMemo, useState } from "react";
import { PageLayout } from "@/components/page-layout";

const TABS = [
  {
    label: "Virtual Keys",
    href: "/llm/credentials/virtual-keys",
  },
  {
    label: "OAuth Clients",
    href: "/llm/credentials/oauth-clients",
  },
];

const PAGE_CONFIG: Record<string, { title: string; description: string }> = {
  "/llm/credentials/virtual-keys": {
    title: "Virtual Keys",
    description:
      "Virtual keys let OpenAI-compatible clients use the LLM Proxy without exposing real provider keys",
  },
  "/llm/credentials/oauth-clients": {
    title: "OAuth Clients",
    description:
      "Register backend services and bots that authenticate to the Model Router with OAuth client credentials",
  },
};

type CredentialsLayoutContextType = {
  setActionButton: (button: React.ReactNode) => void;
};

const CredentialsLayoutContext = createContext<CredentialsLayoutContextType>({
  setActionButton: () => {},
});

export function useSetCredentialsAction() {
  return useContext(CredentialsLayoutContext).setActionButton;
}

export default function CredentialsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const [actionButton, setActionButton] = useState<React.ReactNode>(null);

  const config = PAGE_CONFIG[pathname] ?? {
    title: "Credentials",
    description: "",
  };

  const contextValue = useMemo(() => ({ setActionButton }), []);

  return (
    <CredentialsLayoutContext.Provider value={contextValue}>
      <PageLayout
        title={config.title}
        description={config.description}
        tabs={TABS}
        actionButton={actionButton}
      >
        {children}
      </PageLayout>
    </CredentialsLayoutContext.Provider>
  );
}
