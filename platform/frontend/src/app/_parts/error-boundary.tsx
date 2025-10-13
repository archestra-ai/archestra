"use client";

import { QueryErrorResetBoundary } from "@tanstack/react-query";
import { AlertCircle } from "lucide-react";
import type { ComponentProps, ComponentType } from "react";
import { ErrorBoundary as ReactErrorBoundary } from "react-error-boundary";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

type FallbackProps = {
  error: Error;
  resetErrorBoundary: () => void;
};

function DefaultFallbackComponent({
  error,
  resetErrorBoundary,
}: FallbackProps) {
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
          </div>
        </CardContent>
        <CardFooter>
          <Button onClick={resetErrorBoundary} className="w-full">
            Try again
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}

export function ErrorBoundary({
  children,
  FallbackComponent = DefaultFallbackComponent,
  onReset,
}: {
  children: React.ReactNode;
  FallbackComponent?: ComponentType<FallbackProps>;
  onReset?: ComponentProps<typeof ReactErrorBoundary>["onReset"];
}) {
  const onError = (_error: Error) => {
    // we can do sth else with the error here
  };

  return (
    <QueryErrorResetBoundary>
      {({ reset }) => (
        <ReactErrorBoundary
          FallbackComponent={FallbackComponent}
          onError={onError}
          onReset={(details) => {
            reset();
            onReset?.(details);
          }}
        >
          {children}
        </ReactErrorBoundary>
      )}
    </QueryErrorResetBoundary>
  );
}
