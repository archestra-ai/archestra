import { OrganizationView } from "@daveyplate/better-auth-ui";
import { organizationViewPaths } from "@daveyplate/better-auth-ui/server";
import { Suspense } from "react";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { LoadingSpinner } from "@/components/loading";

export const dynamicParams = false;

export function generateStaticParams() {
  return Object.values(organizationViewPaths).map((path) => ({ path }));
}

export default async function OrganizationPage({
  params,
}: {
  params: Promise<{ path: string }>;
}) {
  const { path } = await params;

  return (
    <ErrorBoundary>
      <Suspense fallback={<LoadingSpinner />}>
        <main className="container p-4 md:p-6">
          <OrganizationView path={path} />
        </main>
      </Suspense>
    </ErrorBoundary>
  );
}
