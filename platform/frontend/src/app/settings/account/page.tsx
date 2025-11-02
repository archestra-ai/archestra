"use client";

import {
  ApiKeysCard,
  DeleteAccountCard,
  SecuritySettingsCards,
} from "@daveyplate/better-auth-ui";
import { Suspense } from "react";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { LoadingSpinner } from "@/components/loading";

function AccountSettingsContent() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-6 md:px-8">
      <div className="space-y-6">
        <SecuritySettingsCards />
        <ApiKeysCard />
        <DeleteAccountCard />
      </div>
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
