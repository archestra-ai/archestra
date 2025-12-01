"use client";

import { Suspense } from "react";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { LoadingSpinner } from "@/components/loading";
import { RolesList } from "@/components/roles/roles-list";

function RolesSettingsContent() {
  return <RolesList />;
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
