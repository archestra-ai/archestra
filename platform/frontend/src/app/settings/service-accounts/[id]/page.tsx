"use client";

import { useParams } from "next/navigation";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { ServiceAccountDetailPage } from "../_parts/service-account-detail-page";

export default function ServiceAccountPage() {
  const { id } = useParams<{ id: string }>();
  return (
    <ErrorBoundary>
      <ServiceAccountDetailPage serviceAccountId={id} />
    </ErrorBoundary>
  );
}
