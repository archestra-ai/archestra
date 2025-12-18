"use client";

import { Suspense } from "react";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { ApiKeysCard, TwoFactorCard } from "@/components/auth";
import { LoadingSpinner } from "@/components/loading";

function AccountSettingsContent() {
  return (
    <div className="space-y-6">
      <ApiKeysCard />
      <TwoFactorCard />
    </div>
  );
}

export default function AccountSettingsPage() {
  return (
    <ErrorBoundary>
      <Suspense fallback={<LoadingSpinner />}>
        <AccountSettingsContent />
      </Suspense>
    </ErrorBoundary>
  );
}
