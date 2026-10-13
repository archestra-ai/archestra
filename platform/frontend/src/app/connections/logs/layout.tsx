"use client";

import { LogsSectionLayout } from "@/app/_parts/logs-section-layout";

export default function ConnectionLogsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <LogsSectionLayout listPath="/connections/logs">
      {children}
    </LogsSectionLayout>
  );
}
