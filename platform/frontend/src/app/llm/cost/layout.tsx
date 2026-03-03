"use client";

import { PageLayout } from "@/components/page-layout";

export default function CostLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <PageLayout
      title="Cost & Limits"
      description="Monitor and manage your AI model usage costs across all profiles and teams."
      tabs={[
        { label: "Statistics", href: "/llm/cost/statistics" },
        { label: "Limits", href: "/llm/cost/limits" },
        { label: "Optimization Rules", href: "/llm/cost/optimization-rules" },
        { label: "Tool Results Compression", href: "/llm/cost/compression" },
      ]}
    >
      {children}
    </PageLayout>
  );
}
