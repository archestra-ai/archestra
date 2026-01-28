import { authViewPaths } from "@daveyplate/better-auth-ui/server";
import { Suspense } from "react";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { AuthPageWithInvitationCheck } from "@/app/auth/[path]/auth-page-with-invitation-check";
import { LoadingSpinner } from "@/components/loading";

export const dynamicParams = false;

export function generateStaticParams() {
  return Object.values(authViewPaths).map((path) => ({ path }));
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
