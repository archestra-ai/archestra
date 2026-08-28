"use client";

import { usePathname } from "next/navigation";
import { useMemo, useState } from "react";
import { LlmProxyLayoutContext } from "@/app/llm/proxy/_parts/llm-proxy-action-context";
import { ExternalDocsLink } from "@/components/external-docs-link";
import { PageLayout } from "@/components/page-layout";
import { getFrontendDocsUrl } from "@/lib/docs/docs";

const PAGE_CONFIG: Record<string, { title: string; description: string }> = {
  "/llm/proxy": {
    title: "LLM Proxy",
    description:
      "One endpoint for your LLM API calls, with security, observability, and cost management.",
  },
  "/llm/proxy/virtual-keys": {
    title: "Virtual Keys",
    description:
      "Two kinds of keys. Standard virtual keys authenticate your apps through your provider keys; passthrough virtual keys grant no access and only attribute bring-your-own-key requests to a user.",
  },
};

export default function LlmProxyLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const [actionButton, setActionButton] = useState<React.ReactNode>(null);
  const docsUrl = getFrontendDocsUrl("platform-llm-proxy");

  const config = PAGE_CONFIG[pathname] ?? PAGE_CONFIG["/llm/proxy"];

  const contextValue = useMemo(() => ({ setActionButton }), []);

  return (
    <LlmProxyLayoutContext.Provider value={contextValue}>
      <PageLayout
        title={config.title}
        description={
          pathname === "/llm/proxy" && docsUrl ? (
            <>
              {config.description}{" "}
              <ExternalDocsLink
                href={docsUrl}
                className="hover:underline"
                showIcon={false}
              >
                Read more in the docs
              </ExternalDocsLink>
              <span>.</span>
            </>
          ) : (
            config.description
          )
        }
        actionButton={actionButton}
      >
        {children}
      </PageLayout>
    </LlmProxyLayoutContext.Provider>
  );
}
