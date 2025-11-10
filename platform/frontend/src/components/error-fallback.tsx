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
      <Card className="w-full max-w-2xl border-destructive">
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
          <div className="flex flex-col gap-2">
            <p className="text-sm font-medium text-muted-foreground">
              Error details:
            </p>
            <div className="h-[300px] rounded-md border bg-muted overflow-y-auto">
              <div className="p-4">
                <div className="text-sm text-destructive font-mono break-words whitespace-pre-wrap">
                  {JSON.stringify(error, null, 2)}
                  {error.request && (
                    <>
                      {"\n\nRequest:\n"}
                      {JSON.stringify(error.request, null, 2)}
                    </>
                  )}
                  {error.stack && (
                    <>
                      {"\n\nStack trace:\n"}
                      {error.stack}
                    </>
                  )}
                </div>
              </div>
            </div>
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
