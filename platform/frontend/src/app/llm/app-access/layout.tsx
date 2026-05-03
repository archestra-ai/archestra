"use client";

import { usePathname } from "next/navigation";
import { createContext, useContext, useMemo, useState } from "react";
import { PageLayout } from "@/components/page-layout";

const TABS = [
  {
    label: "Virtual Keys",
    href: "/llm/app-access/virtual-keys",
  },
  {
    label: "Applications",
    href: "/llm/app-access/applications",
  },
];

const PAGE_CONFIG: Record<string, { title: string; description: string }> = {
  "/llm/app-access/virtual-keys": {
    title: "Virtual Keys",
    description:
      "Virtual keys let OpenAI-compatible clients use the LLM Proxy without exposing real provider keys",
  },
  "/llm/app-access/applications": {
    title: "Applications",
    description:
      "Register backend services and bots that authenticate to the Model Router with OAuth client credentials",
  },
};

type AppAccessLayoutContextType = {
  setActionButton: (button: React.ReactNode) => void;
};

const AppAccessLayoutContext = createContext<AppAccessLayoutContextType>({
  setActionButton: () => {},
});

export function useSetAppAccessAction() {
  return useContext(AppAccessLayoutContext).setActionButton;
}

export default function AppAccessLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const [actionButton, setActionButton] = useState<React.ReactNode>(null);

  const config = PAGE_CONFIG[pathname] ?? {
    title: "App Access",
    description: "",
  };

  const contextValue = useMemo(() => ({ setActionButton }), []);

  return (
    <AppAccessLayoutContext.Provider value={contextValue}>
      <PageLayout
        title={config.title}
        description={config.description}
        tabs={TABS}
        actionButton={actionButton}
      >
        {children}
      </PageLayout>
    </AppAccessLayoutContext.Provider>
  );
}
