import { Suspense } from "react";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { AuthPageWithInvitationCheck } from "@/app/auth/[path]/auth-page-with-invitation-check";
import { LoadingSpinner } from "@/components/loading";

export const dynamicParams = false;

/**
 * Auth views served by this dynamic route. Flows without backend support
 * (forgot/reset password, magic link, email OTP) intentionally have no route
 * and 404. Sign-up with an invitation lives at /auth/sign-up-with-invitation.
 */
const AUTH_VIEW_PATHS = [
  "sign-in",
  "sign-out",
  "sign-up",
  "two-factor",
  "recover-account",
] as const;

export function generateStaticParams() {
  return AUTH_VIEW_PATHS.map((path) => ({ path }));
}

export default async function AuthPage({
  params,
}: {
  params: Promise<{ path: string }>;
}) {
  const { path } = await params;

  return (
    <ErrorBoundary>
      <Suspense
        fallback={<LoadingSpinner className="top-1/2 left-1/2 absolute" />}
      >
        <AuthPageWithInvitationCheck path={path} />
      </Suspense>
    </ErrorBoundary>
  );
}
