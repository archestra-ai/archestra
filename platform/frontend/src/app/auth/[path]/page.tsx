import { AuthView } from "@daveyplate/better-auth-ui";
import { authViewPaths } from "@daveyplate/better-auth-ui/server";
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

export function generateStaticParams() {
  return Object.values(authViewPaths).map((path) => ({ path }));
}

export default async function AuthPage({
  params,
}: {
  params: Promise<{ path: string }>;
}) {
  const { path } = await params;

  // Block direct sign-up - users must use invitation links
  if (path === "sign-up") {
    return (
      <ErrorBoundary>
        <Suspense fallback={<LoadingSpinner />}>
          <main className="container flex grow flex-col items-center justify-center self-center p-4 md:p-6 h-full">
            <Card className="max-w-md w-full">
              <CardHeader>
                <CardTitle>Invitation Required</CardTitle>
                <CardDescription>
                  Direct sign-up is disabled. You need an invitation to create
                  an account.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="text-sm text-muted-foreground">
                  Please contact an administrator to get an invitation link.
                  Once you have an invitation link, you'll be able to create
                  your account.
                </p>
                <div className="flex gap-2">
                  <a
                    href="/auth/sign-in"
                    className="inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50 disabled:pointer-events-none ring-offset-background bg-primary text-primary-foreground hover:bg-primary/90 h-10 py-2 px-4 flex-1"
                  >
                    Sign In
                  </a>
                  <a
                    href="/"
                    className="inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50 disabled:pointer-events-none ring-offset-background border border-input hover:bg-accent hover:text-accent-foreground h-10 py-2 px-4 flex-1"
                  >
                    Go Home
                  </a>
                </div>
              </CardContent>
            </Card>
          </main>
        </Suspense>
      </ErrorBoundary>
    );
  }

  return (
    <ErrorBoundary>
      <Suspense fallback={<LoadingSpinner />}>
        <main className="container flex grow flex-col items-center justify-center self-center p-4 md:p-6 h-full">
          <AuthView path={path} classNames={{ footer: "hidden" }} />
        </main>
      </Suspense>
    </ErrorBoundary>
  );
}
