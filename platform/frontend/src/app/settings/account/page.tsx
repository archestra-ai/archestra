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
    <div className="mx-auto max-w-7xl px-4 py-6 md:px-8 w-full">
      <SecuritySettingsCards
        classNames={{
          cards: "w-full",
          card: {
            base: "w-full",
          },
        }}
      />
      <ApiKeysCard
        classNames={{
          base: "w-full",
        }}
      />
      <DeleteAccountCard
        classNames={{
          base: "w-full",
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
