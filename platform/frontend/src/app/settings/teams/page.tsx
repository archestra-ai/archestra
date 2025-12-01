"use client";

import { Suspense } from "react";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { LoadingSpinner } from "@/components/loading";
import { TeamsList } from "@/components/teams/teams-list";

function TeamsSettingsContent() {
  return <TeamsList />;
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
