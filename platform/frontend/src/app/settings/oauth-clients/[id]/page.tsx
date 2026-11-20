"use client";

import { useParams } from "next/navigation";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { OAuthClientDetailPage } from "../_parts/oauth-client-detail-page";

export default function OauthClientPage() {
  const { id } = useParams<{ id: string }>();
  return (
    <ErrorBoundary>
      <OAuthClientDetailPage oauthClientId={id} />
    </ErrorBoundary>
  );
}
