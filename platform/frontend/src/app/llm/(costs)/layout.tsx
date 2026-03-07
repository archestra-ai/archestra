"use client";

import { PageLayout } from "@/components/page-layout";

export default function CostsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <PageLayout
      title="Costs & Limits"
      description="Monitor and manage your AI model usage costs across all profiles and teams."
      tabs={[
        { label: "Statistics", href: "/llm/costs" },
        { label: "Limits", href: "/llm/limits" },
        { label: "Optimization Rules", href: "/llm/optimization-rules" },
      ]}
    >
      {children}
    </PageLayout>
  );
}
