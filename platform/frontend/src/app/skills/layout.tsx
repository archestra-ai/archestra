"use client";

import { ErrorBoundary } from "@/app/_parts/error-boundary";

export default function SkillsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <ErrorBoundary>{children}</ErrorBoundary>;
}
