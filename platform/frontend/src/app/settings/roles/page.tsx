"use client";

import { ErrorBoundary } from "@/app/_parts/error-boundary";
import config from "@/lib/config";

const { RolesList } = config.enterpriseFeatures.core
  ? // biome-ignore lint/style/noRestrictedImports: conditional ee component with roles
    await import("@/components/roles/roles-list.ee")
  : await import("@/components/roles/roles-list");

export default function RolesSettingsPage() {
  return (
    <ErrorBoundary>
      <RolesList />
    </ErrorBoundary>
  );
}
