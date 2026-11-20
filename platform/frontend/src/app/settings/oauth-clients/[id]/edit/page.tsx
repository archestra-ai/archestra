"use client";

import { useParams } from "next/navigation";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { OAuthClientEditPage } from "../../_parts/oauth-client-edit-page";

export default function EditOauthClientPage() {
  const { id } = useParams<{ id: string }>();
  return (
    <ErrorBoundary>
      <OAuthClientEditPage oauthClientId={id} />
    </ErrorBoundary>
  );
}
