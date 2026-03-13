"use client";

import { PageLayout } from "@/components/page-layout";

const TABS = [
  {
    label: "API Keys",
    href: "/llm/providers/api-keys",
  },
  {
    label: "Virtual API Keys",
    href: "/llm/providers/virtual-keys",
  },
  {
    label: "Models",
    href: "/llm/providers/models",
  },
];

export default function ProviderSettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <PageLayout
      title="Provider Settings"
      description="Manage LLM provider API keys, virtual keys, and available models"
      tabs={TABS}
    >
      {children}
    </PageLayout>
  );
}
