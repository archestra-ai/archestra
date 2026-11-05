"use client";

import dynamic from "next/dynamic";
import { useParams } from "next/navigation";
import { ErrorBoundary } from "@/components/error-boundary";

const RoleDetailPage = dynamic(() =>
  // biome-ignore lint/style/noRestrictedImports: dual-licensed at request time
  import("@/components/roles/role-detail-page.ee").then((m) => ({
    default: m.RoleDetailPage,
  })),
);

export default function RolePage() {
  const { id } = useParams<{ id: string }>();
  return (
    <ErrorBoundary>
      <RoleDetailPage roleId={id} />
    </ErrorBoundary>
  );
}
