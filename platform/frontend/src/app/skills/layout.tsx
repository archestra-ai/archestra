"use client";

import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { useMcpInstallationStatusCacheSync } from "@/lib/mcp/mcp-server.query";

export default function SkillsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  useMcpInstallationStatusCacheSync();
  return <ErrorBoundary>{children}</ErrorBoundary>;
}
