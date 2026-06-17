"use client";

import { usePathname } from "next/navigation";
import { createContext, useContext, useMemo, useState } from "react";
import { PageLayout } from "@/components/page-layout";

const TABS = [
  {
    label: "OAuth Clients",
    href: "/mcp/credentials/oauth-clients",
  },
];

const PAGE_CONFIG: Record<string, { title: string; description: string }> = {
  "/mcp/credentials/oauth-clients": {
    title: "OAuth Clients",
    description:
      "Register applications that authenticate to MCP gateways with OAuth client credentials",
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
