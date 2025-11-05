"use client";

import { Suspense } from "react";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { LoadingSpinner } from "@/components/loading";
import { RolesList } from "@/components/roles/roles-list";

function RolesSettingsContent() {
  return (
    <div className="mx-auto max-w-7xl px-4 py-6 md:px-8 w-full">
      <RolesList />
    </div>
  );
}

export default function RolesSettingsPage() {
  return (
    <ErrorBoundary>
      <Suspense fallback={<LoadingSpinner />}>
        <RolesSettingsContent />
      </Suspense>
    </ErrorBoundary>
  );
}
