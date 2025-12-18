import { Suspense } from "react";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { AuthPageWithInvitationCheck } from "@/app/auth/[path]/auth-page-with-invitation-check";
import { LoadingSpinner } from "@/components/loading";

export const dynamicParams = false;

// Define all supported auth paths
const authPaths = [
  "sign-in",
  "sign-up",
  "forgot-password",
  "reset-password",
  "verify-email",
] as const;

export function generateStaticParams() {
  return authPaths.map((path) => ({ path }));
}

export default async function AuthPage({
  params,
}: {
  params: Promise<{ path: string }>;
}) {
  const { path } = await params;

  return (
    <ErrorBoundary>
      <Suspense fallback={<LoadingSpinner />}>
        <AuthPageWithInvitationCheck path={path} />
      </Suspense>
    </ErrorBoundary>
  );
}
