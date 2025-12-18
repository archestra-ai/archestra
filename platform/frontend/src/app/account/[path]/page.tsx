import { Suspense } from "react";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { AccountProfileCard } from "@/components/auth";
import { LoadingSpinner } from "@/components/loading";

export const dynamicParams = false;

// Supported account paths
const accountPaths = ["profile"] as const;

export function generateStaticParams() {
  return accountPaths.map((path) => ({ path }));
}

export default async function AccountPage({
  params,
}: {
  params: Promise<{ path: string }>;
}) {
  const { path } = await params;

  return (
    <main className="container p-4 md:p-6">
      <ErrorBoundary>
        <Suspense fallback={<LoadingSpinner />}>
          {path === "profile" && <AccountProfileCard />}
        </Suspense>
      </ErrorBoundary>
    </main>
  );
}
