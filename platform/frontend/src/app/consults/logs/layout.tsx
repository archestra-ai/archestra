"use client";

import { LogsSectionLayout } from "@/app/_parts/logs-section-layout";

export default function ConsultLogsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <LogsSectionLayout listPath="/consults/logs">{children}</LogsSectionLayout>
  );
}
