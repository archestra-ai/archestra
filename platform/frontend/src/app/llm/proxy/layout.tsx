"use client";

import { usePathname } from "next/navigation";
import { useMemo, useState } from "react";
import { LlmProxyLayoutContext } from "@/app/llm/proxy/_parts/llm-proxy-action-context";
import { PageLayout } from "@/components/page-layout";
import { useLlmProviderApiKeys } from "@/lib/llm-provider-api-keys.query";
import { useAllVirtualApiKeys } from "@/lib/virtual-api-keys.query";

const PAGE_CONFIG: Record<string, { title: string; description?: string }> = {
  "/llm/proxy": {
    title: "LLM Proxy",
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
  const isDashboard = pathname === "/llm/proxy";
  const setupHint = useSetupHint(isDashboard);

  const config = PAGE_CONFIG[pathname] ?? PAGE_CONFIG["/llm/proxy"];

  const contextValue = useMemo(() => ({ setActionButton }), []);

  return (
    <LlmProxyLayoutContext.Provider value={contextValue}>
      <PageLayout
        title={config.title}
        description={isDashboard ? setupHint : config.description}
        actionButton={actionButton}
      >
        {children}
      </PageLayout>
    </LlmProxyLayoutContext.Provider>
  );
}

/**
 * The dashboard's subtitle while the two required pieces are missing: a
 * provider key and a virtual key. Once both exist it has none.
 */
function useSetupHint(enabled: boolean) {
  const { data: providerKeys, isPending: providerKeysPending } =
    useLlmProviderApiKeys({ enabled });
  const { data: keys, isPending: keysPending } = useAllVirtualApiKeys({
    keyType: "standard",
    limit: 1,
    offset: 0,
    enabled,
    toastOnError: false,
  });
  if (!enabled || providerKeysPending || keysPending) return undefined;
  const setUp =
    (providerKeys?.length ?? 0) > 0 && (keys?.pagination.total ?? 0) > 0;
  return setUp
    ? undefined
    : "Two things to set up: a provider and a virtual key. Then point your app at the endpoint below.";
}
