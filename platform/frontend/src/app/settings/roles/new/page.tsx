"use client";

import dynamic from "next/dynamic";
import { ErrorBoundary } from "@/app/_parts/error-boundary";

const RoleCreatePage = dynamic(() =>
  // biome-ignore lint/style/noRestrictedImports: dual-licensed at request time
  import("@/components/roles/role-create-page.ee").then((m) => ({
    default: m.RoleCreatePage,
  })),
);

export default function NewRolePage() {
  return (
    <ErrorBoundary>
      <RoleCreatePage />
    </ErrorBoundary>
  );
}
