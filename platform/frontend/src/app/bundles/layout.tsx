"use client";

import { PageLayout } from "@/components/page-layout";
import { useFeature } from "@/lib/config/config.query";

export default function BundlesLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const enabled = useFeature("bundles");

  if (enabled === undefined) return null;

  if (!enabled) {
    return (
      <PageLayout
        title="Bundles"
        description="Bundles are disabled for this deployment."
      >
        <div />
      </PageLayout>
    );
  }

  return children;
}
