"use client";

import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { useFeature } from "@/lib/config/config.query";
import { useMcpInstallationStatusCacheSync } from "@/lib/mcp/mcp-server.query";

export default function SkillsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const mcpSkillsEnabled = useFeature("mcpGatewaySkillsEnabled") === true;
  useMcpInstallationStatusCacheSync(mcpSkillsEnabled);
  return <ErrorBoundary>{children}</ErrorBoundary>;
}
