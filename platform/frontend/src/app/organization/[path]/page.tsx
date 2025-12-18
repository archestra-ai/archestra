import { Suspense } from "react";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { LoadingSpinner } from "@/components/loading";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export const dynamicParams = false;

// Supported organization paths (will need custom implementation)
const organizationPaths = ["settings"] as const;

export function generateStaticParams() {
  return organizationPaths.map((path) => ({ path }));
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
          <Card>
            <CardHeader>
              <CardTitle>Organization - {path}</CardTitle>
              <CardDescription>
                This page needs custom implementation
              </CardDescription>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">
                The organization management UI from better-auth-ui has been
                removed. This page will be implemented with custom components.
              </p>
            </CardContent>
          </Card>
        </main>
      </Suspense>
    </ErrorBoundary>
  );
}
