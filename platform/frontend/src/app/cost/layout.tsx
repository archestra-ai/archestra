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
        { label: "Statistics", href: "/cost/statistics" },
        { label: "Limits", href: "/cost/limits" },
        { label: "Token Price", href: "/cost/token-price" },
        { label: "Optimization Rules", href: "/cost/optimization-rules" },
        { label: "Tool Results Compression", href: "/cost/compression" },
      ]}
    >
      {children}
    </PageLayout>
  );
}
