"use client";

import { Suspense } from "react";
import { LogsPage } from "./_parts/logs-page";

export default function LogsPageClient() {
  return (
    <Suspense>
      <LogsPage />
    </Suspense>
  );
}
