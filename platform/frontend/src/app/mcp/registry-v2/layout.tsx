"use client";

import { PageLayout } from "@/components/page-layout";
import { SpikeStoreProvider } from "./_seed/store";

const tabs = [
  { href: "/mcp/registry-v2", label: "Catalog" },
  { href: "/mcp/registry-v2/environments", label: "Environments" },
  { href: "/mcp/registry-v2/fields", label: "Fields" },
];

export default function RegistryV2Layout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <SpikeStoreProvider>
      <PageLayout
        title={
          <span className="flex items-center gap-2">
            MCP Registry
            <span className="text-sm font-normal text-muted-foreground">
              v2 spike
            </span>
          </span>
        }
        description="Frontend-only spike. Mock data, no real backend. Explore the proposed catalog → environment → install model."
        tabs={tabs}
      >
        {children}
      </PageLayout>
    </SpikeStoreProvider>
  );
}
