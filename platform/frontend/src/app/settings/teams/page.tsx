"use client";

import { Suspense } from "react";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { LoadingSpinner } from "@/components/loading";
import { TeamsList } from "@/components/teams/teams-list";

function TeamsSettingsContent() {
  return (
    <div className="mx-auto max-w-7xl px-4 py-6 md:px-8 w-full">
      <TeamsList />
    </div>
  );
}

export default function TeamsSettingsPage() {
  return (
    <ErrorBoundary>
      <Suspense fallback={<LoadingSpinner />}>
        <TeamsSettingsContent />
      </Suspense>
    </ErrorBoundary>
  );
}
