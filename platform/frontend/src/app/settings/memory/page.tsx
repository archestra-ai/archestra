"use client";

import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { MemoryList } from "./_parts/memory-list";

export default function MemorySettingsPage() {
  return (
    <ErrorBoundary>
      <MemoryList />
    </ErrorBoundary>
  );
}
