import type { ErrorExtended } from "@shared";
import { AlertCircle } from "lucide-react";
import { Button } from "./ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "./ui/card";

export function ClientErrorFallback({
  error,
  resetErrorBoundary,
}: {
  error: ErrorExtended;
  resetErrorBoundary?: () => void;
}) {
  return (
    <div className="flex min-h-[400px] items-center justify-center p-4">
      <Card className="w-full max-w-md border-destructive">
        <CardHeader>
          <div className="flex items-center gap-2">
            <AlertCircle className="size-5 text-destructive" />
            <CardTitle>Something went wrong</CardTitle>
          </div>
          <CardDescription>
            An unexpected error occurred. Please try again.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="rounded-md bg-muted p-4">
            <p className="text-sm font-medium text-muted-foreground">
              Error details:
            </p>
            <p className="mt-2 text-sm text-destructive font-mono break-words">
              {error.message}
            </p>
            {error.request && (
              <p className="mt-2 text-sm text-destructive font-mono break-words">
                {JSON.stringify(error.request)}
              </p>
            )}
            {error.stack && (
              <p className="mt-2 text-sm text-destructive font-mono break-words">
                {error.stack}
              </p>
            )}
          </div>
        </CardContent>
        {resetErrorBoundary && (
          <CardFooter>
            <Button onClick={resetErrorBoundary} className="w-full">
              Try again
            </Button>
          </CardFooter>
        )}
      </Card>
    </div>
  );
}

export function ServerErrorFallback({ error }: { error: ErrorExtended }) {
  return <ClientErrorFallback error={error} />;
}
