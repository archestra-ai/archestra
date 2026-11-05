"use client";

import { ErrorBoundary } from "@/components/error-boundary";

export default function AgentsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <ErrorBoundary>{children}</ErrorBoundary>;
}
