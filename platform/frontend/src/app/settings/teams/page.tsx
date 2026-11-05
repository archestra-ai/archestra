"use client";

import { ErrorBoundary } from "@/components/error-boundary";
import { TeamsList } from "@/components/teams/teams-list";

export default function TeamsSettingsPage() {
  return (
    <ErrorBoundary>
      <TeamsList />
    </ErrorBoundary>
  );
}
