"use client";

import * as Sentry from "@sentry/nextjs";
import { QueryErrorResetBoundary } from "@tanstack/react-query";
import type { ComponentProps } from "react";
import {
  type FallbackProps,
  ErrorBoundary as ReactErrorBoundary,
} from "react-error-boundary";
import { ClientErrorFallback } from "@/components/error-fallback";

function DefaultFallbackComponent({
  error,
  resetErrorBoundary,
}: FallbackProps) {
  const errorMessage =
    error instanceof Error ? error.message : "An unknown error occurred";
  const errorStack = error instanceof Error ? error.stack : undefined;
  return (
    <ClientErrorFallback
      error={{ message: errorMessage, stack: errorStack }}
      resetErrorBoundary={resetErrorBoundary}
    />
  );
}

export function ErrorBoundary({
  children,
  FallbackComponent = DefaultFallbackComponent,
  onReset,
}: {
  children: React.ReactNode;
  FallbackComponent?: React.ComponentType<FallbackProps>;
  onReset?: ComponentProps<typeof ReactErrorBoundary>["onReset"];
}) {
  const onError: ComponentProps<typeof ReactErrorBoundary>["onError"] = (
    error,
    info,
  ) => {
    const capturedError =
      error instanceof Error ? error : new Error("Unknown client error");

    Sentry.captureException(capturedError, {
      extra: {
        componentStack: info.componentStack,
      },
    });
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
