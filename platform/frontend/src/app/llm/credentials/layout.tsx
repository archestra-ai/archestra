"use client";

import { usePathname } from "next/navigation";
import { useMemo, useState } from "react";
import {
  CredentialsActionContext,
  useSetCredentialsAction,
} from "@/components/credentials-action-context";
import { PageLayout } from "@/components/page-layout";

// Re-exported so existing importers (`../layout`) keep working.
export { useSetCredentialsAction };

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
      "Register applications that authenticate to LLM proxies with OAuth — as an application (client credentials) or on behalf of users (authorization code)",
  },
};

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
    <CredentialsActionContext.Provider value={contextValue}>
      <PageLayout
        title={config.title}
        description={config.description}
        tabs={TABS}
        actionButton={actionButton}
      >
        {children}
      </PageLayout>
    </CredentialsActionContext.Provider>
  );
}
