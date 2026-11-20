"use client";

import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { OAuthClientCreatePage } from "../_parts/oauth-client-create-page";

export default function NewOauthClientPage() {
  return (
    <ErrorBoundary>
      <OAuthClientCreatePage />
    </ErrorBoundary>
  );
}
