"use client";

import { useParams } from "next/navigation";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { ServiceAccountEditPage } from "../../_parts/service-account-edit-page";

export default function EditServiceAccountPage() {
  const { id } = useParams<{ id: string }>();
  return (
    <ErrorBoundary>
      <ServiceAccountEditPage serviceAccountId={id} />
    </ErrorBoundary>
  );
}
