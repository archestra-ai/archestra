"use client";

import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { PermissivePolicyBar } from "@/components/permissive-policy-bar";

export default function AgentsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <ErrorBoundary>
      <PermissivePolicyBar />
      {children}
    </ErrorBoundary>
  );
}
