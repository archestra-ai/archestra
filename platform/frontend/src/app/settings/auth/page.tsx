"use client";

import {
  ApiKeysCard,
  ChangePasswordCard,
  SessionsCard,
  TwoFactorCard,
} from "@daveyplate/better-auth-ui";
import { Suspense } from "react";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { LoadingSpinner } from "@/components/loading";
import { PersonalTokenCard } from "@/components/settings/personal-token-card";

function AuthSettingsContent() {
  return (
    <div className="space-y-6">
      <PersonalTokenCard />
      <ApiKeysCard classNames={{ base: "w-full" }} />
      <ChangePasswordCard classNames={{ base: "w-full" }} />
      <TwoFactorCard classNames={{ base: "w-full" }} />
      <SessionsCard classNames={{ base: "w-full" }} />
    </div>
  );
}

export default function AuthSettingsPage() {
  return (
    <ErrorBoundary>
      <Suspense fallback={<LoadingSpinner />}>
        <AuthSettingsContent />
      </Suspense>
    </ErrorBoundary>
  );
}
