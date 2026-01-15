"use client";

import { Suspense } from "react";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { LoadingSpinner } from "@/components/loading";
import config from "@/lib/config";

const { RolesList } = config.enterpriseLicenseActivated
  ? // biome-ignore lint/style/noRestrictedImports: conditional ee component with roles
    await import("@/components/roles/roles-list.ee")
  : await import("@/components/roles/roles-list");

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
