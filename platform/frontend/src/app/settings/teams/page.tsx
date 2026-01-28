"use client";

import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { TeamsList } from "@/components/teams/teams-list";

export default function TeamsSettingsPage() {
  return (
    <ErrorBoundary>
      <TeamsList />
    </ErrorBoundary>
  );
}
