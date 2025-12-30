"use client";

import { ApiKeysCard, SecuritySettingsCards } from "@daveyplate/better-auth-ui";
import { Suspense } from "react";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { LoadingSpinner } from "@/components/loading";
import { PersonalTokenCard } from "@/components/settings/personal-token-card";

function AccountSettingsContent() {
  return (
    <div className="space-y-6">
      <PersonalTokenCard />
      <ApiKeysCard
        classNames={{
          base: "w-full",
        }}
      />
      <SecuritySettingsCards
        classNames={{
          cards: "w-full",
          card: {
            base: "w-full",
          },
        }}
      />
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
