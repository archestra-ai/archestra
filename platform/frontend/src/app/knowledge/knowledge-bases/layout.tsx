"use client";

import { ErrorBoundary } from "@/components/error-boundary";

export default function KnowledgeBasesLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <ErrorBoundary>{children}</ErrorBoundary>;
}
