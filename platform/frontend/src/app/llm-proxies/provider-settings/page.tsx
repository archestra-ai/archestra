"use client";

import { useSearchParams } from "next/navigation";
import { PageLayout } from "@/components/page-layout";
import { ProviderSettingsApiKeys } from "./provider-settings-api-keys";
import { ProviderSettingsModels } from "./provider-settings-models";
import { ProviderSettingsVirtualKeys } from "./provider-settings-virtual-keys";

const TABS = [
  {
    label: "API Keys",
    href: "/llm-proxies/provider-settings",
  },
  {
    label: "Virtual API Keys",
    href: "/llm-proxies/provider-settings?tab=virtual-keys",
  },
  {
    label: "Models",
    href: "/llm-proxies/provider-settings?tab=models",
  },
];

export default function ProviderSettingsPage() {
  const searchParams = useSearchParams();
  const tab = searchParams.get("tab");

  return (
    <PageLayout
      title="Provider Settings"
      description="Manage LLM provider API keys, virtual keys, and available models"
      tabs={TABS}
    >
      {tab === "virtual-keys" ? (
        <ProviderSettingsVirtualKeys />
      ) : tab === "models" ? (
        <ProviderSettingsModels />
      ) : (
        <ProviderSettingsApiKeys />
      )}
    </PageLayout>
  );
}
