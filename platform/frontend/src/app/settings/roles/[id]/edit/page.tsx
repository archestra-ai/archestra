"use client";

import dynamic from "next/dynamic";
import { useParams } from "next/navigation";
import { ErrorBoundary } from "@/app/_parts/error-boundary";

const RoleEditPage = dynamic(() =>
  // biome-ignore lint/style/noRestrictedImports: dual-licensed at request time
  import("@/components/roles/role-edit-page.ee").then((m) => ({
    default: m.RoleEditPage,
  })),
);

export default function EditRolePage() {
  const { id } = useParams<{ id: string }>();
  return (
    <ErrorBoundary>
      <RoleEditPage roleId={id} />
    </ErrorBoundary>
  );
}
